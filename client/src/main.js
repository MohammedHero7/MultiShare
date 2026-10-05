import '@fontsource-variable/readex-pro';
import '@fontsource/big-shoulders-display/700';
import '@fontsource/big-shoulders-display/800';
import './style.css';

import { Connection } from './connection.js';
import { clamp, formatAgo, formatTime, formatViews, joinNames } from './format.js';
import { hydrateIcons, setIcon } from './icons.js';
import { Player } from './player.js';
import { openWebsite, searchUrl, setWebToken } from './browser.js';
import { isInDiscord, startSession } from './session.js';
import { SubtitleRenderer, parseSubtitles, readSubtitleFile } from './subtitles.js';
import * as ui from './ui.js';

const { $ } = ui;

// Big Buck Bunny (CC BY 3.0, Blender Foundation): a handy test file.
const SAMPLE_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

const appEl = $('app');
const video = $('video');
const seekInput = $('seek-input');
const timeEl = $('time');

let conn = null;
let me = null;
let users = [];
let serverState = null;
let libraryEnabled = false;
let libraryFiles = null;
let subtitleEncoding = 'windows-1256';
let pendingLoad = null;
let pendingSubs = null;
let scrubbing = false;
let noticeShown = false;
let bufferingSince = 0;
let subDelay = 0;

const player = new Player(video, () => (conn ? conn.serverNow() : Date.now()), $('media-iframe'));
const subtitles = new SubtitleRenderer($('subtitles'), video);

hydrateIcons();

/* ---------- Startup ---------- */

async function boot() {
  ui.showSplash(isInDiscord ? 'Connecting to Discord…' : 'Connecting…');
  let session;
  try {
    session = await startSession();
  } catch (error) {
    ui.showSplash("Can't open the watch party", describeStartError(error), { retry: true, waiting: false });
    return;
  }

  conn = new Connection(session);
  conn
    .on('welcome', onWelcome)
    .on('state', onState)
    .on('presence', onPresence)
    .on('subs', onSubs)
    .on('library', onLibrary)
    .on('youtube', onYouTube)
    .on('error', onServerError)
    .on('fatal', (message) => ui.showSplash("Can't join the watch party", message.message, { retry: true, waiting: false }))
    .on('status', (status) => {
      ui.setStatus(status === 'reconnecting' ? 'Reconnecting…' : '');
      // A search in flight is lost with the connection.
      if (status === 'reconnecting' && youtubePending !== null) failYouTube('The connection dropped. Search again.');
    });
  conn.connect();
}

function describeStartError(error) {
  const message = error?.message || String(error);
  if (/cancel|denied|reject|closed/i.test(message)) {
    return 'The activity needs permission to show your Discord name. Reopen it and choose Authorize.';
  }
  return message;
}

/* ---------- Server events ---------- */

function onWelcome(message) {
  me = message.you;
  users = message.users;
  libraryEnabled = message.library;
  subtitleEncoding = message.encoding || subtitleEncoding;
  setWebToken(message.web);
  document.querySelector('#video-tabs [data-tab=library]').hidden = !libraryEnabled;
  $('empty-library').hidden = !libraryEnabled;
  ui.hideSplash();
  ui.renderViewers(users, me.id);
  renderPeople();
  applyState(message.state);
}

function onState(message) {
  if (serverState && message.state.seq < serverState.seq) return;
  applyState(message.state);
  if (message.action === 'load' && message.by?.id === me?.id) finishLoad();

  const by = message.by;
  if (!by || by.id === me?.id) return;
  const at = formatTime(message.state.position);
  const text = {
    load: `${by.name} loaded ${message.state.media?.title ?? 'a video'}`,
    play: message.state.position < 1 ? `${by.name} started the video` : `${by.name} resumed at ${at}`,
    pause: `${by.name} paused at ${at}`,
    seek: `${by.name} jumped to ${at}`,
  }[message.action];
  if (text) ui.toast(text);
}

function applyState(next) {
  const previousSrc = serverState?.media?.src;
  serverState = next;
  player.setState(next);

  const media = next.media;
  appEl.dataset.media = media ? 'loaded' : 'none';
  $('empty').hidden = Boolean(media);
  $('title').textContent = media?.title ?? '';
  $('title').title = media?.title ?? '';
  $('sheet-video-title').textContent = media ? 'Change video' : 'Pick a video';
  document.title = media?.title ?? 'Watch party';
  if (media?.src !== previousSrc) {
    hideNotice();
    renderSubsLibrary();
    renderSource(media);
    markCurrentYouTube();
    // YouTube videos show their thumbnail until the picture starts, like on YouTube.
    if (media?.poster) video.poster = media.poster;
    else video.removeAttribute('poster');
    if ('mediaSession' in navigator && media && typeof MediaMetadata === 'function') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: media.title,
        artist: media.channel || 'Watch party',
        artwork: media.poster ? [{ src: media.poster, type: 'image/jpeg' }] : [],
      });
    }
  }
  ui.wake();
}

/** The line under the title: where the video comes from. */
function renderSource(media) {
  $('source').hidden = !media;
  if (!media) return;
  let icon = 'link';
  let text = '';
  if (media.source === 'youtube') {
    icon = 'youtube';
    text = media.channel ? `YouTube · ${media.channel}` : 'YouTube';
  } else if (media.source === 'library') {
    icon = 'folder';
    text = 'Library';
  } else {
    try {
      text = new URL(media.link).hostname.replace(/^www\./, '');
    } catch {
      text = 'Link';
    }
  }
  setIcon($('source'), icon);
  $('source-text').textContent = text;
}

function onPresence(message) {
  users = message.users;
  ui.renderViewers(users, me?.id);
  renderPeople();
  if (message.joined && message.joined.id !== me?.id) ui.toast(`${message.joined.name} joined`);
}

function renderPeople() {
  const others = users.filter((user) => user.id !== me?.id).map((user) => user.name);
  $('empty-people').textContent = others.length
    ? `${joinNames([...others, 'you'], 3)} are here.`
    : "You're the first one here.";
}

function onSubs(message) {
  const subs = message.subs;
  const cues = subs ? parseSubtitles(subs.text) : [];
  subtitles.setCues(cues);
  $('subs-name').textContent = subs ? subs.name : 'No subtitles';
  $('subs-remove').hidden = !subs;
  $('btn-subs').classList.toggle('is-on', Boolean(subs));

  if (pendingSubs) {
    finishSubs();
    $('subs-url').value = '';
    if (subs && cues.length === 0) ui.setFieldError('subs-error', 'No subtitle lines were found in that file.');
  }
  if (message.by && message.by.id !== me?.id) {
    ui.toast(subs ? `${message.by.name} added subtitles` : `${message.by.name} removed subtitles`);
  }
}

function onLibrary(message) {
  libraryFiles = message.files;
  renderLibrary();
  renderSubsLibrary();
}

function onServerError(message) {
  if (message.context === 'load' && pendingLoad) {
    const { error } = pendingLoad;
    finishLoad({ keepInput: true });
    if (error) ui.setFieldError(error, message.message);
    else ui.toast(message.message, { tone: 'error', duration: 6000 });
    return;
  }
  if (message.context === 'subs' && pendingSubs) {
    finishSubs();
    ui.setFieldError('subs-error', message.message);
    return;
  }
  if (message.context === 'youtube' && youtubePending !== null) {
    failYouTube(message.message);
    return;
  }
  ui.toast(message.message, { tone: 'error', duration: 6000 });
}

/* ---------- Loading videos ---------- */

function requestLoad(payload, { button = null, input = null, error = null, card = null } = {}) {
  if (pendingLoad || !conn) return;
  if ('url' in payload) {
    const url = payload.url.trim();
    if (!url) return error && ui.setFieldError(error, 'Paste a video link first.');
    if (!/^https?:\/\//i.test(url)) return error && ui.setFieldError(error, 'Links need to start with http:// or https://');
    payload = { url };
  }
  if (error) ui.setFieldError(error, '');
  if (!conn.send({ t: 'load', ...payload })) {
    if (error) ui.setFieldError(error, 'Not connected right now. Try again in a moment.');
    return;
  }
  pendingLoad = { button, input, error, card };
  if (button) ui.setBusy(button, true, 'Checking link…');
  if (card) setCardBusy(card, true);
}

function finishLoad({ keepInput = false } = {}) {
  if (!pendingLoad) return;
  const { button, input, error, card } = pendingLoad;
  pendingLoad = null;
  if (button) ui.setBusy(button, false);
  if (card) setCardBusy(card, false);
  if (error) ui.setFieldError(error, '');
  if (input && !keepInput) input.value = '';
  if (!keepInput && ui.isSheetOpen('sheet-video')) ui.closeSheet();
}

function bindLinkForm(inputId, buttonId, errorId) {
  const input = $(inputId);
  const button = $(buttonId);
  button.addEventListener('click', () => requestLoad({ url: input.value }, { button, input, error: errorId }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') button.click();
  });
  input.addEventListener('input', () => ui.setFieldError(errorId, ''));
}

bindLinkForm('empty-url', 'empty-load', 'empty-error');
bindLinkForm('sheet-url', 'sheet-load', 'sheet-error');

$('empty-sample').addEventListener('click', () => {
  $('empty-url').value = SAMPLE_URL;
  $('empty-load').click();
});
$('empty-library').addEventListener('click', () => openVideoSheet('library'));
$('empty-youtube').addEventListener('click', () => openVideoSheet('youtube'));
// "Change video" goes back to wherever the current video came from.
const currentSourceTab = () => ({ youtube: 'youtube', library: 'library' })[serverState?.media?.source] ?? 'link';
$('btn-change').addEventListener('click', () => openVideoSheet(currentSourceTab()));
$('btn-anime3rb').addEventListener('click', () => openVideoSheet('anime'));

function searchWeb(query) {
  const text = String(query ?? '').trim();
  if (!text) {
    $('google-query').focus();
    return;
  }
  openWebsite(searchUrl(text));
}

// The site cards and web search open in the activity's own browser (browser.js).
for (const link of document.querySelectorAll('.anime-site')) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    openWebsite(link.href);
  });
}

$('google-search').addEventListener('click', () => searchWeb($('google-query').value));
$('google-query').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchWeb($('google-query').value);
});
for (const button of document.querySelectorAll('[data-google-query]')) {
  button.addEventListener('click', () => {
    const query = button.dataset.googleQuery || '';
    $('google-query').value = query;
    searchWeb(query);
  });
}
$('notice-change').addEventListener('click', () => openVideoSheet(currentSourceTab()));
$('splash-retry').addEventListener('click', () => location.reload());

function openVideoSheet(tab) {
  const target = tab === 'library' && !libraryEnabled ? 'link' : tab;
  selectVideoTab(target);
  ui.openSheet('sheet-video');
}

function selectVideoTab(name) {
  ui.selectTab('sheet-video', name);
  if (name === 'library') requestLibrary();
  if (name === 'youtube' && !youtubeView) browseYouTube('');
}

const TAB_INPUTS = { link: 'sheet-url', library: 'library-search', youtube: 'yt-query' };
for (const tab of document.querySelectorAll('#video-tabs [role=tab]')) {
  tab.addEventListener('click', () => {
    selectVideoTab(tab.dataset.tab);
    const inputId = TAB_INPUTS[tab.dataset.tab];
    if (inputId) $(inputId)?.focus();
  });
}

function requestLibrary() {
  if (!libraryEnabled || !conn) return;
  if (libraryFiles === null) $('library-status').textContent = 'Loading the library…';
  conn.send({ t: 'library' });
}

$('library-search').addEventListener('input', renderLibrary);

function fileButton(file, onPick) {
  const parts = file.path.split('/');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-list__item';
  const name = document.createElement('span');
  name.className = 'file-list__name';
  name.dir = 'auto';
  name.textContent = parts.pop();
  button.append(name);
  if (parts.length) {
    const folder = document.createElement('span');
    folder.className = 'file-list__folder';
    folder.dir = 'auto';
    folder.textContent = parts.join('/');
    button.append(folder);
  }
  button.addEventListener('click', onPick);
  const item = document.createElement('li');
  item.append(button);
  return item;
}

function renderLibrary() {
  const query = $('library-search').value.trim().toLowerCase();
  const videos = (libraryFiles ?? []).filter(
    (file) => file.kind === 'video' && (!query || file.path.toLowerCase().includes(query)),
  );
  const shown = videos.slice(0, 300);
  $('library-list').replaceChildren(
    ...shown.map((file) => fileButton(file, () => requestLoad({ path: file.path }))),
  );
  let status = '';
  if (libraryFiles === null) status = 'Loading the library…';
  else if (videos.length === 0) status = query ? 'No videos match that search.' : 'No videos found in the library folder.';
  else if (videos.length > shown.length) status = `Showing ${shown.length} of ${videos.length}. Search to narrow it down.`;
  $('library-status').textContent = status;
}

/* ---------- YouTube ---------- */

const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const thumbnailUrl = (id) => `/.proxy/api/thumb?v=${encodeURIComponent(id)}`;
// Playlist and channel links open as a list here; any other link loads straight away.
// Mixes (list=RD…) can't be listed, so those load their video.
const isListLink = (text) =>
  /^https?:\/\/([\w-]+\.)?youtube\.com\//i.test(text) &&
  (/[?&]list=(?!RD)[\w-]{10,}/.test(text) || /youtube\.com\/(@|channel\/|c\/|user\/)/i.test(text));

let youtubePending = null; // the query being looked up ('' asks for what this room played)
let youtubeView = null; // what the results show: { kind: 'search' | 'list' | 'recent', q, title, channel, items }

function submitYouTube() {
  if (pendingLoad || youtubePending !== null) return;
  const text = $('yt-query').value.trim();
  if (/^https?:\/\//i.test(text) && !isListLink(text)) {
    requestLoad({ url: text }, { button: $('yt-submit'), input: $('yt-query'), error: 'yt-error' });
  } else {
    browseYouTube(text);
  }
}

$('yt-submit').addEventListener('click', submitYouTube);
$('yt-query').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitYouTube();
});
$('yt-query').addEventListener('input', () => ui.setFieldError('yt-error', ''));
$('yt-recent').addEventListener('click', () => browseYouTube(''));
renderYouTube();

function browseYouTube(query) {
  if (pendingLoad || youtubePending !== null || !conn) return;
  ui.setFieldError('yt-error', '');
  if (!conn.send({ t: 'youtube', q: query })) {
    ui.setFieldError('yt-error', 'Not connected right now. Try again in a moment.');
    return;
  }
  youtubePending = query;
  if (query) {
    ui.setBusy($('yt-submit'), true, 'Searching…');
    renderYouTubeSkeleton(query);
  }
}

function finishYouTube() {
  if (youtubePending) ui.setBusy($('yt-submit'), false);
  youtubePending = null;
}

function onYouTube(message) {
  if (youtubePending === null) return;
  finishYouTube();
  youtubeView = message;
  renderYouTube();
  $('yt-scroll').scrollTop = 0;
}

function failYouTube(text) {
  finishYouTube();
  renderYouTube(); // put back whatever showed before the search
  ui.setFieldError('yt-error', text);
}

function renderYouTube() {
  const view = youtubeView;
  const items = view?.items ?? [];
  $('yt-results').classList.remove('is-skeleton');
  $('yt-results').setAttribute('aria-busy', 'false');
  $('yt-results').replaceChildren(...items.map(youtubeCard));
  markCurrentYouTube();

  let heading = '';
  if (view?.kind === 'search') heading = `Results for “${view.q}”`;
  else if (view?.kind === 'list') heading = [view.title || 'Playlist', view.channel].filter(Boolean).join(' · ');
  else if (items.length) heading = 'Played in this room';
  $('yt-heading').textContent = heading;
  $('yt-recent').hidden = !view || view.kind === 'recent';

  $('yt-empty').hidden = Boolean(view && (view.kind !== 'recent' || items.length));
  let status = '';
  if (view?.kind === 'search' && !items.length) status = 'No videos found. Try other words.';
  if (view?.kind === 'list' && !items.length) status = 'There are no videos here that can play.';
  $('yt-status').textContent = status;
}

/** Gray placeholder cards while YouTube answers. */
function renderYouTubeSkeleton(query) {
  const placeholders = Array.from({ length: 8 }, () => {
    const item = document.createElement('li');
    item.className = 'yt-skeleton';
    item.append(span('yt-skeleton__thumb'), span('yt-skeleton__line'), span('yt-skeleton__line yt-skeleton__line--short'));
    return item;
  });
  $('yt-results').classList.add('is-skeleton');
  $('yt-results').setAttribute('aria-busy', 'true');
  $('yt-results').replaceChildren(...placeholders);
  $('yt-heading').textContent = /^https?:/i.test(query) ? 'Opening the list…' : `Searching for “${query}”…`;
  $('yt-recent').hidden = true;
  $('yt-empty').hidden = true;
  $('yt-status').textContent = '';
}

function span(className, text = '') {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function youtubeCard(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'yt-card';
  button.dataset.id = item.id;
  button.title = item.title;

  const thumb = span('yt-card__thumb');
  const image = document.createElement('img');
  image.src = thumbnailUrl(item.id);
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('error', () => image.remove(), { once: true });
  thumb.append(image);
  const badge = item.live ? 'Live' : item.duration ? formatTime(item.duration) : '';
  if (badge) thumb.append(span(`yt-card__badge${item.live ? ' yt-card__badge--live' : ''}`, badge));
  thumb.append(span('yt-card__now', 'Now showing'), span('yt-card__opening', 'Opening for everyone…'));

  const title = span('yt-card__title', item.title);
  title.dir = 'auto';
  const details = [item.channel, item.views != null && formatViews(item.views), item.uploaded && formatAgo(item.uploaded)];
  const meta = span('yt-card__meta', details.filter(Boolean).join(' · '));
  meta.dir = 'auto';
  button.append(thumb, title, meta);

  button.addEventListener('click', () => {
    if (youtubePending !== null) return;
    requestLoad({ url: watchUrl(item.id) }, { card: button, error: 'yt-error' });
  });
  const listItem = document.createElement('li');
  listItem.append(button);
  return listItem;
}

function setCardBusy(card, busy) {
  card.classList.toggle('is-loading', busy);
  $('yt-results').classList.toggle('is-busy', busy);
  $('yt-results').setAttribute('aria-busy', String(busy));
}

/** Mark the card of the video that's on screen now. */
function markCurrentYouTube() {
  const media = serverState?.media;
  const link = media?.source === 'youtube' ? media.link : null;
  for (const card of $('yt-results').querySelectorAll('.yt-card')) {
    const current = link === watchUrl(card.dataset.id);
    card.classList.toggle('is-current', current);
    if (current) card.setAttribute('aria-current', 'true');
    else card.removeAttribute('aria-current');
  }
}

/* ---------- Subtitles ---------- */

function requestSubs(payload, button = null) {
  if (pendingSubs || !conn) return;
  ui.setFieldError('subs-error', '');
  if (!conn.send({ t: 'subs', ...payload })) {
    ui.setFieldError('subs-error', 'Not connected right now. Try again in a moment.');
    return;
  }
  pendingSubs = { button };
  if (button) ui.setBusy(button, true, 'Adding…');
}

function finishSubs() {
  if (pendingSubs?.button) ui.setBusy(pendingSubs.button, false);
  pendingSubs = null;
}

$('btn-subs').addEventListener('click', () => {
  ui.openSheet('sheet-subs');
  requestLibrary();
});

$('subs-add').addEventListener('click', () => {
  const url = $('subs-url').value.trim();
  if (!/^https?:\/\//i.test(url)) {
    ui.setFieldError('subs-error', 'Paste a link to an .srt or .vtt file.');
    return;
  }
  requestSubs({ url }, $('subs-add'));
});
$('subs-url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('subs-add').click();
});

$('subs-upload').addEventListener('click', () => $('subs-file').click());
$('subs-file').addEventListener('change', async () => {
  const file = $('subs-file').files?.[0];
  $('subs-file').value = '';
  if (!file) return;
  try {
    const text = await readSubtitleFile(file, subtitleEncoding);
    requestSubs({ text, name: file.name });
  } catch (error) {
    ui.setFieldError('subs-error', error.message);
  }
});

$('subs-remove').addEventListener('click', () => requestSubs({ clear: true }));
$('subs-visible').addEventListener('change', (event) => subtitles.setVisible(event.target.checked));

function setSubDelay(seconds) {
  subDelay = Math.round(clamp(seconds, -60, 60) * 10) / 10;
  subtitles.setDelay(subDelay);
  $('subs-delay').textContent =
    subDelay === 0
      ? 'Matches the video'
      : `${Math.abs(subDelay).toFixed(1)} s ${subDelay > 0 ? 'later' : 'earlier'} than the file`;
}
$('subs-earlier').addEventListener('click', () => setSubDelay(subDelay - 0.5));
$('subs-later').addEventListener('click', () => setSubDelay(subDelay + 0.5));

function renderSubsLibrary() {
  const subtitleFiles = (libraryFiles ?? []).filter((file) => file.kind === 'subtitle');
  const wrap = $('subs-library');
  wrap.hidden = !libraryEnabled || subtitleFiles.length === 0;
  if (wrap.hidden) return;
  // Files next to the current library video come first.
  const folderOf = (relPath) => relPath.split('/').slice(0, -1).join('/');
  const currentFolder = serverState?.media?.path != null ? folderOf(serverState.media.path) : null;
  const sorted = [...subtitleFiles].sort(
    (a, b) => Number(folderOf(b.path) === currentFolder) - Number(folderOf(a.path) === currentFolder),
  );
  $('subs-library-list').replaceChildren(
    ...sorted.slice(0, 60).map((file) => fileButton(file, () => requestSubs({ path: file.path }))),
  );
}

/* ---------- Playback controls ---------- */

function togglePlay() {
  const current = player.state;
  if (!current?.media || !conn) return;
  player.userGesture();
  if (current.paused || player.ended) {
    let position = player.currentTime();
    if (player.ended || position >= player.duration - 0.5) position = 0;
    player.applyLocal({ paused: false, position });
    conn.send({ t: 'play', position });
  } else {
    const position = player.currentTime();
    player.applyLocal({ paused: true, position });
    conn.send({ t: 'pause', position });
  }
}

function seekTo(time) {
  if (!player.state?.media || !conn) return;
  const end = Number.isFinite(player.duration) ? player.duration : Infinity;
  const position = clamp(time, 0, end);
  player.userGesture();
  player.applyLocal({ position });
  conn.send({ t: 'seek', position });
}

$('btn-play').addEventListener('click', togglePlay);

const fractionToTime = (fraction) => (Number.isFinite(player.duration) ? fraction * player.duration : 0);

seekInput.addEventListener('input', () => {
  scrubbing = true;
  $('seek').classList.add('is-dragging');
  showSeekTip(Number(seekInput.value) / 1000);
});
seekInput.addEventListener('change', () => {
  const time = fractionToTime(Number(seekInput.value) / 1000);
  scrubbing = false;
  $('seek').classList.remove('is-dragging');
  $('seek-tip').hidden = true;
  seekTo(time);
});
$('seek').addEventListener('pointermove', (event) => {
  const rect = $('seek').getBoundingClientRect();
  showSeekTip(clamp((event.clientX - rect.left) / rect.width, 0, 1));
});
$('seek').addEventListener('pointerleave', () => {
  if (!scrubbing) $('seek-tip').hidden = true;
});

function showSeekTip(fraction) {
  if (!Number.isFinite(player.duration)) return;
  const tip = $('seek-tip');
  const width = $('seek').clientWidth;
  tip.hidden = false;
  tip.textContent = formatTime(fraction * player.duration);
  tip.style.left = `${clamp(fraction * width, 28, width - 28)}px`;
}

/* Volume stays local to each person. */
const volumeInput = $('volume');
try {
  const saved = localStorage.getItem('watch-party-volume');
  if (saved !== null) video.volume = clamp(Number(saved), 0, 1);
} catch {
  // storage can be unavailable inside some embeds
}

function renderVolume() {
  const muted = video.muted || video.volume === 0;
  setIcon($('btn-mute'), muted ? 'muted' : 'volume');
  $('btn-mute').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  volumeInput.value = String(muted ? 0 : video.volume);
}

function toggleMute() {
  if (player.mutedByPolicy) {
    player.userGesture();
  } else {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
  }
  renderVolume();
}

volumeInput.addEventListener('input', () => {
  player.userGesture();
  video.volume = Number(volumeInput.value);
  video.muted = video.volume === 0;
  try {
    localStorage.setItem('watch-party-volume', String(video.volume));
  } catch {
    // ignore
  }
});
video.addEventListener('volumechange', renderVolume);
$('btn-mute').addEventListener('click', toggleMute);
renderVolume();

const canFullscreen = Boolean(document.fullscreenEnabled);
$('btn-fullscreen').hidden = !canFullscreen;
function toggleFullscreen() {
  if (!canFullscreen) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else appEl.requestFullscreen().catch(() => {});
}
$('btn-fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  setIcon($('btn-fullscreen'), active ? 'fullscreen-exit' : 'fullscreen');
  $('btn-fullscreen').setAttribute('aria-label', active ? 'Exit full screen' : 'Full screen');
});

/* Autoplay fallbacks */
player.on('blocked', () => ui.wake());
player.on('muted-by-policy', renderVolume);
$('gate-button').addEventListener('click', () => player.userGesture());
$('unmute').addEventListener('click', () => player.userGesture());

/* Playback problems on this device */
player.on('error', (message) => {
  $('notice-text').textContent = message;
  $('notice').hidden = false;
  noticeShown = true;
});
player.on('loading', hideNotice);
function hideNotice() {
  $('notice').hidden = true;
  noticeShown = false;
}

/* Clicking the picture shows the controls. It doesn't pause, so a click that only
   focuses the activity never stops the movie for everyone. */
video.addEventListener('click', () => {
  if (ui.isIdle()) ui.wake();
  else ui.sleep();
});

/* Keyboard shortcuts */
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && ui.isSheetOpen()) {
    ui.closeSheet();
    return;
  }
  if (ui.isSheetOpen() || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest?.('input, textarea, select')) return;
  if (!player.state?.media) return;

  const key = event.key.toLowerCase();
  if (key === ' ' || key === 'k') {
    if (key === ' ' && event.target.closest?.('button')) return; // the button handles it
    event.preventDefault();
    togglePlay();
  } else if (key === 'arrowleft' || key === 'j') {
    event.preventDefault();
    seekTo(player.currentTime() - (key === 'j' ? 10 : 5));
  } else if (key === 'arrowright' || key === 'l') {
    event.preventDefault();
    seekTo(player.currentTime() + (key === 'l' ? 10 : 5));
  } else if (key === 'm') {
    toggleMute();
  } else if (key === 'f') {
    toggleFullscreen();
  } else if (key === 'c') {
    const checkbox = $('subs-visible');
    checkbox.checked = !checkbox.checked;
    subtitles.setVisible(checkbox.checked);
    ui.toast(checkbox.checked ? 'Subtitles on' : 'Subtitles off', { duration: 1500 });
  }
});

/* Hardware media keys and lock-screen controls go through the same shared actions. */
if ('mediaSession' in navigator) {
  const actions = {
    play: () => player.state?.paused && togglePlay(),
    pause: () => player.state && !player.state.paused && togglePlay(),
    seekbackward: () => seekTo(player.currentTime() - 10),
    seekforward: () => seekTo(player.currentTime() + 10),
    seekto: (details) => seekTo(details.seekTime),
  };
  for (const [action, handler] of Object.entries(actions)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // unsupported action
    }
  }
}

for (const type of ['pointermove', 'pointerdown', 'keydown']) {
  appEl.addEventListener(type, () => ui.wake(), { passive: true });
}
ui.setIdlePolicy(() => Boolean(player.state?.media) && !player.state.paused && !player.ended);

/* ---------- Render loop ---------- */

function renderProgress() {
  const known = video.readyState >= 1;
  const duration = player.duration;
  const live = known && !Number.isFinite(duration);
  const time = scrubbing ? fractionToTime(Number(seekInput.value) / 1000) : player.currentTime();
  const fraction = known && !live ? clamp(time / duration, 0, 1) : 0;

  $('seek-played').style.width = `${fraction * 100}%`;
  $('seek-thumb').style.left = `${fraction * 100}%`;
  if (!scrubbing) seekInput.value = String(Math.round(fraction * 1000));

  let bufferedEnd = 0;
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i += 1) {
    if (ranges.start(i) <= video.currentTime + 0.5 && ranges.end(i) >= video.currentTime) bufferedEnd = ranges.end(i);
  }
  $('seek-buffered').style.width = known && !live ? `${clamp(bufferedEnd / duration, 0, 1) * 100}%` : '0%';

  const text = live ? 'Live' : known ? `${formatTime(time)} / ${formatTime(duration)}` : formatTime(time);
  if (timeEl.textContent !== text) timeEl.textContent = text;
  const seek = $('seek');
  if (seek.hidden !== live) seek.hidden = live;
}

function renderPlayButton() {
  const state = player.state;
  const ended = player.ended;
  const playing = Boolean(state?.media) && !state.paused && !ended;
  const button = $('btn-play');
  setIcon(button, playing ? 'pause' : ended ? 'replay' : 'play');
  const label = playing ? 'Pause' : ended ? 'Play from the start' : 'Play';
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
}

function renderWaiting(now) {
  const state = player.state;
  const waiting =
    Boolean(state?.media) &&
    !noticeShown &&
    (video.readyState < 1 ||
      video.seeking ||
      (!state.paused && !player.ended && !player.blocked && video.readyState < 3));
  if (!waiting) bufferingSince = 0;
  else if (!bufferingSince) bufferingSince = now;
  ui.setBuffering(waiting && now - bufferingSince > 350);

  const gateNeeded = player.blocked && Boolean(state?.media) && !state.paused && !player.ended;
  if ($('gate').hidden === gateNeeded) $('gate').hidden = !gateNeeded;
  // Playing muted because sound needs a tap: offer the tap, unless the gate already asks for one.
  const pillNeeded = player.mutedByPolicy && Boolean(state?.media) && !gateNeeded;
  if ($('unmute').hidden === pillNeeded) $('unmute').hidden = !pillNeeded;
}

function frame(now) {
  if (player.state?.media) {
    renderProgress();
    renderPlayButton();
  }
  renderWaiting(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

boot();

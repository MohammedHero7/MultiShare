// YouTube links. yt-dlp (installed separately) turns a watch link into a stream
// URL, and the video then flows through /api/media like any other link.
//
// YouTube stream URLs expire after a few hours and only work from the IP address
// that asked for them. So the activity gets a stable /api/youtube link that
// re-resolves when needed, and yt-dlp and the proxy both stick to IPv4.
//
// yt-dlp also powers the YouTube tab: searches, playlists and channel pages are
// listed with --flat-playlist, which reads YouTube's listing without resolving
// every video.

import { execFile, spawn } from 'node:child_process';
import { pipeline } from 'node:stream';
import { config } from './config.js';
import { UserError } from './errors.js';
import { rewritePlaylist } from './media.js';
import { decodedStream, readBody, request } from './safe-http.js';
import { proxiedUrl, verifyYouTube, youtubeUrl } from './signing.js';

const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i;
const SHORT_HOSTS = /^(www\.)?youtu\.be$/i;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const CHANNEL_TABS = new Set(['videos', 'shorts', 'streams']);
const CACHE_MS = 3 * 60 * 60 * 1000; // stream URLs last about 6 hours
const RESOLVE_TIMEOUT_MS = 60_000;
const BROWSE_TIMEOUT_MS = 30_000;
const BROWSE_CACHE_MS = 10 * 60 * 1000;
const SEARCH_RESULTS = 24;
const LIST_RESULTS = 60;
const INSTALL_HINT = 'Install it with "winget install yt-dlp.yt-dlp", then restart npm run dev in a new terminal.';
const UPDATE_HINT = 'Updating yt-dlp often fixes this: run "yt-dlp -U" or "winget upgrade yt-dlp.yt-dlp".';
// Each yt-dlp run is a Python process plus a Node process, so only a few run at
// once and a short queue waits; anything beyond that is turned away.
const MAX_RUNS = 2;
const MAX_QUEUED = 6;

const cache = new Map(); // video id -> { at, promise }
const browseCache = new Map(); // yt-dlp target -> { at, promise }
const waiting = []; // start functions for runs waiting for a free slot
let running = 0;

/** The 11-character video id from any common YouTube link, or null. */
export function youtubeVideoId(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  let id = null;
  if (SHORT_HOSTS.test(url.hostname)) {
    id = url.pathname.split('/')[1];
  } else if (YOUTUBE_HOSTS.test(url.hostname)) {
    const [first, second] = url.pathname.split('/').filter(Boolean);
    if (first === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'live', 'embed', 'v', 'e'].includes(first)) id = second;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/** Resolve a video for Room.load: its title and how the client should play it. */
export async function loadYouTube(id) {
  const wasCached = isCached(id);
  let info = await resolveYouTube(id);
  let status = await checkStream(info);
  if (wasCached && !isOk(status)) {
    // The cached stream may have gone stale; ask YouTube once more.
    info = await resolveYouTube(id, { fresh: true });
    status = await checkStream(info);
  }
  if (status === 0) throw new UserError("The server couldn't reach YouTube's video servers. Try again in a moment.");
  if (!isOk(status)) {
    cache.delete(id);
    throw new UserError(`YouTube refused to stream this video to the server (HTTP ${status}). ${UPDATE_HINT}`);
  }
  return {
    title: info.title || 'YouTube video',
    channel: info.channel,
    duration: info.duration,
    kind: /m3u8/.test(info.protocol) ? 'hls' : 'file',
    src: youtubeUrl(id),
    poster: thumbnailUrl(id, 'poster'),
  };
}

/** Thumbnails also come through the server: Discord activities can't load images from other sites. */
export const thumbnailUrl = (id, size = 'card') =>
  `/.proxy/api/thumb?v=${encodeURIComponent(id)}${size === 'poster' ? '&size=poster' : ''}`;

/**
 * Search YouTube, or list a playlist or a channel's videos, for the YouTube tab.
 * Resolves to { kind: 'search' | 'list', title, channel, items }.
 */
export async function browseYouTube(raw) {
  const query = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!query) throw new UserError('Type something to search for.');
  const search = !/^https?:\/\//i.test(query);
  const target = search ? `ytsearch${SEARCH_RESULTS}:${query.toLowerCase()}` : listUrl(query);

  for (const [key, entry] of browseCache) {
    if (Date.now() - entry.at >= BROWSE_CACHE_MS || browseCache.size > 200) browseCache.delete(key);
  }
  const cached = browseCache.get(target);
  if (cached) return cached.promise;

  const entry = {
    at: Date.now(),
    promise: withRunSlot(() => runYtDlp(browseArgs(target), { label: target, timeoutMs: BROWSE_TIMEOUT_MS })).then(
      (stdout) => parseListing(stdout, search),
    ),
  };
  browseCache.set(target, entry);
  entry.promise.catch(() => {
    if (browseCache.get(target) === entry) browseCache.delete(target);
  });
  return entry.promise;
}

/** The yt-dlp target for a playlist or channel link. Mixes (list=RD…) can't be listed. */
function listUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError("That doesn't look like a valid link.");
  }
  if (!YOUTUBE_HOSTS.test(url.hostname)) {
    throw new UserError('Paste a YouTube playlist or channel link, or type words to search.');
  }
  const list = url.searchParams.get('list');
  if (list && LIST_ID.test(list) && !list.startsWith('RD')) return `https://www.youtube.com/playlist?list=${list}`;

  // pathname is still percent-encoded, so a segment can't smuggle in "/", "?" or "#".
  const [first = '', second, third] = url.pathname.split('/').filter(Boolean);
  let channel = null;
  let tab = null;
  if (first.startsWith('@') && first.length > 1) {
    [channel, tab] = [first, second];
  } else if (['channel', 'c', 'user'].includes(first) && second) {
    [channel, tab] = [`${first}/${second}`, third];
  }
  if (channel) return `https://www.youtube.com/${channel}/${CHANNEL_TABS.has(tab) ? tab : 'videos'}`;
  throw new UserError("That link isn't a playlist or a channel. Paste video links in the Link tab.");
}

function browseArgs(target) {
  return [
    '--ignore-config',
    '--flat-playlist',
    '--dump-single-json',
    '--playlist-items',
    `1:${LIST_RESULTS}`,
    '--js-runtimes',
    'node',
    '--',
    target,
  ];
}

const UNAVAILABLE_TITLE = /^\[(private|deleted) video\]$/i;
const cleanText = (value) => (typeof value === 'string' ? value.trim().slice(0, 200) : '');
const cleanCount = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

function parseListing(stdout, search) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = null;
  }
  if (!Array.isArray(data?.entries)) throw new UserError(`yt-dlp didn't return a list of videos. ${UPDATE_HINT}`);

  // Channel pages leave the channel off each video, so fall back to the list's own.
  const listChannel = cleanText(data.channel || data.uploader);
  const seen = new Set();
  const items = [];
  for (const entry of data.entries) {
    const id = entry?.id;
    if (typeof id !== 'string' || !VIDEO_ID.test(id) || seen.has(id)) continue;
    if (entry._type === 'playlist' || entry.live_status === 'is_upcoming' || UNAVAILABLE_TITLE.test(entry.title)) continue;
    seen.add(id);
    items.push({
      id,
      title: cleanText(entry.title) || 'YouTube video',
      channel: cleanText(entry.channel || entry.uploader) || listChannel,
      duration: cleanCount(entry.duration),
      views: cleanCount(entry.view_count),
      uploaded: cleanCount(entry.timestamp), // seconds; YouTube only says "3 years ago", so it's approximate
      live: entry.live_status === 'is_live',
    });
  }
  return {
    kind: search ? 'search' : 'list',
    title: search ? '' : cleanText(data.title),
    channel: search ? '' : listChannel,
    items,
  };
}

const THUMBNAILS = { card: ['mqdefault'], poster: ['maxresdefault', 'hqdefault'] };

/**
 * GET /api/thumb?v=<id>[&size=poster] streams a YouTube thumbnail. It only ever
 * fetches i.ytimg.com for a well-formed video id, so it needs no signature.
 */
export async function handleThumbnail(req, res) {
  const id = req.query.v;
  if (typeof id !== 'string' || !VIDEO_ID.test(id)) {
    res.status(404).end();
    return;
  }
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  // Not every video has a full-HD thumbnail; i.ytimg.com answers 404 for those.
  for (const name of req.query.size === 'poster' ? THUMBNAILS.poster : THUMBNAILS.card) {
    let upstream;
    try {
      upstream = await request(`https://i.ytimg.com/vi/${id}/${name}.jpg`, { signal: controller.signal, timeoutMs: 10000 });
    } catch {
      break;
    }
    if (upstream.statusCode === 200) {
      res.set({ 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
      if (upstream.headers['content-length']) res.set('content-length', upstream.headers['content-length']);
      pipeline(upstream, res, () => {});
      return;
    }
    upstream.destroy();
  }
  if (!res.headersSent && !controller.signal.aborted) res.status(404).end();
}

/** GET /api/youtube?v=<id>&s=<signature> sends the player on to a current stream URL. */
export async function handleYouTube(req, res) {
  const id = req.query.v;
  if (!verifyYouTube(id, req.query.s)) {
    res.status(403).type('text').send('This media link is invalid. Load the video again.');
    return;
  }
  try {
    const info = await resolveYouTube(id);
    res.set('cache-control', 'no-store');
    if (!info.master) {
      res.redirect(302, proxiedUrl(info.url, info.userAgent));
      return;
    }
    // YouTube's master playlist offers every size it has, so serve it here without
    // the ones above YOUTUBE_MAX_HEIGHT. Its parts still go through /api/media.
    const upstream = await request(info.url, info.userAgent ? { headers: { 'user-agent': info.userAgent } } : {});
    if (upstream.statusCode >= 400) {
      upstream.resume();
      throw new UserError(`YouTube refused the video's playlist (HTTP ${upstream.statusCode}). Load the video again.`);
    }
    const text = (await readBody(decodedStream(upstream), 2 * 1024 * 1024)).toString('utf8');
    res.type('application/vnd.apple.mpegurl');
    res.send(rewritePlaylist(capVariants(text, config.youtubeMaxHeight), upstream.finalUrl, info.userAgent));
  } catch (error) {
    if (!res.headersSent) res.status(502).type('text').send(error.expose ? error.message : 'Could not get this video from YouTube.');
  }
}

/** Drop the variants of an HLS master playlist that are taller than maxHeight. */
function capVariants(text, maxHeight) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let variants = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const height = Number(/^#EXT-X-STREAM-INF:.*RESOLUTION=\d+x(\d+)/.exec(lines[i])?.[1]);
    if (height > maxHeight) {
      i += 1; // and the variant's URI on the next line
      continue;
    }
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) variants += 1;
    kept.push(lines[i]);
  }
  return variants > 0 ? kept.join('\n') : text;
}

/** Log at startup whether YouTube links will work, so a missing yt-dlp shows up early. */
export function logYouTubeSupport() {
  const report = (error, stdout) => {
    if (error?.code === 'ENOENT') {
      console.warn(`  ! yt-dlp was not found, so YouTube links won't work. ${INSTALL_HINT}`);
    } else if (error) {
      console.warn(`  ! yt-dlp didn't start (${error.code || error.message}), so YouTube links may not work.`);
    } else {
      console.log(`  YouTube links: on (yt-dlp ${String(stdout).trim()})`);
      // yt-dlp only uses Node 22 or newer to solve YouTube's JavaScript checks.
      if (Number(process.versions.node.split('.')[0]) < 22) {
        console.warn(
          `  ! yt-dlp needs Node.js 22 or newer for YouTube (this is ${process.version}). Install the current LTS: winget install OpenJS.NodeJS.LTS`,
        );
      }
    }
  };
  try {
    execFile(config.ytDlpPath, ['--version'], { windowsHide: true, timeout: 15000 }, report);
  } catch (error) {
    report(error);
  }
}

function isCached(id) {
  const entry = cache.get(id);
  return Boolean(entry && Date.now() - entry.at < CACHE_MS);
}

function resolveYouTube(id, { fresh = false } = {}) {
  if (!fresh && isCached(id)) return cache.get(id).promise;
  for (const [key, entry] of cache) {
    if (Date.now() - entry.at >= CACHE_MS) cache.delete(key);
  }
  const entry = { at: Date.now(), promise: withRunSlot(() => fetchStream(id)) };
  cache.set(id, entry);
  entry.promise.catch(() => {
    if (cache.get(id) === entry) cache.delete(id);
  });
  return entry.promise;
}

/** Run `task` when fewer than MAX_RUNS are running; turn it away if the queue is full. */
function withRunSlot(task) {
  if (running >= MAX_RUNS && waiting.length >= MAX_QUEUED) {
    return Promise.reject(new UserError('The server is busy getting other YouTube videos. Try again in a moment.'));
  }
  return new Promise((resolve, reject) => {
    const start = () => {
      running += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          waiting.shift()?.();
        });
    };
    if (running < MAX_RUNS) start();
    else waiting.push(start);
  });
}

const isOk = (status) => status >= 200 && status < 400;

/** Request the first byte of the stream to make sure YouTube will serve it to this server. */
async function checkStream(info) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    const headers = { range: 'bytes=0-0' };
    if (info.userAgent) headers['user-agent'] = info.userAgent;
    res = await request(info.url, { headers, signal: controller.signal });
    return res.statusCode;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
    res?.destroy();
  }
}

function ytDlpArgs(id) {
  return [
    '--ignore-config',
    '--no-playlist',
    '--force-ipv4',
    // yt-dlp needs a JavaScript runtime for YouTube; Node is already installed.
    '--js-runtimes',
    'node',
    // One file with both picture and sound: HLS (up to 1080p) when offered, else MP4.
    // YouTube often offers picture and sound only separately now; then any HLS
    // video will do, because its master playlist (manifest_url) pairs them.
    '-f',
    'best[protocol^=m3u8]/best/bv*[protocol^=m3u8]',
    '-S',
    `res:${config.youtubeMaxHeight},vcodec:h264`,
    '--print',
    '%(.{title,channel,uploader,duration,url,manifest_url,acodec,protocol,http_headers})j',
    '--',
    `https://www.youtube.com/watch?v=${id}`,
  ];
}

async function fetchStream(id) {
  const stdout = await runYtDlp(ytDlpArgs(id), { label: id, timeoutMs: RESOLVE_TIMEOUT_MS });
  const line = stdout.trim().split('\n').pop();
  let info;
  try {
    info = JSON.parse(line);
  } catch {
    info = null;
  }
  if (typeof info?.url !== 'string' || !/^https?:\/\//.test(info.url)) {
    throw new UserError(`yt-dlp didn't return a playable stream for this video. ${UPDATE_HINT}`);
  }
  const protocol = String(info.protocol || '');
  const master = info.acodec === 'none' && /m3u8/.test(protocol) && /^https?:\/\//.test(info.manifest_url ?? '');
  return {
    title: cleanText(info.title),
    channel: cleanText(info.channel || info.uploader),
    duration: cleanCount(info.duration),
    url: master ? info.manifest_url : info.url,
    master, // a master playlist that pairs picture-only streams with sound
    protocol,
    // Some of YouTube's streams only work with the user agent that requested them.
    userAgent: typeof info.http_headers?.['User-Agent'] === 'string' ? info.http_headers['User-Agent'] : '',
  };
}

/** Run yt-dlp and resolve with what it printed; failures become messages people can act on. */
function runYtDlp(args, { label, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    let child;
    try {
      child = spawn(config.ytDlpPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
    } catch (error) {
      reject(spawnError(error));
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4_000_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 100_000) stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new UserError('YouTube took too long to answer. Try again in a moment.'));
    }, timeoutMs);

    child.on('error', (error) => finish(reject, spawnError(error)));
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`[youtube] yt-dlp failed for ${label}:\n${stderr.trim().split('\n').slice(-5).join('\n')}`);
        finish(reject, ytDlpError(stderr));
        return;
      }
      finish(resolve, stdout);
    });
  });
}

function spawnError(error) {
  if (error.code === 'ENOENT') return new UserError(`YouTube links need yt-dlp on the computer running the server. ${INSTALL_HINT}`);
  return new UserError(`Couldn't start yt-dlp (${error.code || error.message}).`);
}

const YT_DLP_ERRORS = [
  [/no such option|unrecognized arguments/i, `Your yt-dlp is too old for YouTube. ${UPDATE_HINT}`],
  [/not a bot/i, `YouTube asked the server to prove it isn't a bot. Wait a while and try again. ${UPDATE_HINT}`],
  [/confirm your age|age.restricted|inappropriate for some users/i, "This video is age-restricted, so it can't play here."],
  [/private video/i, 'This video is private.'],
  [/members.only|join this channel/i, 'This video is only for channel members.'],
  [/premieres in|live event will begin|this live event/i, "This video hasn't started yet."],
  [/not available in your country|blocked it in your country/i, "This video isn't available in your country."],
  [/requested format is not available/i, `YouTube didn't offer a version of this video that can play here. ${UPDATE_HINT}`],
  [/video unavailable|has been removed|account .* terminated|no longer available/i, 'This video is unavailable.'],
  [/does not exist|HTTP Error 40[04]|does not have an? \w+ tab/i, "YouTube couldn't find that playlist or channel. It may be private or deleted."],
];

function ytDlpError(stderr) {
  // Match the ERROR lines, not warnings printed before them.
  const errors = stderr.split('\n').filter((line) => line.startsWith('ERROR:')).join('\n') || stderr;
  for (const [pattern, message] of YT_DLP_ERRORS) {
    if (pattern.test(errors)) return new UserError(message);
  }
  return new UserError(`YouTube wouldn't give the server this video. ${UPDATE_HINT}`);
}

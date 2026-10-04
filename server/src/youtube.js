// YouTube links. yt-dlp (installed separately) turns a watch link into a stream
// URL, and the video then flows through /api/media like any other link.
//
// YouTube stream URLs expire after a few hours and only work from the IP address
// that asked for them. So the activity gets a stable /api/youtube link that
// re-resolves when needed, and yt-dlp and the proxy both stick to IPv4.

import { execFile, spawn } from 'node:child_process';
import { config } from './config.js';
import { UserError } from './errors.js';
import { request } from './safe-http.js';
import { proxiedUrl, verifyYouTube, youtubeUrl } from './signing.js';

const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i;
const SHORT_HOSTS = /^(www\.)?youtu\.be$/i;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CACHE_MS = 3 * 60 * 60 * 1000; // stream URLs last about 6 hours
const RESOLVE_TIMEOUT_MS = 60_000;
const INSTALL_HINT = 'Install it with "winget install yt-dlp.yt-dlp", then restart npm run dev in a new terminal.';
const UPDATE_HINT = 'Updating yt-dlp often fixes this: run "yt-dlp -U" or "winget upgrade yt-dlp.yt-dlp".';
// Each yt-dlp run is a Python process plus a Node process, so only a few run at
// once and a short queue waits; anything beyond that is turned away.
const MAX_RUNS = 2;
const MAX_QUEUED = 6;

const cache = new Map(); // video id -> { at, promise }
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
    kind: /m3u8/.test(info.protocol) ? 'hls' : 'file',
    src: youtubeUrl(id),
  };
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
    res.redirect(302, proxiedUrl(info.url, info.userAgent));
  } catch (error) {
    res.status(502).type('text').send(error.expose ? error.message : 'Could not get this video from YouTube.');
  }
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
  const entry = { at: Date.now(), promise: withRunSlot(() => runYtDlp(id)) };
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
    '-f',
    'best[protocol^=m3u8]/best',
    '-S',
    `res:${config.youtubeMaxHeight},vcodec:h264`,
    '--print',
    '%(.{title,url,protocol,http_headers})j',
    '--',
    `https://www.youtube.com/watch?v=${id}`,
  ];
}

function runYtDlp(id) {
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
      child = spawn(config.ytDlpPath, ytDlpArgs(id), {
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
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 100_000) stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new UserError('YouTube took too long to answer. Try again in a moment.'));
    }, RESOLVE_TIMEOUT_MS);

    child.on('error', (error) => finish(reject, spawnError(error)));
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`[youtube] yt-dlp failed for ${id}:\n${stderr.trim().split('\n').slice(-5).join('\n')}`);
        finish(reject, ytDlpError(stderr));
        return;
      }
      const line = stdout.trim().split('\n').pop();
      let info;
      try {
        info = JSON.parse(line);
      } catch {
        info = null;
      }
      if (typeof info?.url !== 'string' || !/^https?:\/\//.test(info.url)) {
        finish(reject, new UserError(`yt-dlp didn't return a playable stream for this video. ${UPDATE_HINT}`));
        return;
      }
      finish(resolve, {
        title: typeof info.title === 'string' ? info.title.slice(0, 200) : '',
        url: info.url,
        protocol: String(info.protocol || ''),
        // Some of YouTube's streams only work with the user agent that requested them.
        userAgent: typeof info.http_headers?.['User-Agent'] === 'string' ? info.http_headers['User-Agent'] : '',
      });
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
];

function ytDlpError(stderr) {
  // Match the ERROR lines, not warnings printed before them.
  const errors = stderr.split('\n').filter((line) => line.startsWith('ERROR:')).join('\n') || stderr;
  for (const [pattern, message] of YT_DLP_ERRORS) {
    if (pattern.test(errors)) return new UserError(message);
  }
  return new UserError(`YouTube wouldn't give the server this video. ${UPDATE_HINT}`);
}

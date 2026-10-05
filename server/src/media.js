import path from 'node:path';
import { pipeline } from 'node:stream';
import { UserError } from './errors.js';
import { decodeText, decodedStream, parseUserUrl, readBody, request } from './safe-http.js';
import { proxiedUrl, verifyProxied } from './signing.js';

const FORWARDED_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
  'content-encoding',
];

const TYPE_BY_EXTENSION = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/webm',
  '.ogv': 'video/ogg',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.vtt': 'text/vtt',
};

const extensionOf = (url) => path.extname(new URL(url).pathname).toLowerCase();
const isPlaylistResponse = (type, url) => /mpegurl/i.test(type) || /\.m3u8?$/i.test(new URL(url).pathname);

/**
 * GET /api/media?u=<url>&s=<signature>
 * Streams a remote file (with Range support for seeking) or rewrites an HLS
 * playlist so every segment also goes through this endpoint.
 */
export async function handleMedia(req, res) {
  const target = req.query.u;
  const userAgent = req.query.a ?? '';
  if (!verifyProxied(target, userAgent, req.query.s)) {
    res.status(403).type('text').send('This media link is invalid. Load the video again.');
    return;
  }

  const controller = new AbortController();
  // Browsers cancel requests constantly while seeking; stop the upstream download too.
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  let upstream;
  try {
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;
    if (userAgent) headers['user-agent'] = userAgent;
    upstream = await request(target, { headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) return;
    res.status(502).type('text').send(error.expose ? error.message : 'Could not reach the video server.');
    return;
  }

  const type = String(upstream.headers['content-type'] || '');

  if (upstream.statusCode < 400 && isPlaylistResponse(type, upstream.finalUrl)) {
    try {
      const body = (await readBody(decodedStream(upstream), 8 * 1024 * 1024)).toString('utf8');
      res.status(200).set({ 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache' });
      res.send(body.trimStart().startsWith('#EXTM3U') ? rewritePlaylist(body, upstream.finalUrl, userAgent) : body);
    } catch {
      if (!res.headersSent) res.status(502).type('text').send('Could not read the playlist.');
    }
    return;
  }

  res.status(upstream.statusCode);
  for (const name of FORWARDED_HEADERS) {
    if (upstream.headers[name] != null) res.setHeader(name, upstream.headers[name]);
  }
  if (!type || /octet-stream|binary/i.test(type)) {
    const guess = TYPE_BY_EXTENSION[extensionOf(upstream.finalUrl)];
    if (guess) res.setHeader('content-type', guess);
  }
  res.setHeader('cache-control', 'private, max-age=3600');
  pipeline(upstream, res, () => {
    // Aborted range requests land here; that's normal while seeking.
  });
}

/** Point every URI in an HLS playlist (segments, variants, keys, init maps) at our proxy. */
export function rewritePlaylist(text, baseUrl, userAgent = '') {
  const rewrite = (uri) => {
    try {
      const absolute = new URL(uri.trim(), baseUrl);
      if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;
      return proxiedUrl(absolute.href, userAgent);
    } catch {
      return null;
    }
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (match, uri) => {
          const proxied = rewrite(uri);
          return proxied ? `URI="${proxied}"` : match;
        });
      }
      return rewrite(trimmed) ?? line;
    })
    .join('\n');
}

const NOT_DIRECT_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
const DRM_HOSTS = /(^|\.)(netflix\.com|disneyplus\.com|primevideo\.com|max\.com|hbomax\.com|hulu\.com|shahid\.mbc\.net|osnplus\.com)$/i;

/** Check that a pasted link is something a browser can play before loading it for everyone. */
export async function probeUrl(raw) {
  const url = parseUserUrl(raw);
  if (NOT_DIRECT_HOSTS.test(url.hostname)) {
    // Video links are handled by youtube.js before this; anything left is a channel, playlist or search page.
    throw new UserError("That YouTube link isn't a single video. Open the video and copy its link from Share.");
  }
  if (DRM_HOSTS.test(url.hostname)) {
    throw new UserError("Streaming services protect their videos with DRM, so they can't play here.");
  }

  // Share4Max publishes playable pages under /iframe/<id>. These are not raw
  // video files, so keep the URL as an iframe instead of probing it as HTML.
  if (/^(?:www\.)?share4max\.net$/i.test(url.hostname) && /^\/iframe\/[^/]+/i.test(url.pathname)) {
    return { kind: 'iframe', finalUrl: url.href };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await request(url.href, { headers: { range: 'bytes=0-4095' }, signal: controller.signal });
    if (res.statusCode >= 400) {
      throw new UserError(`The video server refused the link (HTTP ${res.statusCode}). It may have expired or need a login.`);
    }
    const type = String(res.headers['content-type'] || '').toLowerCase();
    const head = (await readBody(decodedStream(res), 4096, { truncate: true })).toString('utf8');

    if (head.trimStart().startsWith('#EXTM3U') || /mpegurl/.test(type)) {
      return { kind: 'hls', finalUrl: res.finalUrl };
    }
    if (type.includes('text/html') || /^\s*<(!doctype|html|head|body)/i.test(head)) {
      throw new UserError(
        'That link opens a web page, not a video file. Right-click the video and copy its address, or use a link ending in .mp4, .webm or .m3u8.',
      );
    }
    if (type.startsWith('image/')) throw new UserError('That link is an image, not a video.');
    return { kind: 'file', finalUrl: res.finalUrl };
  } catch (error) {
    if (error.expose) throw error;
    if (controller.signal.aborted) throw new UserError('The video server took too long to respond.');
    throw new UserError(`Couldn't open that link (${error.code || error.message}).`);
  } finally {
    clearTimeout(timer);
    res?.destroy();
  }
}

/** Download a subtitle file (.srt / .vtt) from a link. */
export async function fetchSubtitleUrl(raw) {
  const url = parseUserUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await request(url.href, { signal: controller.signal });
    if (res.statusCode >= 400) throw new UserError(`The subtitle link returned HTTP ${res.statusCode}.`);
    const buffer = await readBody(decodedStream(res), 5 * 1024 * 1024);
    return { name: fileName(res.finalUrl) || 'Subtitles', text: decodeText(buffer) };
  } catch (error) {
    if (error.expose) throw error;
    if (controller.signal.aborted) throw new UserError('The subtitle server took too long to respond.');
    throw new UserError(`Couldn't download those subtitles (${error.code || error.message}).`);
  } finally {
    clearTimeout(timer);
    res?.destroy();
  }
}

function fileName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

const GENERIC_PLAYLIST_NAMES = /^(index|master|main|playlist|manifest|video|stream|prog_index|chunklist[^.]*)\.m3u8?$/i;

const GENERIC_FOLDER_NAMES = /^(hls|dash|video|videos|stream|streams|media|vod|movies?|files?|\d+p|[0-9a-f-]{16,})$/i;

/**
 * A readable title from a link: "Big_Buck_Bunny.mp4" → "Big Buck Bunny".
 * For generic playlist names (".../inception/master.m3u8") the folder is used.
 */
export function titleFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'Video';
  }
  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const name = segments.pop() || '';
  if (name && !GENERIC_PLAYLIST_NAMES.test(name)) return prettyName(name);
  const folder = segments.reverse().find((segment) => !GENERIC_FOLDER_NAMES.test(segment));
  return folder ? prettyName(folder) : parsed.hostname.replace(/^www\./, '');
}

export function prettyName(name) {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, '');
  const spaced = /\s/.test(base) ? base : base.replace(/[._]+/g, ' ');
  return spaced.trim() || name;
}

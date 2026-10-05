// The activity's built-in browser.
//
// Discord only lets an activity load pages from its own server, so a website opened
// in the activity comes through here: /api/web/<token>/<scheme>/<host>/<path> fetches
// <scheme>://<host>/<path> and sends it back. Links in HTML and CSS are rewritten to
// point back at this route, and web-runtime.js, added to every page, does the same
// for whatever the page's scripts load later.
//
// Browsers send no Referer from sandboxed pages, but video hosts often check it. So a
// link to another site carries the origin of the page it's on (?__mpref=), and the
// server sends that as the Referer. Other requests come from a page on the same site.
//
// Pages are served with a CSP sandbox, so they run in an opaque origin: a website
// can't reach the activity, its Discord session or the watch party, even though it
// comes from the same server. The token is handed out when someone joins a room, so
// the route only works for people in the activity. Cookies a website sets are kept
// here, per token, and never reach the browser.

import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { RewritingStream } from 'parse5-html-rewriting-stream';
import { decodedStream, readBody, request } from './safe-http.js';
import { verifyWebToken } from './signing.js';

const RUNTIME_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web-runtime.js');
const RUNTIME_SRC = '/.proxy/api/web-runtime.js';

const MAX_REWRITE_BYTES = 8 * 1024 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Pages may run scripts, forms and dialogs, but not open popups (where most ads go),
// navigate the activity, or share its origin.
const SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-pointer-lock allow-presentation';
// Page addresses carry the token, so they never go out in a Referer header.
const REFERRER_POLICY = 'no-referrer';

/* ---------- Addresses ---------- */

const WEB_PATH = /^(?:\/\.proxy)?\/api\/web\/([\w.-]+)\/(https?)\/([^/?#]+)([^?#]*)(\?[^#]*)?/;
const REF_PARAM = /([?&])__mpref=([^&]*)&?/;

function originOf(text) {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The token, website address and referring origin in a /api/web path, or null. */
function parseWebPath(pathAndQuery) {
  const match = WEB_PATH.exec(pathAndQuery);
  if (!match) return null;
  const [, token, scheme, host, pathname] = match;
  let search = match[5] ?? '';
  let from = null;
  const ref = REF_PARAM.exec(search);
  if (ref) {
    search = search.replace(REF_PARAM, '$1').replace(/[?&]$/, '');
    try {
      from = originOf(decodeURIComponent(ref[2]));
    } catch {
      // a malformed origin: send none
    }
  }
  try {
    const url = new URL(`${scheme}://${host}${pathname || '/'}${search}`);
    return { token, url, from: from ?? url.origin };
  } catch {
    return null;
  }
}

/**
 * The address the activity uses to open `url` (a URL object) in its browser, for a
 * link on a page from origin `from`.
 */
export function webPath(token, url, from = url.origin) {
  let { search } = url;
  if (from !== url.origin) search = `${search || '?'}${search.length > 1 ? '&' : ''}__mpref=${encodeURIComponent(from)}`;
  return `/.proxy/api/web/${token}/${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${search}${url.hash}`;
}

// DuckDuckGo's results link through a redirect page; go to the result directly.
function unwrapRedirect(url) {
  if (/(^|\.)duckduckgo\.com$/i.test(url.hostname) && url.pathname === '/l/') {
    try {
      return new URL(url.searchParams.get('uddg'));
    } catch {
      // not a result link
    }
  }
  return url;
}

const SKIP_URL = /^(#|javascript:|data:|blob:|about:|mailto:|tel:|sms:)/i;

/** Links in a page: `page` is { token, base, from }, `from` being the page's origin. */
function rewriteUrl(value, page) {
  const text = value.trim();
  if (!text || SKIP_URL.test(text)) return value;
  let url;
  try {
    url = unwrapRedirect(new URL(text, page.base));
  } catch {
    return value;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
  return webPath(page.token, url, page.from);
}

/** srcset: "a.jpg 1x, b.jpg 2x". URLs may contain commas, so split the way browsers do. */
function rewriteSrcset(value, rewrite) {
  const candidates = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i += 1;
    if (i >= value.length) break;
    let end = i;
    while (end < value.length && !/\s/.test(value[end])) end += 1;
    let url = value.slice(i, end);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const comma = value.indexOf(',', end);
      const stop = comma === -1 ? value.length : comma;
      descriptor = value.slice(end, stop).trim();
      end = stop;
    }
    candidates.push(descriptor ? `${rewrite(url)} ${descriptor}` : rewrite(url));
    i = end + 1;
  }
  return candidates.join(', ');
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(["'])([^"']+)\1/gi;

function rewriteCss(css, page) {
  return css
    .replace(CSS_URL, (match, double, single, bare) => {
      const url = double ?? single ?? bare;
      const rewritten = rewriteUrl(url, page);
      return rewritten === url ? match : `url("${rewritten}")`;
    })
    .replace(CSS_IMPORT, (_match, quote, url) => `@import ${quote}${rewriteUrl(url, page)}${quote}`);
}

/* ---------- HTML ---------- */

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'xlink:href']);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset', 'data-srcset']);
// Scripts copy these into src (lazy loading) or location (clickable rows) later. Only
// full or root-relative URLs are rewritten, since sites also use these names for things
// that aren't links.
const LAZY_ATTRS = new Set([
  'data-src',
  'data-lazy-src',
  'data-original',
  'data-bg',
  'data-background',
  'data-poster',
  'data-href',
  'data-url',
  'data-link',
]);
const BLANK_TARGET = /^\s*_(blank|top|parent|new)\s*$/i;
const DROPPED_META = /^(content-security-policy(-report-only)?|x-frame-options)$/i;

const escapeAttribute = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const runtimeTag = (cookies) => `<script src="${RUNTIME_SRC}" data-cookies="${escapeAttribute(cookies)}"></script>`;

function attr(tag, name) {
  return tag.attrs.find((entry) => entry.name === name)?.value;
}

/** <meta http-equiv="refresh" content="5; url=/next"> */
function rewriteRefresh(content, page) {
  return content.replace(
    /^(\s*[\d.]+\s*[;,]\s*(?:url\s*=\s*)?)(['"]?)(.*?)\2(\s*)$/i,
    (_match, lead, quote, url, tail) => `${lead}${quote}${rewriteUrl(url, page)}${quote}${tail}`,
  );
}

/**
 * Rewrites one start tag's links in place. Returns 'drop' for tags to leave out, true
 * when something changed (so the tag is serialised again), false to keep it as written.
 */
function rewriteTag(tag, page) {
  if (tag.tagName === 'meta') {
    const equiv = attr(tag, 'http-equiv') ?? '';
    if (DROPPED_META.test(equiv.trim())) return 'drop';
    // Keep the server's no-referrer policy: page addresses carry the token.
    if ((attr(tag, 'name') ?? '').toLowerCase() === 'referrer') return 'drop';
  }

  let changed = false;
  const attrs = [];
  for (const entry of tag.attrs) {
    const { name } = entry;
    let { value } = entry;
    if (name === 'integrity' || name === 'ping') {
      changed = true;
      continue;
    }
    if (URL_ATTRS.has(name) || (name === 'data' && tag.tagName === 'object')) {
      value = rewriteUrl(value, page);
    } else if (SRCSET_ATTRS.has(name)) {
      value = rewriteSrcset(value, (url) => rewriteUrl(url, page));
    } else if (LAZY_ATTRS.has(name) && /^\s*(https?:)?\/[^\s]/i.test(value)) {
      value = rewriteUrl(value, page);
    } else if (name === 'value' && tag.tagName === 'option' && /^\s*https?:\/\//i.test(value)) {
      // Episode and server pickers: <select onchange="location = this.value">.
      value = rewriteUrl(value, page);
    } else if (name === 'style') {
      value = rewriteCss(value, page);
    } else if (name === 'target' && BLANK_TARGET.test(value)) {
      // New tabs and windows can't open from the activity; open links in place.
      value = '_self';
    } else if (name === 'content' && tag.tagName === 'meta' && /^\s*refresh\s*$/i.test(attr(tag, 'http-equiv') ?? '')) {
      value = rewriteRefresh(value, page);
    }
    if (value !== entry.value) changed = true;
    attrs.push({ ...entry, value });
  }
  if (changed) tag.attrs = attrs;
  return changed;
}

function rewriteHtml(html, pageUrl, token, cookies) {
  return new Promise((resolve, reject) => {
    const rewriter = new RewritingStream();
    const chunks = [];
    const page = { token, base: pageUrl, from: pageUrl.origin };
    let baseSeen = false;
    let inStyle = false;
    let injected = false;

    // The runtime has to run before any of the page's own scripts.
    const inject = () => {
      if (injected) return;
      injected = true;
      rewriter.emitRaw(runtimeTag(cookies));
    };

    rewriter.on('startTag', (tag, raw) => {
      const name = tag.tagName;
      if (name !== 'html' && name !== 'head') inject();
      if (name === 'base' && !baseSeen) {
        baseSeen = true;
        try {
          page.base = new URL(attr(tag, 'href') ?? '', pageUrl);
        } catch {
          // keep the page address
        }
      }
      const result = rewriteTag(tag, page);
      if (result === true) rewriter.emitStartTag(tag);
      else if (result !== 'drop') rewriter.emitRaw(raw);
      if (name === 'head') inject();
      if (name === 'style' && !tag.selfClosing) inStyle = true;
    });
    rewriter.on('endTag', (tag, raw) => {
      if (tag.tagName === 'style') inStyle = false;
      rewriter.emitRaw(raw);
    });
    rewriter.on('text', (_text, raw) => {
      rewriter.emitRaw(inStyle ? rewriteCss(raw, page) : raw);
    });

    rewriter.setEncoding('utf8');
    rewriter.on('data', (chunk) => chunks.push(chunk));
    rewriter.on('end', () => {
      const output = chunks.join('');
      resolve(injected ? output : runtimeTag(cookies) + output);
    });
    rewriter.on('error', reject);
    rewriter.end(html);
  });
}

/** Text in the charset the response names (header, then <meta>), defaulting to UTF-8. */
function decodePage(buffer, contentType, sniffMeta) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  let label = /charset\s*=\s*["']?([\w:.-]+)/i.exec(contentType)?.[1];
  if (!label && sniffMeta) {
    const head = buffer.subarray(0, 4096).toString('latin1');
    label = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/* ---------- Cookies ---------- */

// Websites keep their cookies here, one jar per token, so logins and settings work
// while browsing in the activity.
const jars = new Map();
const JAR_IDLE_MS = 12 * 3600 * 1000;
const MAX_COOKIES_PER_JAR = 300;

function jarFor(token) {
  let jar = jars.get(token);
  if (!jar) {
    jar = { cookies: new Map(), used: 0 };
    jars.set(token, jar);
  }
  jar.used = Date.now();
  return jar;
}

setInterval(() => {
  const cutoff = Date.now() - JAR_IDLE_MS;
  for (const [token, jar] of jars) {
    if (jar.used < cutoff) jars.delete(token);
  }
}, 3600 * 1000).unref();

function defaultCookiePath(url) {
  const slash = url.pathname.lastIndexOf('/');
  return slash <= 0 ? '/' : url.pathname.slice(0, slash);
}

/** Store one Set-Cookie value (or one document.cookie assignment, with `fromScript`). */
function storeCookie(jar, line, url, { fromScript = false } = {}) {
  const [pair, ...attributes] = String(line).split(';');
  const eq = pair.indexOf('=');
  if (eq < 1) return;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name || value.length > 4096) return;

  const host = url.hostname.toLowerCase();
  let domain = host;
  let hostOnly = true;
  let cookiePath = defaultCookiePath(url);
  let maxAge = null;
  let expiresAt = null;
  let httpOnly = false;
  for (const attribute of attributes) {
    const split = attribute.indexOf('=');
    const key = (split === -1 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
    const attrValue = split === -1 ? '' : attribute.slice(split + 1).trim();
    if (key === 'domain' && attrValue) {
      const wanted = attrValue.replace(/^\./, '').toLowerCase();
      if (!wanted.includes('.') || (host !== wanted && !host.endsWith(`.${wanted}`))) return;
      domain = wanted;
      hostOnly = false;
    } else if (key === 'path' && attrValue.startsWith('/')) {
      cookiePath = attrValue;
    } else if (key === 'max-age' && /^-?\d+$/.test(attrValue)) {
      maxAge = Number(attrValue);
    } else if (key === 'expires') {
      const time = Date.parse(attrValue);
      if (!Number.isNaN(time)) expiresAt = time;
    } else if (key === 'httponly') {
      httpOnly = true;
    }
  }

  const id = `${domain};${cookiePath};${name}`;
  if (fromScript && (httpOnly || jar.cookies.get(id)?.httpOnly)) return;
  const expires = maxAge !== null ? Date.now() + maxAge * 1000 : (expiresAt ?? Infinity);
  jar.cookies.delete(id);
  if (expires <= Date.now()) return;
  jar.cookies.set(id, { name, value, domain, hostOnly, path: cookiePath, expires, httpOnly });
  if (jar.cookies.size > MAX_COOKIES_PER_JAR) jar.cookies.delete(jar.cookies.keys().next().value);
}

/** The Cookie header for a request to `url` (only what scripts may read, with `forScript`). */
function cookiesFor(jar, url, { forScript = false } = {}) {
  const host = url.hostname.toLowerCase();
  const now = Date.now();
  const found = [];
  for (const [id, cookie] of jar.cookies) {
    if (cookie.expires <= now) {
      jar.cookies.delete(id);
      continue;
    }
    if (forScript && cookie.httpOnly) continue;
    const domainOk = cookie.hostOnly ? host === cookie.domain : host === cookie.domain || host.endsWith(`.${cookie.domain}`);
    const prefix = cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`;
    if (!domainOk || (url.pathname !== cookie.path && !url.pathname.startsWith(prefix))) continue;
    found.push(cookie);
  }
  found.sort((a, b) => b.path.length - a.path.length);
  return found.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** POST /api/web/<token>/_cookie: a page's script set a cookie (sent by web-runtime.js). */
export function handleWebCookie(req, res) {
  const { token } = req.params;
  if (!verifyWebToken(token)) {
    res.status(403).end();
    return;
  }
  let data;
  let url;
  try {
    data = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
    url = new URL(data.url);
  } catch {
    res.status(400).end();
    return;
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && typeof data.cookie === 'string') {
    storeCookie(jarFor(token), data.cookie.slice(0, 8192), url, { fromScript: true });
  }
  res.status(204).end();
}

/* ---------- Requests ---------- */

const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'if-range',
  'pragma',
  'range',
  'user-agent',
];
// Sites send their own x- headers with AJAX requests (CSRF tokens and the like);
// these ones come from proxies in front of this server instead.
const PROXY_HEADERS = /^x-(forwarded|real-ip|discord|envoy|request-id|amzn|render|cloud|vercel)/i;
const PAGE_DESTINATIONS = new Set(['document', 'iframe', 'frame']);

function upstreamHeaders(req, target, jar, body) {
  const { url, from } = target;
  const headers = { 'accept-encoding': 'gzip, deflate, br' };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith('x-') && !PROXY_HEADERS.test(name)) headers[name] = value;
  }
  // The browser caches the rewritten page, so a page is always fetched in full.
  if (!PAGE_DESTINATIONS.has(req.headers['sec-fetch-dest'])) {
    for (const name of ['if-none-match', 'if-modified-since']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
  }
  headers.referer = `${from}/`;
  if (req.headers.origin || (req.method !== 'GET' && req.method !== 'HEAD')) headers.origin = from;
  const cookie = cookiesFor(jar, url);
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-length'] = String(body.length);
  return headers;
}

// Pages run in an opaque origin, so their fetches and fonts arrive as cross-origin
// requests from "null".
function setCors(req, res) {
  if (req.headers.origin !== 'null') return;
  res.set({
    'access-control-allow-origin': 'null',
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': 'content-length, content-range, content-type, accept-ranges, etag, last-modified',
    vary: 'origin',
  });
}

const PASSED_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'expires',
  'last-modified',
];
const REWRITTEN_RESPONSE_HEADERS = new Set(['cache-control', 'content-language', 'expires']);

function describeError(error) {
  if (error.expose) return error.message;
  const code = error.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "That website's address couldn't be found.";
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') return "The website didn't answer.";
  if (/CERT|SSL|TLS/i.test(code)) return "The website's security certificate isn't valid.";
  return `Couldn't reach the website (${code || error.message}).`;
}

function errorPage(url, message, token) {
  const address = url ? escapeHtml(url.href) : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${token ? runtimeTag('') : ''}<title>Can't open this page</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#160d17;color:#f6eadb;font:15px/1.5 system-ui,sans-serif}main{max-width:460px;padding:24px;text-align:center}h1{margin:0 0 8px;font-size:22px}p{margin:0 0 10px;color:#bfa9b9}code{word-break:break-all;font-size:12px}</style></head><body><main><h1>Can't open this page</h1><p>${escapeHtml(message)}</p><p><code>${address}</code></p></main></body></html>`;
}

function sendFailure(req, res, status, message, url = null, token = null) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // Headers copied from the website's response before it failed don't fit this one.
  for (const name of PASSED_RESPONSE_HEADERS) res.removeHeader(name);
  const isPage = PAGE_DESTINATIONS.has(req.headers['sec-fetch-dest']) || /text\/html/.test(req.headers.accept ?? '');
  res.status(status);
  if (!isPage) {
    res.type('text').send(message);
    return;
  }
  res.set({ 'content-security-policy': SANDBOX, 'referrer-policy': REFERRER_POLICY, 'cache-control': 'no-store' });
  res.type('html').send(errorPage(url, message, token));
}

function sendRewritten(req, res, text, type) {
  res.setHeader('content-type', `${type}; charset=utf-8`);
  res.setHeader('vary', 'accept-encoding');
  const body = Buffer.from(text, 'utf8');
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    res.setHeader('content-encoding', 'gzip');
    res.send(zlib.gzipSync(body, { level: 6 }));
  } else {
    res.send(body);
  }
}

/**
 * ALL /api/web/<token>/<scheme>/<host>/<path>
 * Fetches a website for the activity's browser and points its links back here.
 */
export async function handleWeb(req, res) {
  const target = parseWebPath(req.url);
  if (!target || !verifyWebToken(target.token)) {
    sendFailure(req, res, 403, 'This page link has expired. Open the website again from the activity.');
    return;
  }
  const { token, url } = target;

  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).set({
      'access-control-allow-methods': [...METHODS].join(', '),
      'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }
  if (!METHODS.has(req.method)) {
    res.status(405).end();
    return;
  }

  const jar = jarFor(token);
  const body = Buffer.isBuffer(req.body) && req.body.length && req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null;
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  let upstream;
  try {
    upstream = await request(url.href, {
      method: req.method,
      body,
      headers: upstreamHeaders(req, target, jar, body),
      signal: controller.signal,
      timeoutMs: 30000,
      timeoutMessage: 'The website took too long to respond.',
      followRedirects: false,
    });
  } catch (error) {
    if (!controller.signal.aborted) sendFailure(req, res, 502, describeError(error), url, token);
    return;
  }

  try {
    await respond(req, res, upstream, target, jar);
  } catch (error) {
    upstream.destroy();
    if (!controller.signal.aborted) sendFailure(req, res, 502, describeError(error), url, token);
  }
}

/** Send the website's response on to the browser, rewriting pages and stylesheets. */
async function respond(req, res, upstream, target, jar) {
  const { token, url, from } = target;
  for (const line of [upstream.headers['set-cookie'] ?? []].flat()) storeCookie(jar, line, url);

  const status = upstream.statusCode;
  const type = String(upstream.headers['content-type'] || '').toLowerCase();
  const isPage =
    /text\/html|application\/xhtml\+xml/.test(type) || (!type && PAGE_DESTINATIONS.has(req.headers['sec-fetch-dest']));
  const isCss = type.startsWith('text/css');
  const length = Number(upstream.headers['content-length']) || 0;
  const rewrite = (isPage || isCss) && length <= MAX_REWRITE_BYTES && ![204, 206, 304].includes(status);

  res.status(status);
  res.set({ 'content-security-policy': SANDBOX, 'referrer-policy': REFERRER_POLICY });
  for (const name of PASSED_RESPONSE_HEADERS) {
    if (upstream.headers[name] == null || (rewrite && !REWRITTEN_RESPONSE_HEADERS.has(name))) continue;
    res.setHeader(name, upstream.headers[name]);
  }
  if (upstream.headers.location) {
    try {
      res.setHeader('location', webPath(token, unwrapRedirect(new URL(upstream.headers.location, url)), from));
    } catch {
      // an invalid redirect target: leave it out
    }
  }
  const page = { token, base: url, from: url.origin };
  if (upstream.headers.refresh) res.setHeader('refresh', rewriteRefresh(String(upstream.headers.refresh), page));
  if (isPage) res.setHeader('cache-control', 'no-cache');

  if (req.method === 'HEAD' || !rewrite) {
    if (req.method === 'HEAD') {
      upstream.resume();
      res.end();
      return;
    }
    pipeline(upstream, res, () => {
      // Cancelled downloads (seeking a video, leaving a page) end up here.
    });
    return;
  }

  const buffer = await readBody(decodedStream(upstream), MAX_REWRITE_BYTES);
  if (isPage) {
    const html = decodePage(buffer, type, true);
    sendRewritten(req, res, await rewriteHtml(html, url, token, cookiesFor(jar, url, { forScript: true })), 'text/html');
  } else {
    sendRewritten(req, res, rewriteCss(decodePage(buffer, type, false), page), 'text/css');
  }
}

/**
 * A page's script went to "/path" with location.href, so the frame left /api/web and
 * landed on this server's root. Answer with just the runtime: it asks the activity,
 * which knows the site the frame was on, to open the path there.
 */
export function handleStrayWebNavigation(req, res, next) {
  if (req.method !== 'GET' || req.headers['sec-fetch-dest'] !== 'iframe' || req.path.startsWith('/api/')) return next();
  // Discord loads the activity itself in a frame too, always with ?frame_id=.
  if (req.path === '/' && 'frame_id' in req.query) return next();
  res.set({ 'content-security-policy': SANDBOX, 'referrer-policy': REFERRER_POLICY, 'cache-control': 'no-store' });
  res.type('html').send(`<!doctype html><meta charset="utf-8">${runtimeTag('')}`);
}

/** GET /api/web-runtime.js: the script added to every page (see web-runtime.js). */
export function handleWebRuntime(_req, res) {
  res.sendFile(RUNTIME_FILE, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
}

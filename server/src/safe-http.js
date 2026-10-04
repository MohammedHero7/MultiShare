// Fetches remote media on behalf of the activity.
//
// Discord Activities can only talk to their own origin, so every video byte flows
// through this server. Because the server fetches links that people paste, it
// refuses private/local network addresses (unless ALLOW_PRIVATE_URLS=true) and
// checks the address at connect time, after every redirect.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { config } from './config.js';
import { UserError } from './errors.js';

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
]) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 127], // unspecified + loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['ff00::', 8], // multicast
]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

const PRIVATE_MESSAGE = 'Links to private or local network addresses are blocked on this server.';

export function isBlockedAddress(ip) {
  if (config.allowPrivateUrls) return false;
  const family = net.isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

function guardedLookup(hostname, options, callback) {
  const lookupOptions = { all: true };
  if (options?.family) lookupOptions.family = options.family;
  if (options?.hints) lookupOptions.hints = options.hints;

  dns.lookup(hostname, lookupOptions, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter((entry) => !isBlockedAddress(entry.address));
    if (allowed.length === 0) {
      const error = new UserError(PRIVATE_MESSAGE);
      error.code = 'EBLOCKED';
      return callback(error);
    }
    if (options?.all) return callback(null, allowed);
    return callback(null, allowed[0].address, allowed[0].family);
  });
}

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 32, lookup: guardedLookup }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 32, lookup: guardedLookup }),
};

/** Validates a link someone pasted and returns it as a URL object. */
export function parseUserUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new UserError("That doesn't look like a valid link.");
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UserError('Only http:// and https:// links are supported.');
  }
  // IP literals skip DNS, so they're checked here instead of in guardedLookup.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(host) && isBlockedAddress(host)) throw new UserError(PRIVATE_MESSAGE);
  return url;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

/**
 * GET a URL, following up to 5 redirects. Resolves with the response stream once
 * headers arrive; `response.finalUrl` is the URL after redirects.
 */
export function request(rawUrl, { headers = {}, signal, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let hops = 0;

    const attempt = (target) => {
      let url;
      try {
        url = parseUserUrl(target);
      } catch (error) {
        reject(error);
        return;
      }

      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        url,
        {
          method: 'GET',
          headers: { 'user-agent': BROWSER_UA, accept: '*/*', ...headers },
          agent: agents[url.protocol],
          lookup: guardedLookup,
          signal,
        },
        (res) => {
          req.setTimeout(0);
          const location = res.headers.location;
          if (location && [301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            if (++hops > 5) {
              reject(new UserError('That link redirects too many times.'));
              return;
            }
            attempt(new URL(location, url).href);
            return;
          }
          res.finalUrl = url.href;
          resolve(res);
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new UserError('The video server took too long to respond.'));
      });
      req.on('error', reject);
      req.end();
    };

    attempt(rawUrl);
  });
}

/** Undo gzip/deflate/brotli if a server compressed a text response anyway. */
export function decodedStream(res) {
  const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return res.pipe(zlib.createInflate());
  if (encoding === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/**
 * Read a stream into a Buffer. With `truncate`, stops quietly after `limit` bytes;
 * otherwise a larger body is an error.
 */
export function readBody(stream, limit, { truncate = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const collected = () => Buffer.concat(chunks).subarray(0, limit);

    stream.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        if (truncate) done(resolve, collected());
        else done(reject, new UserError('That file is too large.'));
        stream.destroy();
      }
    });
    stream.on('end', () => done(resolve, collected()));
    stream.on('error', (error) => {
      if (truncate && size > 0) done(resolve, collected());
      else done(reject, error);
    });
    stream.on('close', () => {
      if (truncate) done(resolve, collected());
      else done(reject, new UserError('The connection closed before the file finished downloading.'));
    });
  });
}

/** Decode subtitle bytes: UTF-8/UTF-16 when marked, otherwise the configured fallback. */
export function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder(config.subtitleFallbackEncoding).decode(buffer);
  }
}

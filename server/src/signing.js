// Media links handed to the activity are signed, so /api/media and /api/file only
// serve things this server chose to load. Without this, anyone could use the
// server as an open proxy.

import crypto from 'node:crypto';
import { config } from './config.js';

function sign(value) {
  return crypto.createHmac('sha256', config.signingSecret).update(value).digest('base64url').slice(0, 32);
}

function matches(value, signature) {
  if (typeof value !== 'string' || typeof signature !== 'string') return false;
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Paths start with /.proxy/ because Discord only lets an activity reach its
// backend through that prefix. The server strips it again on arrival.
// A proxied link can carry the user agent the upstream server expects (some
// YouTube streams only work with the one that requested them).
const proxiedValue = (url, userAgent) => (userAgent ? `u:${url}\n${userAgent}` : `u:${url}`);

export const proxiedUrl = (url, userAgent = '') =>
  `/.proxy/api/media?u=${encodeURIComponent(url)}${userAgent ? `&a=${encodeURIComponent(userAgent)}` : ''}&s=${sign(proxiedValue(url, userAgent))}`;
export const libraryUrl = (relPath) => `/.proxy/api/file?p=${encodeURIComponent(relPath)}&s=${sign(`f:${relPath}`)}`;
export const youtubeUrl = (id) => `/.proxy/api/youtube?v=${encodeURIComponent(id)}&s=${sign(`y:${id}`)}`;

export const verifyProxied = (url, userAgent, signature) =>
  matches(typeof url === 'string' && typeof userAgent === 'string' ? proxiedValue(url, userAgent) : null, signature);
export const verifyLibrary = (relPath, signature) => matches(typeof relPath === 'string' ? `f:${relPath}` : null, signature);
export const verifyYouTube = (id, signature) => matches(typeof id === 'string' ? `y:${id}` : null, signature);

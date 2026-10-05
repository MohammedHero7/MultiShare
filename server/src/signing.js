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

// The activity's browser (web.js) gets a token when someone joins a room. It goes in
// every page address, so only people in the activity can open websites through it.
const WEB_TOKEN_TTL_S = 24 * 3600;

export function webToken() {
  const expires = (Math.floor(Date.now() / 1000) + WEB_TOKEN_TTL_S).toString(36);
  return `${expires}.${sign(`w:${expires}`)}`;
}

export function verifyWebToken(token) {
  const [expires, signature] = String(token ?? '').split('.');
  return matches(`w:${expires}`, signature) && Number.parseInt(expires, 36) * 1000 > Date.now();
}

export const verifyProxied = (url, userAgent, signature) =>
  matches(typeof url === 'string' && typeof userAgent === 'string' ? proxiedValue(url, userAgent) : null, signature);
export const verifyLibrary = (relPath, signature) => matches(typeof relPath === 'string' ? `f:${relPath}` : null, signature);
export const verifyYouTube = (id, signature) => matches(typeof id === 'string' ? `y:${id}` : null, signature);

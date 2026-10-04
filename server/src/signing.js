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
export const proxiedUrl = (url) => `/.proxy/api/media?u=${encodeURIComponent(url)}&s=${sign(`u:${url}`)}`;
export const libraryUrl = (relPath) => `/.proxy/api/file?p=${encodeURIComponent(relPath)}&s=${sign(`f:${relPath}`)}`;

export const verifyProxied = (url, signature) => matches(typeof url === 'string' ? `u:${url}` : null, signature);
export const verifyLibrary = (relPath, signature) => matches(typeof relPath === 'string' ? `f:${relPath}` : null, signature);

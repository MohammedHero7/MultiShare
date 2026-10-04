import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '../..');

// One .env file at the project root is shared by the client and the server.
dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const env = (name, fallback = '') => (process.env[name] ?? fallback).trim();
const flag = (name) => /^(1|true|yes|on)$/i.test(env(name));

function pickEncoding(name) {
  try {
    new TextDecoder(name);
    return name;
  } catch {
    console.warn(`[config] Unknown SUBTITLE_FALLBACK_ENCODING "${name}", using windows-1252.`);
    return 'windows-1252';
  }
}

export const config = {
  port: Number(env('PORT')) || 3001,
  clientId: env('VITE_DISCORD_CLIENT_ID') || env('DISCORD_CLIENT_ID'),
  clientSecret: env('DISCORD_CLIENT_SECRET'),
  publicKey: env('DISCORD_PUBLIC_KEY'),
  mediaDir: env('MEDIA_DIR') ? path.resolve(ROOT_DIR, env('MEDIA_DIR')) : '',
  allowGuests: flag('ALLOW_GUESTS'),
  allowPrivateUrls: flag('ALLOW_PRIVATE_URLS'),
  subtitleFallbackEncoding: pickEncoding(env('SUBTITLE_FALLBACK_ENCODING', 'windows-1256') || 'windows-1256'),
  signingSecret: env('MEDIA_SIGNING_SECRET') || crypto.randomBytes(32).toString('hex'),
  clientDist: path.join(ROOT_DIR, 'client', 'dist'),
};

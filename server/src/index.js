import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { exchangeCode } from './discord.js';
import { handleInteraction } from './interactions.js';
import { handleFile } from './library.js';
import { handleMedia } from './media.js';
import { attachSockets } from './rooms.js';
import { handleThumbnail, handleYouTube, logYouTubeSupport } from './youtube.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Inside Discord, requests arrive with /.proxy already stripped. In a normal
// browser they still have it, so strip it here and the same routes work for both.
app.use((req, _res, next) => {
  if (req.url.startsWith('/.proxy/')) req.url = req.url.slice('/.proxy'.length);
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Interactions need the raw body to verify Discord's signature.
app.post('/api/interactions', express.raw({ type: '*/*', limit: '1mb' }), handleInteraction);

app.post('/api/token', express.json({ limit: '10kb' }), async (req, res) => {
  try {
    const accessToken = await exchangeCode(req.body?.code);
    res.json({ access_token: accessToken });
  } catch (error) {
    if (!error.expose) console.error('[token]', error);
    res.status(400).json({ error: error.expose ? error.message : 'Sign-in failed.' });
  }
});

app.get('/api/media', handleMedia);
app.get('/api/file', handleFile);
app.get('/api/youtube', handleYouTube);
app.get('/api/thumb', handleThumbnail);

// In production the server also serves the built activity (client/dist).
const indexHtml = path.join(config.clientDist, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(
    express.static(config.clientDist, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  app.get('/', (_req, res) => res.sendFile(indexHtml));
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const server = http.createServer(app);
attachSockets(server);

server.listen(config.port, () => {
  console.log(`Watch party server on http://localhost:${config.port}`);
  if (!config.clientId || !config.clientSecret) {
    console.warn('  ! VITE_DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET are missing in .env, so Discord sign-in will fail.');
  }
  if (fs.existsSync(indexHtml)) console.log('  Serving the built activity from client/dist');
  if (config.mediaDir) console.log(`  Library folder: ${config.mediaDir}`);
  if (config.publicKey) console.log('  /watch command endpoint: /api/interactions');
  if (config.allowGuests) console.log('  Browser testing is ON (ALLOW_GUESTS=true). Turn it off when deployed.');
  logYouTubeSupport();
});

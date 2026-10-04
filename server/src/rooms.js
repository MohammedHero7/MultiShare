// Every activity instance (one per voice channel session) gets a room. The room
// holds the authoritative playback state; clients follow it and send commands.
//
// Playback state is a "reference point": { paused, position, updatedAt }.
// While playing, the current time is position + (now - updatedAt). Clients sync
// their clocks to the server, so everyone computes the same moment of the video.

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { getUser } from './discord.js';
import { UserError } from './errors.js';
import { assertLibraryVideo, libraryEnabled, listLibrary, readLibrarySubtitle, siblingSubtitles } from './library.js';
import { fetchSubtitleUrl, prettyName, probeUrl, titleFromUrl } from './media.js';
import { libraryUrl, proxiedUrl } from './signing.js';

const rooms = new Map();
const pendingWatch = new Map(); // userId -> { url, channelId, expires } from the /watch command

const ROOM_TTL_MS = 10 * 60 * 1000;
const MAX_SUBTITLE_CHARS = 3_000_000;

const cleanPosition = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(number, 48 * 3600);
};

class Room {
  constructor(id) {
    this.id = id;
    this.clients = new Set();
    this.channelId = null;
    this.media = null;
    this.subs = null;
    this.subsSeq = 0;
    this.paused = true;
    this.position = 0;
    this.updatedAt = Date.now();
    this.seq = 0;
    this.loadSeq = 0;
    this.expiry = null;
  }

  add(client, channelId) {
    clearTimeout(this.expiry);
    if (channelId && !this.channelId) this.channelId = String(channelId);
    this.clients.add(client);
    client.room = this;

    client.send({
      t: 'welcome',
      you: client.user,
      state: this.state(),
      users: this.users(),
      library: libraryEnabled(),
      encoding: config.subtitleFallbackEncoding,
      serverTime: Date.now(),
    });
    if (this.subs) client.send({ t: 'subs', subs: this.subs });
    this.broadcast({ t: 'presence', users: this.users(), joined: client.user }, client);

    const queued = takePendingWatch(client.user.id);
    if (queued) {
      this.load({ url: queued.url }, client.user).catch((error) => {
        client.send({ t: 'error', context: 'load', message: error.expose ? error.message : 'Could not load that link.' });
      });
    }
  }

  remove(client) {
    if (!this.clients.delete(client)) return;
    this.broadcast({ t: 'presence', users: this.users() });
    if (this.clients.size === 0) {
      this.expiry = setTimeout(() => {
        if (this.clients.size === 0) rooms.delete(this.id);
      }, ROOM_TTL_MS);
    }
  }

  users() {
    const unique = new Map();
    for (const client of this.clients) unique.set(client.user.id, client.user);
    return [...unique.values()];
  }

  currentPosition() {
    return this.paused ? this.position : this.position + (Date.now() - this.updatedAt) / 1000;
  }

  state() {
    return {
      seq: this.seq,
      media: this.media && {
        title: this.media.title,
        kind: this.media.kind,
        src: this.media.src,
        source: this.media.source,
        link: this.media.source === 'url' ? this.media.url : null,
        path: this.media.source === 'library' ? this.media.path : null,
      },
      paused: this.paused,
      position: this.position,
      updatedAt: this.updatedAt,
    };
  }

  broadcast(message, except) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client !== except) client.sendRaw(data);
    }
  }

  publish(action, by, extra = {}) {
    this.seq += 1;
    this.broadcast({ t: 'state', state: this.state(), action, by: by && { id: by.id, name: by.name }, ...extra });
  }

  /** Load a link or a library file for everyone. Starts paused at 0:00. */
  async load(source, by) {
    const ticket = ++this.loadSeq;
    let media;
    if (source.path) {
      await assertLibraryVideo(source.path);
      const name = source.path.split('/').pop();
      media = { source: 'library', path: source.path, title: prettyName(name), kind: 'file', src: libraryUrl(source.path) };
    } else {
      const probe = await probeUrl(source.url);
      media = {
        source: 'url',
        url: String(source.url).trim(),
        title: titleFromUrl(probe.finalUrl),
        kind: probe.kind,
        src: proxiedUrl(String(source.url).trim()),
      };
    }
    if (ticket !== this.loadSeq) throw new UserError('Someone else loaded a video at the same moment.');

    this.media = media;
    this.paused = true;
    this.position = 0;
    this.updatedAt = Date.now();
    this.subs = null;
    this.broadcast({ t: 'subs', subs: null });
    this.publish('load', by);

    // Library videos pick up a matching subtitle file automatically (Movie.srt, Movie.ar.srt, ...).
    if (media.source === 'library') {
      const [first] = await siblingSubtitles(media.path);
      if (first && ticket === this.loadSeq) {
        await this.setSubtitles(await readLibrarySubtitle(first), null).catch(() => {});
      }
    }
  }

  async setSubtitles(subtitle, by) {
    if (!subtitle) {
      this.subs = null;
      this.broadcast({ t: 'subs', subs: null, by: by && { id: by.id, name: by.name } });
      return;
    }
    const text = String(subtitle.text ?? '');
    if (text.length > MAX_SUBTITLE_CHARS) throw new UserError('That subtitle file is too large.');
    if (!/-->/.test(text)) throw new UserError("That file doesn't look like .srt or .vtt subtitles.");
    this.subs = { id: ++this.subsSeq, name: String(subtitle.name || 'Subtitles').slice(0, 120), text };
    this.broadcast({ t: 'subs', subs: this.subs, by: by && { id: by.id, name: by.name } });
  }

  async handle(client, message) {
    const user = client.user;
    switch (message.t) {
      case 'load': {
        if (typeof message.path === 'string') return this.load({ path: message.path }, user);
        if (typeof message.url === 'string') return this.load({ url: message.url }, user);
        throw new UserError('Paste a link first.');
      }
      case 'play':
      case 'pause':
      case 'seek': {
        if (!this.media) return undefined;
        if (message.t !== 'seek') this.paused = message.t === 'pause';
        this.position = cleanPosition(message.position);
        this.updatedAt = Date.now();
        this.publish(message.t, user);
        return undefined;
      }
      case 'subs': {
        if (message.clear) return this.setSubtitles(null, user);
        if (typeof message.url === 'string') return this.setSubtitles(await fetchSubtitleUrl(message.url), user);
        if (typeof message.path === 'string') return this.setSubtitles(await readLibrarySubtitle(message.path), user);
        if (typeof message.text === 'string') return this.setSubtitles({ text: message.text, name: message.name }, user);
        throw new UserError('Choose subtitles to add.');
      }
      case 'library': {
        client.send({ t: 'library', files: await listLibrary() });
        return undefined;
      }
      default:
        return undefined;
    }
  }
}

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = new Room(id);
    rooms.set(id, room);
  }
  return room;
}

function takePendingWatch(userId) {
  const entry = pendingWatch.get(userId);
  if (!entry) return null;
  pendingWatch.delete(userId);
  return entry.expires > Date.now() ? entry : null;
}

/**
 * Called by the /watch slash command. If the activity is already open in that
 * channel, the video loads right away; otherwise it waits for the person who ran
 * the command to open the activity.
 */
export function queueWatch({ url, userId, userName, channelId }) {
  let applied = false;
  for (const room of rooms.values()) {
    if (channelId && room.channelId === channelId && room.clients.size > 0) {
      applied = true;
      room.load({ url }, { id: userId, name: userName }).catch((error) => {
        room.broadcast({ t: 'error', context: 'load', message: error.expose ? error.message : 'Could not load that link.' });
      });
    }
  }
  if (!applied) pendingWatch.set(userId, { url, channelId, expires: Date.now() + 5 * 60 * 1000 });
  return applied;
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.user = null;
    this.room = null;
    this.joining = false;
    this.windowStart = Date.now();
    this.windowCount = 0;

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.room?.remove(this));
    ws.on('error', () => {});
    this.joinTimer = setTimeout(() => {
      if (!this.user) ws.close(4000, 'join timeout');
    }, 20000);
  }

  sendRaw(data) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(data);
  }

  send(message) {
    this.sendRaw(JSON.stringify(message));
  }

  async onMessage(data) {
    const now = Date.now();
    if (now - this.windowStart > 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (++this.windowCount > 60) return;

    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.t === 'ping') {
      this.send({ t: 'pong', c: message.c, s: Date.now() });
      return;
    }
    if (message.t === 'join') {
      await this.join(message);
      return;
    }
    if (!this.room) return;

    try {
      await this.room.handle(this, message);
    } catch (error) {
      if (!error.expose) console.error('[rooms]', error);
      this.send({
        t: 'error',
        context: message.t,
        message: error.expose ? error.message : 'Something went wrong on the server.',
      });
    }
  }

  async join(message) {
    if (this.user || this.joining) return;
    this.joining = true;
    try {
      const instanceId = String(message.instanceId || '').slice(0, 200);
      if (!instanceId) throw new UserError('Missing activity instance.');

      if (typeof message.accessToken === 'string' && message.accessToken) {
        if (instanceId.startsWith('guest:')) throw new UserError('Invalid room.');
        this.user = await getUser(message.accessToken);
      } else if (typeof message.guest === 'string') {
        if (!config.allowGuests) {
          throw new UserError('Browser testing is off. Set ALLOW_GUESTS=true in .env, or open the activity from Discord.');
        }
        if (!instanceId.startsWith('guest:')) throw new UserError('Invalid room.');
        const name = message.guest.trim().slice(0, 32) || 'Guest';
        this.user = { id: `guest-${crypto.randomUUID().slice(0, 8)}`, name, avatar: null, guest: true };
      } else {
        throw new UserError('Sign-in is missing. Close and reopen the activity.');
      }

      clearTimeout(this.joinTimer);
      getRoom(instanceId).add(this, message.channelId);
    } catch (error) {
      if (!error.expose) console.error('[rooms] join failed', error);
      this.send({ t: 'fatal', message: error.expose ? error.message : 'Could not join the watch party.' });
      this.ws.close(4001, 'join failed');
    } finally {
      this.joining = false;
    }
  }
}

/** Accept WebSocket upgrades on /api/ws (or /.proxy/api/ws when hit directly). */
export function attachSockets(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      // fall through to destroy
    }
    if (pathname.startsWith('/.proxy/')) pathname = pathname.slice('/.proxy'.length);
    if (pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => new Client(ws));

  // Drop connections that stopped answering (closed laptops, lost Wi-Fi).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  return wss;
}

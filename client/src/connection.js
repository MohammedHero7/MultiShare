// WebSocket link to the server, with automatic reconnects and a clock offset
// estimate so every client agrees on "now" (needed to compute the playhead).

export class Connection {
  constructor({ instanceId, channelId, credentials }) {
    this.instanceId = instanceId;
    this.channelId = channelId;
    this.credentials = credentials;
    this.handlers = new Map();
    this.ws = null;
    this.attempt = 0;
    this.stopped = false;
    this.samples = [];
    this.offset = 0;
    this.pingTimer = null;
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
    return this;
  }

  emit(type, payload) {
    for (const handler of this.handlers.get(type) ?? []) handler(payload);
  }

  connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/.proxy/api/ws`);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      ws.send(
        JSON.stringify({ t: 'join', instanceId: this.instanceId, channelId: this.channelId, ...this.credentials }),
      );
      this.startClockSync();
    });

    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.t === 'pong') {
        this.recordPong(message);
        return;
      }
      if (message.t === 'welcome') {
        // Rough offset until the first ping comes back.
        if (this.samples.length === 0) this.offset = message.serverTime - Date.now();
        this.emit('status', 'online');
      }
      if (message.t === 'fatal') this.stopped = true;
      this.emit(message.t, message);
    });

    ws.addEventListener('close', () => {
      clearTimeout(this.pingTimer);
      if (this.ws !== ws || this.stopped) return;
      this.emit('status', 'reconnecting');
      const delay = Math.min(8000, 500 * 2 ** this.attempt);
      this.attempt += 1;
      setTimeout(() => this.connect(), delay);
    });
  }

  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  startClockSync() {
    clearTimeout(this.pingTimer);
    let count = 0;
    const ping = () => {
      this.send({ t: 'ping', c: Date.now() });
      count += 1;
      this.pingTimer = setTimeout(ping, count < 6 ? 250 : 10000);
    };
    ping();
  }

  recordPong({ c, s }) {
    const now = Date.now();
    const rtt = now - c;
    if (!(rtt >= 0 && rtt < 10000)) return;
    this.samples.push({ rtt, offset: s + rtt / 2 - now });
    if (this.samples.length > 12) this.samples.shift();
    // The sample with the shortest round trip has the least uncertainty.
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
  }

  serverNow() {
    return Date.now() + this.offset;
  }
}

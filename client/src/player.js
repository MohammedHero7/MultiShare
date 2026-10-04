// Loads the shared video and keeps the local playhead on the shared timeline.
//
// Small drift is corrected by nudging playbackRate (inaudible), large drift by
// seeking. Autoplay rules are handled by falling back to muted playback and,
// if even that's blocked, asking for one tap.

import { clamp } from './format.js';

// hls.js is large, so it's only downloaded when someone loads an .m3u8 stream.
let hlsModule = null;
const loadHls = () => (hlsModule ??= import('hls.js').then((module) => module.default));

const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;
const HARD_DRIFT = 1.2; // seconds off before we jump
const SOFT_DRIFT = 0.2; // seconds off before we start nudging the rate
const SETTLED = 0.06; // close enough to stop nudging

export class Player {
  constructor(video, serverNow) {
    this.video = video;
    this.serverNow = serverNow;
    this.state = null;
    this.src = null;
    this.hls = null;
    this.handlers = new Map();
    this.blocked = false;
    this.mutedByPolicy = false;
    this.playRequest = false;
    this.nudging = false;

    video.addEventListener('loadedmetadata', () => this.sync(true));
    video.addEventListener('canplay', () => this.sync(false));
    video.addEventListener('error', () => this.onVideoError());
    setInterval(() => this.correctDrift(), 500);
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
    return this;
  }

  emit(type, payload) {
    for (const handler of this.handlers.get(type) ?? []) handler(payload);
  }

  get hasMedia() {
    return Boolean(this.state?.media);
  }

  get duration() {
    const { duration } = this.video;
    return Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  }

  /** Where the shared timeline says we should be right now. */
  expectedTime() {
    const state = this.state;
    if (!state) return 0;
    if (state.paused) return state.position;
    return state.position + Math.max(0, this.serverNow() - state.updatedAt) / 1000;
  }

  /** Where the local video is (falls back to the shared timeline while loading). */
  currentTime() {
    return this.video.readyState >= HAVE_METADATA ? this.video.currentTime : this.expectedTime();
  }

  get ended() {
    if (!this.hasMedia || this.state.paused) return this.video.ended;
    return this.expectedTime() >= this.duration - 0.25;
  }

  /** Apply authoritative state from the server. */
  setState(state) {
    this.state = state;
    const src = state?.media?.src ?? null;
    if (src !== this.src) this.load(state?.media ?? null);
    this.sync(true);
  }

  /** Optimistic local update while the server confirms. */
  applyLocal(partial) {
    if (!this.state) return;
    this.state = { ...this.state, ...partial, updatedAt: this.serverNow() };
    this.sync(true);
  }

  load(media) {
    this.destroyHls();
    const video = this.video;
    video.playbackRate = 1;
    this.nudging = false;
    this.src = media?.src ?? null;

    if (!media) {
      video.removeAttribute('src');
      video.load();
      return;
    }

    this.emit('loading');
    if (media.kind === 'hls') {
      this.loadStream(media.src);
    } else {
      video.src = media.src;
    }
  }

  async loadStream(src) {
    let Hls;
    try {
      Hls = await loadHls();
    } catch {
      Hls = null;
    }
    if (this.src !== src) return; // another video was loaded meanwhile
    if (Hls?.isSupported()) {
      this.attachHls(Hls, src);
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = src;
    } else {
      this.emit('error', "This device can't play HLS streams. Try an .mp4 link instead.");
    }
  }

  attachHls(Hls, src) {
    const hls = new Hls({ maxBufferLength: 30, backBufferLength: 30 });
    this.hls = hls;
    let networkRetries = 0;
    let mediaRetries = 0;

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || this.hls !== hls) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
        networkRetries += 1;
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
        mediaRetries += 1;
        if (mediaRetries === 2) hls.swapAudioCodec();
        hls.recoverMediaError();
        return;
      }
      this.emit('error', describeHlsError(Hls, data));
      this.destroyHls();
    });
    hls.on(Hls.Events.FRAG_LOADED, () => {
      networkRetries = 0;
    });

    hls.loadSource(src);
    hls.attachMedia(this.video);
  }

  destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }

  onVideoError() {
    if (!this.src || this.hls) return;
    const code = this.video.error?.code;
    if (code === 1) return; // aborted on purpose
    const messages = {
      2: 'The video stopped downloading. Check that the link still works.',
      3: 'The video file is damaged or uses a format this device can’t decode.',
      4: 'This video format can’t play here. MP4 files with H.264 video and AAC audio work everywhere.',
    };
    this.emit('error', messages[code] ?? 'The video failed to play.');
  }

  /** Bring the local video in line with the shared state. `force` re-checks position. */
  sync(force) {
    const state = this.state;
    const video = this.video;
    if (!state?.media || video.readyState < HAVE_METADATA) return;

    const target = this.expectedTime();
    const duration = this.duration;

    if (state.paused) {
      if (!video.paused) video.pause();
      if (video.playbackRate !== 1) video.playbackRate = 1;
      this.nudging = false;
      if (Math.abs(video.currentTime - target) > 0.25 && !video.seeking) this.seekTo(Math.min(target, duration));
      return;
    }

    if (target >= duration - 0.25) {
      // The video is over for everyone; let it finish or rest on the last frame.
      if (!video.ended && !video.seeking && video.currentTime < duration - 1.5) this.seekTo(duration);
      return;
    }

    if (force && Math.abs(video.currentTime - target) > 0.4) this.seekTo(target, true);
    if (video.paused && !this.blocked) this.play();
  }

  correctDrift() {
    const state = this.state;
    const video = this.video;
    if (!state?.media || video.readyState < HAVE_METADATA) return;
    if (state.paused) {
      this.sync(false);
      return;
    }

    const target = this.expectedTime();
    if (target >= this.duration - 0.25) return;
    if (video.paused) {
      if (!this.blocked) this.play();
      return;
    }
    if (video.seeking || video.readyState < HAVE_FUTURE_DATA) return; // buffering; check again soon

    const drift = video.currentTime - target;
    const size = Math.abs(drift);
    if (size > HARD_DRIFT) {
      this.nudging = false;
      video.playbackRate = 1;
      this.seekTo(target, true);
    } else if (size > SOFT_DRIFT || (this.nudging && size > SETTLED)) {
      this.nudging = true;
      video.playbackRate = clamp(1 - drift * 0.5, 0.9, 1.1);
    } else if (this.nudging) {
      this.nudging = false;
      video.playbackRate = 1;
    }
  }

  seekTo(time, lead = false) {
    // While playing, aim a little ahead: the shared timeline keeps moving during the seek.
    const target = clamp(time + (lead ? 0.25 : 0), 0, this.duration);
    if (Number.isFinite(target)) this.video.currentTime = target;
  }

  async play() {
    if (this.playRequest) return;
    this.playRequest = true;
    const video = this.video;
    try {
      try {
        await video.play();
      } catch (error) {
        if (error.name !== 'NotAllowedError' || video.muted) throw error;
        // Sound needs a tap first. Play muted so the picture stays in sync meanwhile.
        video.muted = true;
        this.setMutedByPolicy(true);
        await video.play();
      }
      this.setBlocked(false);
    } catch (error) {
      if (error.name === 'NotAllowedError') this.setBlocked(true);
      // AbortError means a pause or a new source interrupted play(); the next sync retries.
    } finally {
      this.playRequest = false;
    }
  }

  /** Call from inside a click/tap handler: lifts autoplay restrictions. */
  userGesture() {
    if (this.mutedByPolicy) {
      this.video.muted = false;
      this.setMutedByPolicy(false);
    }
    if (this.blocked) {
      this.setBlocked(false);
      this.sync(true);
    }
  }

  setBlocked(value) {
    if (this.blocked === value) return;
    this.blocked = value;
    this.emit('blocked', value);
  }

  setMutedByPolicy(value) {
    if (this.mutedByPolicy === value) return;
    this.mutedByPolicy = value;
    this.emit('muted-by-policy', value);
  }
}

function describeHlsError(Hls, data) {
  if (data.details === 'manifestLoadError' || data.details === 'manifestLoadTimeOut') {
    return 'The stream’s playlist could not be loaded. The link may have expired.';
  }
  if (data.details === 'manifestIncompatibleCodecsError') {
    return 'This stream uses a video format this device can’t decode.';
  }
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) return 'The stream stopped loading. Check that the link still works.';
  return `This stream can’t play here (${data.details}).`;
}

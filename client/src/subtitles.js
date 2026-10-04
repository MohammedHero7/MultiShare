// Subtitles are rendered by us instead of <track>, which keeps styling consistent,
// supports Arabic/RTL lines per line, and allows a personal timing offset.

const TIMING =
  /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

const toSeconds = (h, m, s, ms) => Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

const cleanText = (text) =>
  text
    .replace(/<[^>]*>/g, '') // <i>, <b>, <font>, VTT voice tags
    .replace(/\{\\[^}]*\}/g, '') // {\an8} style overrides
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

/** Parse .srt or .vtt text into sorted cues: [{ start, end, lines }] */
export function parseSubtitles(text) {
  const cues = [];
  const blocks = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    if (timingIndex === -1) continue;
    const m = lines[timingIndex].match(TIMING);
    const start = toSeconds(m[1], m[2], m[3], m[4]);
    const end = toSeconds(m[5], m[6], m[7], m[8]);
    const body = cleanText(lines.slice(timingIndex + 1).join('\n'));
    if (!body || end <= start) continue;
    cues.push({ start, end, lines: body.split('\n').map((line) => line.trim()).filter(Boolean) });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** Read an uploaded subtitle file, guessing the encoding like the server does. */
export async function readSubtitleFile(file, fallbackEncoding = 'windows-1256') {
  if (file.size > 5 * 1024 * 1024) throw new Error('That subtitle file is too large (5 MB max).');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder(fallbackEncoding).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}

export class SubtitleRenderer {
  constructor(element, video) {
    this.element = element;
    this.video = video;
    this.cues = [];
    this.delay = 0;
    this.visible = true;
    this.lastKey = '';
    const loop = () => {
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setCues(cues) {
    this.cues = cues;
    this.lastKey = null;
  }

  setDelay(seconds) {
    this.delay = seconds;
    this.lastKey = null;
  }

  setVisible(visible) {
    this.visible = visible;
    this.lastKey = null;
  }

  render() {
    let key = '';
    let active = [];
    if (this.visible && this.cues.length && this.video.readyState >= 1) {
      const time = this.video.currentTime - this.delay;
      active = this.findActive(time);
      key = active.map((cue) => cue.start).join('|');
    }
    if (key === this.lastKey) return;
    this.lastKey = key;

    const blocks = active.map((cue) => {
      const block = document.createElement('div');
      block.className = 'subtitles__cue';
      for (const line of cue.lines) {
        const span = document.createElement('span');
        span.className = 'subtitles__line';
        span.dir = 'auto';
        span.textContent = line;
        block.append(span);
      }
      return block;
    });
    this.element.replaceChildren(...blocks);
  }

  findActive(time) {
    // Binary search for the last cue that starts before `time`, then look back for overlaps.
    const cues = this.cues;
    let low = 0;
    let high = cues.length - 1;
    let index = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start <= time) {
        index = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const active = [];
    for (let i = index; i >= 0 && i > index - 8; i -= 1) {
      if (cues[i].end > time) active.unshift(cues[i]);
    }
    return active;
  }
}

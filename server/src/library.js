// Optional: serve movies straight from a folder on the machine running the server.
// Enabled by setting MEDIA_DIR in .env.

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { UserError } from './errors.js';
import { decodeText } from './safe-http.js';
import { verifyLibrary } from './signing.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);
const MAX_FILES = 5000;
const MAX_DEPTH = 6;

let cache = { at: 0, files: [] };

export const libraryEnabled = () => Boolean(config.mediaDir);

/** List video and subtitle files under MEDIA_DIR as forward-slash relative paths. */
export async function listLibrary() {
  if (!config.mediaDir) return [];
  if (Date.now() - cache.at < 15000) return cache.files;

  const files = [];
  const walk = async (dir, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || files.length >= MAX_FILES) continue;
      const absolute = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(absolute);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        await walk(absolute, depth + 1);
      } else if (isFile) {
        const ext = path.extname(entry.name).toLowerCase();
        const kind = VIDEO_EXTENSIONS.has(ext) ? 'video' : SUBTITLE_EXTENSIONS.has(ext) ? 'subtitle' : null;
        if (kind) files.push({ path: path.relative(config.mediaDir, absolute).split(path.sep).join('/'), kind });
      }
    }
  };

  await walk(config.mediaDir, 0);
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  cache = { at: Date.now(), files };
  return files;
}

/** Turn a library-relative path into an absolute path, refusing anything outside MEDIA_DIR. */
export function resolveLibraryPath(relPath) {
  if (!config.mediaDir) throw new UserError('The library is turned off on this server.');
  if (typeof relPath !== 'string' || !relPath) throw new UserError('Pick a file from the library.');
  const root = path.resolve(config.mediaDir);
  const absolute = path.resolve(root, relPath);
  if (!absolute.startsWith(root + path.sep)) throw new UserError('That file is outside the library folder.');
  return absolute;
}

export async function assertLibraryVideo(relPath) {
  const absolute = resolveLibraryPath(relPath);
  if (!VIDEO_EXTENSIONS.has(path.extname(absolute).toLowerCase())) throw new UserError('That file is not a video.');
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw new UserError('That file no longer exists in the library.');
  }
  return absolute;
}

/** Subtitle files that sit next to a video and start with its name, e.g. Movie.ar.srt. */
export async function siblingSubtitles(videoRelPath) {
  const stem = videoRelPath.replace(/\.[^./]+$/, '').toLowerCase();
  const files = await listLibrary();
  return files.filter((file) => file.kind === 'subtitle' && file.path.toLowerCase().startsWith(stem)).map((file) => file.path);
}

export async function readLibrarySubtitle(relPath) {
  const absolute = resolveLibraryPath(relPath);
  if (!SUBTITLE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
    throw new UserError('Pick an .srt or .vtt file.');
  }
  let buffer;
  try {
    const stat = await fs.stat(absolute);
    if (stat.size > 5 * 1024 * 1024) throw new UserError('That subtitle file is too large.');
    buffer = await fs.readFile(absolute);
  } catch (error) {
    if (error.expose) throw error;
    throw new UserError('That subtitle file could not be read.');
  }
  return { name: path.basename(absolute), text: decodeText(buffer) };
}

/** GET /api/file?p=<relative path>&s=<signature> — streams a library file with Range support. */
export function handleFile(req, res) {
  const relPath = req.query.p;
  if (!verifyLibrary(relPath, req.query.s)) {
    res.status(403).type('text').send('This media link is invalid. Load the video again.');
    return;
  }
  let absolute;
  try {
    absolute = resolveLibraryPath(relPath);
  } catch {
    res.status(404).end();
    return;
  }

  const ext = path.extname(absolute).toLowerCase();
  const headers = {};
  // Chrome's Matroska support lives behind the WebM type; .mov is usually plain MP4.
  if (ext === '.mkv') headers['Content-Type'] = 'video/webm';
  if (ext === '.mov') headers['Content-Type'] = 'video/mp4';

  res.sendFile(absolute, { acceptRanges: true, maxAge: '1h', dotfiles: 'allow', headers }, (error) => {
    if (error && !res.headersSent) res.status(error.status || 404).end();
  });
}

// Downloads the standalone yt-dlp for this computer into bin/ at the project root,
// where the server looks for it. Used by `npm run render-build` on hosts like Render,
// which run Linux and have no winget. Run it again (or redeploy) to update yt-dlp.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const BUILDS = {
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
  'win32-x64': 'yt-dlp.exe',
  'win32-arm64': 'yt-dlp_arm64.exe',
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(rootDir, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const build = BUILDS[`${process.platform}-${process.arch}`];

// YouTube is optional, so a failed download warns instead of failing the build.
if (!build) {
  console.warn(`! No yt-dlp build for ${process.platform}-${process.arch}; YouTube links won't work.`);
  process.exit(0);
}

try {
  const response = await fetch(`${RELEASES}/${build}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Write next to the old copy and swap, so a running server never sees half a file.
  fs.writeFileSync(`${target}.download`, data, { mode: 0o755 });
  fs.renameSync(`${target}.download`, target);
  console.log(`yt-dlp saved to ${path.relative(rootDir, target)} (${(data.length / 1e6).toFixed(1)} MB)`);
} catch (error) {
  console.warn(`! Couldn't download yt-dlp (${error.message}); YouTube links won't work.`);
}

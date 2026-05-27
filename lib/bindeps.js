/**
 * lib/bindeps.js — ensure yt-dlp and ffmpeg are available, downloading them
 * on first run if they aren't already installed.
 *
 * Resolution order per binary: (1) the user's PATH, (2) PLDL's managed bin
 * dir (~/.pldl/bin), (3) download into the managed dir.
 *
 * yt-dlp publishes self-contained single-file builds per platform, so its
 * download is reliable. ffmpeg has no canonical single-file source, so its
 * download is best-effort per platform (see FFMPEG_SOURCES); if it fails, the
 * app still works for formats that don't need merging and we surface a hint.
 *
 * NOTE: the download URLs below are external and occasionally change. If a
 * download starts failing, the URL table is the place to look.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const isWin = process.platform === 'win32';
const MANAGED_DIR = path.join(os.homedir(), '.pldl', 'bin');

const YTDLP_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const FFMPEG_BUILDS = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/';

function exe(base) { return isWin ? `${base}.exe` : base; }
function managedPath(base) { return path.join(MANAGED_DIR, exe(base)); }

// ── Detection ──────────────────────────────────────────────────────────

function onPath(name) {
  return new Promise((resolve) => {
    execFile(isWin ? 'where' : 'which', [name], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      resolve(stdout.split(/\r?\n/)[0].trim() || null);
    });
  });
}

// Returns { path, source: 'path'|'managed' } or null.
async function resolveBinary(base) {
  const fromPath = await onPath(base);
  if (fromPath) return { path: fromPath, source: 'path' };
  const m = managedPath(base);
  if (fs.existsSync(m)) return { path: m, source: 'managed' };
  return null;
}

// ── Platform asset mapping ─────────────────────────────────────────────

function ytDlpAsset() {
  if (isWin) return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';      // universal2, self-contained
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

// Best-effort ffmpeg static-build sources. macOS uses evermeet (x86_64, runs
// under Rosetta on Apple Silicon); win/linux use yt-dlp's own FFmpeg-Builds.
function ffmpegSource() {
  if (process.platform === 'darwin') {
    return { url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip', archive: 'zip' };
  }
  if (isWin) {
    return { url: `${FFMPEG_BUILDS}ffmpeg-master-latest-win64-gpl.zip`, archive: 'zip' };
  }
  const arch = process.arch === 'arm64' ? 'linuxarm64' : 'linux64';
  return { url: `${FFMPEG_BUILDS}ffmpeg-master-latest-${arch}-gpl.tar.xz`, archive: 'tarxz' };
}

// ── Download / extract ─────────────────────────────────────────────────

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Recursively find a file named `target` under `dir`.
function findFile(dir, target) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, target);
      if (hit) return hit;
    } else if (entry.name === target) {
      return full;
    }
  }
  return null;
}

async function ensureYtDlp(onProgress) {
  const found = await resolveBinary('yt-dlp');
  if (found) return found.path;

  onProgress?.({ name: 'yt-dlp', state: 'downloading' });
  const dest = managedPath('yt-dlp');
  await download(YTDLP_BASE + ytDlpAsset(), dest);
  if (!isWin) fs.chmodSync(dest, 0o755);
  onProgress?.({ name: 'yt-dlp', state: 'ready' });
  return dest;
}

// Returns { dir } (the directory containing ffmpeg, for --ffmpeg-location) or
// null if ffmpeg is unavailable and couldn't be downloaded.
async function ensureFfmpeg(onProgress) {
  const found = await resolveBinary('ffmpeg');
  if (found) return { dir: path.dirname(found.path), source: found.source };

  onProgress?.({ name: 'ffmpeg', state: 'downloading' });
  const { url, archive } = ffmpegSource();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pldl-ffmpeg-'));
  try {
    const archivePath = path.join(work, `dl.${archive === 'tarxz' ? 'tar.xz' : 'zip'}`);
    await download(url, archivePath);

    const extractDir = path.join(work, 'x');
    fs.mkdirSync(extractDir, { recursive: true });
    if (archive === 'zip') await run('unzip', ['-q', '-o', archivePath, '-d', extractDir]);
    else await run('tar', ['-xf', archivePath, '-C', extractDir]);

    fs.mkdirSync(MANAGED_DIR, { recursive: true });
    for (const bin of ['ffmpeg', 'ffprobe']) {
      const src = findFile(extractDir, exe(bin));
      if (src) {
        const dst = managedPath(bin);
        fs.copyFileSync(src, dst);
        if (!isWin) fs.chmodSync(dst, 0o755);
      }
    }
    if (!fs.existsSync(managedPath('ffmpeg'))) throw new Error('ffmpeg binary not found in archive');

    onProgress?.({ name: 'ffmpeg', state: 'ready' });
    return { dir: MANAGED_DIR, source: 'managed' };
  } catch (err) {
    onProgress?.({ name: 'ffmpeg', state: 'error', message: err.message });
    return null;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Ensure both binaries. Returns { ytdlp: <path>, ffmpegDir: <dir>|null }.
 * Never rejects on ffmpeg failure (degrades gracefully); rejects only if
 * yt-dlp is missing AND its download fails (the app can't work without it).
 */
async function ensureBinaries({ onProgress } = {}) {
  const ytdlp = await ensureYtDlp(onProgress);
  const ffmpeg = await ensureFfmpeg(onProgress);
  return { ytdlp, ffmpegDir: ffmpeg ? ffmpeg.dir : null };
}

module.exports = {
  MANAGED_DIR,
  resolveBinary,
  ytDlpAsset,
  ffmpegSource,
  ensureYtDlp,
  ensureFfmpeg,
  ensureBinaries,
  managedPath,
};

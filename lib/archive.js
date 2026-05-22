/**
 * lib/archive.js — best-effort recovery of unavailable videos from the
 * Internet Archive, using yt-dlp's purpose-built `web.archive:youtube`
 * extractor (invoked as `ytarchive:<id>`).
 *
 * For a deleted/private video, the actual video stream is only recoverable
 * when the Archive Team grabbed it; that case yields a real media file.
 * Otherwise the archive usually still has the page metadata and thumbnail,
 * so we fall back to saving those. A .txt sidecar with the recovered title
 * and source URLs is always written as a guaranteed artifact.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const MEDIA_EXT = ['.mp4', '.mkv', '.webm', '.m4a', '.mp3', '.flv', '.avi', '.ogg', '.opus'];
const THUMB_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

function runYtdlp(args) {
  return new Promise((resolve) => {
    const p = spawn('yt-dlp', args);
    let stderr = '';
    p.stdout.on('data', () => {});            // drain so the pipe doesn't stall
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => resolve({ code, stderr }));
    p.on('error', (err) => resolve({ code: -1, stderr: err.message }));
  });
}

function filesForStem(dir, stem) {
  const prefix = stem + '.';
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
  } catch {
    return [];
  }
}

function classify(files) {
  const exts = files.map((f) => path.extname(f).toLowerCase());
  if (exts.some((e) => MEDIA_EXT.includes(e))) return 'video';
  if (exts.some((e) => THUMB_EXT.includes(e))) return 'thumbnail';
  if (files.length) return 'metadata';
  return 'none';
}

/**
 * Attempt to recover one video from the Internet Archive into finalDir.
 * @param {{id:string,title?:string,url?:string,waybackSnapshot?:string,availability?:string}} video
 * @param {string} finalDir  existing output directory
 * @param {string} stem      sanitized filename stem (no extension)
 * @returns {Promise<{id:string,title:string|null,outcome:'video'|'thumbnail'|'metadata'|'none',files:string[]}>}
 */
async function recoverMedia(video, finalDir, stem) {
  const source = `ytarchive:${video.id}`;
  const outTpl = `${stem}.%(ext)s`;

  // Phase A: try to pull the archived video itself (+ its thumbnail).
  await runYtdlp([
    '-P', finalDir,
    '-o', outTpl,
    '--write-thumbnail',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    source,
  ]);

  let files = filesForStem(finalDir, stem);
  let outcome = classify(files);

  // Phase B: no media recovered — grab whatever metadata/thumbnail is archived.
  if (outcome !== 'video') {
    await runYtdlp([
      '-P', finalDir,
      '-o', outTpl,
      '--skip-download',
      '--write-thumbnail',
      '--write-info-json',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      source,
    ]);
    files = filesForStem(finalDir, stem);
    outcome = classify(files);
  }

  // Always leave a human-readable sidecar with the recovered title + sources.
  const sidecar = path.join(finalDir, `${stem}.txt`);
  fs.writeFileSync(
    sidecar,
    [
      `Title: ${video.title || '(not recovered)'}`,
      `Video ID: ${video.id}`,
      `Original URL: ${video.url || `https://www.youtube.com/watch?v=${video.id}`}`,
      `Wayback snapshot: ${video.waybackSnapshot || '(none)'}`,
      `Availability: ${video.availability || 'unavailable'}`,
      '',
    ].join('\n')
  );

  files = filesForStem(finalDir, stem);
  return { id: video.id, title: video.title || null, outcome, files };
}

module.exports = { recoverMedia };

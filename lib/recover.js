'use strict';

/**
 * recover.js
 *
 * Wayback Machine title-recovery for deleted/unavailable YouTube videos.
 * Ports recover_playlist_titles.py to Node.js using the global fetch API
 * (Node >= 18). No external npm dependencies.
 *
 * Exported API:
 *   recoverTitle(videoId)                        -> Promise<RecoveryResult>
 *   recoverTitles(videoIds, options)             -> Promise<RecoveryResult[]>
 *
 * RecoveryResult shape:
 *   { videoId, title, url, waybackSnapshot }
 *     title           – recovered title string, or null if not found
 *     url             – canonical https://www.youtube.com/watch?v=<id>
 *     waybackSnapshot – human-viewable snapshot URL or null
 */

const CDX_API    = 'http://web.archive.org/cdx/search/cdx';
const WAYBACK    = 'https://web.archive.org/web';
const USER_AGENT = 'Mozilla/5.0 (playlist-title-recovery; +https://github.com/user/pldl)';

// Regex mirrors from the Python script
const OG_TITLE_RE   = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i;
// Also handle the reversed attribute order: content first, then property
const OG_TITLE_RE2  = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i;
const TITLE_TAG_RE  = /<title[^>]*>([\s\S]*?)<\/title>/i;
const YT_SUFFIX_RE  = /\s*-\s*YouTube\s*$/i;

// ─── AbortSignal timeout helper (Node 17.3+ has AbortSignal.timeout) ─────────

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// ─── CDX lookup ───────────────────────────────────────────────────────────────

/**
 * Query the Wayback CDX API for the earliest 200-status snapshot of
 * youtube.com/watch?v=<videoId>. Returns the timestamp string or null.
 */
async function findSnapshot(videoId) {
  const params = new URLSearchParams({
    url:    `youtube.com/watch?v=${videoId}`,
    output: 'json',
    filter: 'statuscode:200',
    limit:  '1',
  });
  const url = `${CDX_API}?${params}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal:  timeoutSignal(15_000),
    });
    if (!res.ok) {
      console.error(`  CDX HTTP ${res.status} for ${videoId}`);
      return null;
    }
    const rows = await res.json();
    // rows[0] is the header row; rows[1] is the first result
    if (!Array.isArray(rows) || rows.length < 2) return null;
    // CDX JSON columns: urlkey, timestamp, original, mimetype, statuscode, digest, length
    return rows[1][1]; // timestamp
  } catch (err) {
    console.error(`  CDX lookup failed for ${videoId}: ${err.message}`);
    return null;
  }
}

// ─── Snapshot fetch + title extraction ───────────────────────────────────────

/**
 * Fetch the raw Wayback snapshot (id_ modifier = no toolbar/rewrites) and
 * extract the video title. Returns the title string or null.
 */
async function fetchTitle(videoId, timestamp) {
  const watchUrl   = `https://www.youtube.com/watch?v=${videoId}`;
  const snapshotUrl = `${WAYBACK}/${timestamp}id_/${watchUrl}`;

  let html;
  try {
    const res = await fetch(snapshotUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal:  timeoutSignal(20_000),
    });
    if (!res.ok) {
      console.error(`  Snapshot HTTP ${res.status} for ${videoId}`);
      return null;
    }
    html = await res.text();
  } catch (err) {
    console.error(`  Fetch failed for ${videoId}: ${err.message}`);
    return null;
  }

  // Prefer og:title (most reliable in archived YouTube HTML)
  let m = OG_TITLE_RE.exec(html) || OG_TITLE_RE2.exec(html);
  if (m) return decodeHtmlEntities(m[1].trim());

  // Fall back to <title> tag, stripping " - YouTube" suffix
  m = TITLE_TAG_RE.exec(html);
  if (m) {
    const raw = decodeHtmlEntities(m[1].trim()).replace(YT_SUFFIX_RE, '').trim();
    return raw || null;
  }

  return null;
}

// ─── HTML entity decoder (no external dep needed for the subset YouTube uses) ─

const HTML_ENTITIES = {
  '&amp;':  '&',
  '&lt;':   '<',
  '&gt;':   '>',
  '&quot;': '"',
  '&#39;':  "'",
  '&apos;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

function decodeHtmlEntities(str) {
  // Numeric decimal &#NNN; and hex &#xNNN;
  str = str.replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16))
  );
  str = str.replace(/&#([0-9]+);/g, (_, dec) =>
    String.fromCodePoint(parseInt(dec, 10))
  );
  // Named entities (common subset)
  str = str.replace(/&[a-z]+;/gi, (entity) =>
    HTML_ENTITIES[entity] ?? entity
  );
  return str;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Recover the original title for a single YouTube video ID via the Wayback Machine.
 *
 * @param {string} videoId  11-character YouTube video ID
 * @returns {Promise<{videoId:string, title:string|null, url:string, waybackSnapshot:string|null}>}
 */
async function recoverTitle(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const timestamp = await findSnapshot(videoId);
  if (!timestamp) {
    return { videoId, title: null, url, waybackSnapshot: null };
  }

  const waybackSnapshot = `${WAYBACK}/${timestamp}/${url}`;
  const title = await fetchTitle(videoId, timestamp);

  return { videoId, title, url, waybackSnapshot };
}

/**
 * Recover titles for multiple video IDs with controlled concurrency and rate
 * limiting. Results are returned in the same order as the input array.
 * A failure for any single ID yields title:null without throwing.
 *
 * @param {string[]} videoIds  Array of 11-char YouTube video IDs
 * @param {object}  [options]
 * @param {number}  [options.concurrency=3]  Max simultaneous requests
 * @param {number}  [options.delayMs=500]    ms to wait between starting each request
 * @param {function}[options.onProgress]     Called as ({done, total, current}) after each video
 * @returns {Promise<Array<{videoId,title,url,waybackSnapshot}>>}
 */
async function recoverTitles(videoIds, { concurrency = 3, delayMs = 500, onProgress } = {}) {
  const total   = videoIds.length;
  const results = new Array(total);
  let done      = 0;

  // We process with a sliding-window concurrency gate.
  // Each slot is a promise; we push up to `concurrency` at once,
  // then await the earliest before adding another.
  const queue = [...videoIds.entries()]; // [[index, id], ...]
  const active = new Set();

  async function runOne([index, id]) {
    let result;
    try {
      result = await recoverTitle(id);
    } catch (err) {
      // Should never reach here (recoverTitle never throws), but be safe.
      result = {
        videoId: id,
        title: null,
        url: `https://www.youtube.com/watch?v=${id}`,
        waybackSnapshot: null,
      };
    }
    results[index] = result;
    done++;
    if (typeof onProgress === 'function') {
      onProgress({ done, total, current: result });
    }
  }

  // Sliding window: keep up to `concurrency` tasks in flight
  const inFlight = [];

  for (const item of queue) {
    // Enforce polite delay between *starting* each request
    if (inFlight.length > 0 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // If already at capacity, wait for the oldest task to finish
    if (inFlight.length >= concurrency) {
      await inFlight.shift();
    }

    const p = runOne(item);
    inFlight.push(p);
  }

  // Drain remaining
  await Promise.all(inFlight);

  return results;
}

module.exports = { recoverTitle, recoverTitles };

'use strict';

/**
 * timeline.js
 *
 * Estimate WHEN a now-unavailable YouTube video was deleted by inspecting the
 * Wayback Machine's snapshot history via the CDX API. Mirrors the interface of
 * recover.js (CommonJS, global fetch, descriptive User-Agent, AbortSignal
 * timeout, sliding-window concurrency, onProgress, input-order results,
 * per-item failures return nulls and never crash the batch). No npm deps.
 *
 * Exported API:
 *   getTimeline(videoId)               -> Promise<TimelineResult>
 *   getTimelines(videoIds, options)    -> Promise<TimelineResult[]>
 *
 * TimelineResult shape:
 *   { videoId, lastSeenAlive, firstSeenGone, snapshotCount }
 *     lastSeenAlive  – 'YYYY-MM-DD' of latest "alive" snapshot, or null
 *     firstSeenGone  – 'YYYY-MM-DD' of earliest "gone" snapshot AFTER
 *                      lastSeenAlive, or null
 *     snapshotCount  – total snapshots seen (number; 0 if none/unknown)
 *
 * STATUS-CODE HEURISTIC (and its known imperfection):
 *   We classify each CDX snapshot purely by its HTTP status code:
 *     "alive" = statuscode '200'
 *     "gone"  = statuscode '404' or '410'
 *     3xx redirects = NEITHER (skipped). A redirect is ambiguous: it may point
 *       to a consent/region wall on a live page or to an unavailable-video
 *       landing page, so it tells us nothing reliable about deletion and is
 *       excluded from both brackets.
 *   This is imperfect: after deletion, YouTube has historically (and still
 *   commonly does) serve an HTTP 200 page whose *body* says "Video unavailable"
 *   / "This video has been removed". Those snapshots look "alive" by status
 *   code alone, so the deletion can appear later than it actually was, or be
 *   missed entirely if the video was never crawled while returning 404/410.
 *   Detecting that case would require fetching and parsing snapshot HTML
 *   (out of scope here). Treat the returned window as a best-effort bracket,
 *   not a precise deletion date.
 *
 * The deletion window is bracketed as:
 *   lastSeenAlive = timestamp of the latest "alive" snapshot
 *   firstSeenGone = timestamp of the earliest "gone" snapshot whose timestamp
 *                   is strictly after lastSeenAlive (so a "gone" capture that
 *                   predates a later re-appearance / re-upload is ignored).
 */

const CDX_API    = 'http://web.archive.org/cdx/search/cdx';
const USER_AGENT = 'Mozilla/5.0 (playlist-deletion-timeline; +https://github.com/user/pldl)';

const ALIVE_CODES = new Set(['200']);
const GONE_CODES  = new Set(['404', '410']);

// ─── AbortSignal timeout helper (Node 17.3+ has AbortSignal.timeout) ─────────

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// ─── Timestamp conversion ─────────────────────────────────────────────────────

/**
 * Convert a CDX `YYYYMMDDhhmmss` timestamp to an ISO `YYYY-MM-DD` date string.
 * Returns null if the timestamp is not at least 8 digits.
 */
function toIsoDate(ts) {
  if (typeof ts !== 'string') ts = String(ts ?? '');
  if (!/^\d{8}/.test(ts)) return null;
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

// ─── Pure derivation helper (unit-testable, no I/O) ──────────────────────────

/**
 * Derive the deletion window from raw CDX JSON rows.
 *
 * Expects the shape returned by the CDX API with `fl=timestamp,statuscode`:
 *   [ ["timestamp","statuscode"], ["20120101000000","200"], ... ]
 * The first row is a header and is dropped. Data rows are assumed sorted
 * ascending by timestamp (CDX default), but we do not rely on that — we scan
 * for the max alive timestamp and the min gone timestamp after it.
 *
 * @param {Array} rows  raw parsed CDX JSON (header + data rows), or anything
 * @returns {{lastSeenAlive:string|null, firstSeenGone:string|null, snapshotCount:number}}
 */
function deriveWindow(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    // Empty, header-only, or non-array → nothing to derive.
    return { lastSeenAlive: null, firstSeenGone: null, snapshotCount: 0 };
  }

  const data = rows.slice(1); // drop header row
  let snapshotCount = 0;

  let lastAliveTs = null; // max timestamp among alive snapshots

  // First pass: count valid snapshots and find the latest alive timestamp.
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 2) continue; // malformed row
    const ts   = row[0];
    const code = row[1];
    if (typeof ts !== 'string' || !/^\d{8}/.test(ts)) continue; // bad timestamp
    snapshotCount++;

    const codeStr = String(code);
    if (ALIVE_CODES.has(codeStr)) {
      if (lastAliveTs === null || ts > lastAliveTs) lastAliveTs = ts;
    }
  }

  // Second pass: earliest "gone" snapshot strictly after lastAliveTs.
  // If there is no alive snapshot, there is no window to bracket (we cannot
  // say a video "went gone" relative to an alive baseline), so firstSeenGone
  // stays null in that case.
  let firstGoneTs = null;
  if (lastAliveTs !== null) {
    for (const row of data) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const ts   = row[0];
      const code = row[1];
      if (typeof ts !== 'string' || !/^\d{8}/.test(ts)) continue;
      if (!GONE_CODES.has(String(code))) continue;
      if (ts <= lastAliveTs) continue; // gone before/at last alive → ignore (reupload edge)
      if (firstGoneTs === null || ts < firstGoneTs) firstGoneTs = ts;
    }
  }

  return {
    lastSeenAlive: toIsoDate(lastAliveTs),
    firstSeenGone: toIsoDate(firstGoneTs),
    snapshotCount,
  };
}

// ─── CDX lookup ───────────────────────────────────────────────────────────────

/**
 * Query the Wayback CDX API for the full snapshot history of
 * youtube.com/watch?v=<videoId> and return the parsed JSON rows, or null on
 * any failure (network, timeout, non-OK, non-JSON, empty). Never throws.
 */
async function fetchCdxRows(videoId) {
  const params = new URLSearchParams({
    url:      `youtube.com/watch?v=${videoId}`,
    output:   'json',
    fl:       'timestamp,statuscode',
    collapse: 'digest',
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
    const text = await res.text();
    if (!text || !text.trim()) return null; // empty response
    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      console.error(`  CDX non-JSON response for ${videoId}`);
      return null;
    }
    if (!Array.isArray(rows)) return null;
    return rows;
  } catch (err) {
    console.error(`  CDX lookup failed for ${videoId}: ${err.message}`);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Estimate the deletion window for a single YouTube video ID via the Wayback
 * Machine's CDX snapshot history. Never throws; on any failure returns nulls
 * with snapshotCount 0.
 *
 * @param {string} videoId  11-character YouTube video ID
 * @returns {Promise<{videoId:string, lastSeenAlive:string|null, firstSeenGone:string|null, snapshotCount:number}>}
 */
async function getTimeline(videoId) {
  const rows = await fetchCdxRows(videoId);
  if (rows === null) {
    return { videoId, lastSeenAlive: null, firstSeenGone: null, snapshotCount: 0 };
  }
  const { lastSeenAlive, firstSeenGone, snapshotCount } = deriveWindow(rows);
  return { videoId, lastSeenAlive, firstSeenGone, snapshotCount };
}

/**
 * Estimate deletion windows for multiple video IDs with controlled concurrency
 * and rate limiting. Results are returned in the same order as the input array.
 * A failure for any single ID yields a nulls result without throwing.
 *
 * @param {string[]} videoIds  Array of 11-char YouTube video IDs
 * @param {object}  [options]
 * @param {number}  [options.concurrency=3]  Max simultaneous requests
 * @param {number}  [options.delayMs=500]    ms to wait between starting each request
 * @param {function}[options.onProgress]     Called as ({done, total, current}) after each video
 * @returns {Promise<Array<{videoId,lastSeenAlive,firstSeenGone,snapshotCount}>>}
 */
async function getTimelines(videoIds, { concurrency = 3, delayMs = 500, onProgress } = {}) {
  const total   = videoIds.length;
  const results = new Array(total);
  let done      = 0;

  const queue = [...videoIds.entries()]; // [[index, id], ...]

  async function runOne([index, id]) {
    let result;
    try {
      result = await getTimeline(id);
    } catch (err) {
      // Should never reach here (getTimeline never throws), but be safe.
      result = { videoId: id, lastSeenAlive: null, firstSeenGone: null, snapshotCount: 0 };
    }
    results[index] = result;
    done++;
    if (typeof onProgress === 'function') {
      onProgress({ done, total, current: result });
    }
  }

  // Sliding window: keep up to `concurrency` tasks in flight.
  const inFlight = [];

  for (const item of queue) {
    // Enforce polite delay between *starting* each request.
    if (inFlight.length > 0 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // If already at capacity, wait for the oldest task to finish.
    if (inFlight.length >= concurrency) {
      await inFlight.shift();
    }

    const p = runOne(item);
    inFlight.push(p);
  }

  // Drain remaining.
  await Promise.all(inFlight);

  return results;
}

module.exports = { getTimeline, getTimelines, deriveWindow, toIsoDate };

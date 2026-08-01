<?php
/**
 * PLDL web-mode API — same-origin proxy for the static app on shared hosting.
 *
 * The hosted page can't call the Wayback Machine or YouTube directly:
 * web.archive.org sends no CORS headers, and the YouTube Data API key must
 * stay server-side. This endpoint bridges both, one video/playlist per call —
 * the browser drives the loop, so no SSE or long-running process is needed.
 *
 *   ?action=playlist&id=<playlistId>  → enumerate via YouTube Data API v3
 *   ?action=research&id=<videoId>     → Wayback title recovery + deletion window
 *
 * Config: config.php beside this file returns ['youtube_api_key' => '...'].
 * It is NOT committed; without it, playlist enumeration reports unavailable
 * while Wayback research keeps working.
 */

ini_set('display_errors', '0'); // stray warnings must never corrupt the JSON

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const CDX_API      = 'https://web.archive.org/cdx/search/cdx';
const WAYBACK      = 'https://web.archive.org/web';
const YT_API       = 'https://www.googleapis.com/youtube/v3';
const USER_AGENT   = 'Mozilla/5.0 (pldl-web; +https://github.com/hiretyler/PLDL)';
const MAX_PAGES    = 8;   // playlistItems pages (50/page) → 400-video cap
const MAX_SNAPSHOTS = 3;  // snapshot fetches per research call

@set_time_limit(150);     // CDX alone has been observed at 30-56s server-side

function fail($status, $error) {
  http_response_code($status);
  echo json_encode(['error' => $error]);
  exit;
}

// ── Light per-IP rate limit (file-based; shared hosting has no APCu) ────────
function rate_limit($bucket, $perMinute) {
  $ip   = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
  $file = sys_get_temp_dir() . '/pldl-rl-' . md5($bucket . '|' . $ip);
  $now  = intdiv(time(), 60);
  $data = @json_decode(@file_get_contents($file), true) ?: ['m' => 0, 'n' => 0];
  if ($data['m'] !== $now) $data = ['m' => $now, 'n' => 0];
  $data['n']++;
  @file_put_contents($file, json_encode($data));
  if ($data['n'] > $perMinute) fail(429, 'Rate limit exceeded — try again in a minute.');
}

// ── Same-site guard: block obvious cross-site scripted abuse of the quota.
// No Referer at all is allowed (privacy settings, curl testing).
$referer = $_SERVER['HTTP_REFERER'] ?? '';
if ($referer !== '') {
  $host = parse_url($referer, PHP_URL_HOST) ?: '';
  $ownHost = preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''); // strip port
  $ok = ($host !== '' && $host === $ownHost) || $host === 'localhost' || $host === '127.0.0.1' ||
        preg_match('/(^|\.)tgeddes\.dev$/', $host);
  if (!$ok) fail(403, 'Cross-site requests are not allowed.');
}

function http_get($url, $timeout) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 5,
    CURLOPT_TIMEOUT        => $timeout,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_USERAGENT      => USER_AGENT,
    CURLOPT_ENCODING       => '',        // accept gzip
  ]);
  $body = curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  if ($body === false || $code < 200 || $code >= 300) return null;
  return $body;
}

// ─────────────────────────────────────────────────────────────────────────────
// action=research — port of lib/recover.js + lib/timeline.js, one video/call
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the first balanced JSON object after $anchor (string-aware). */
function extract_json_after($html, $anchorRe) {
  if (!preg_match($anchorRe, $html, $m, PREG_OFFSET_CAPTURE)) return null;
  $start = strpos($html, '{', $m[0][1]);
  if ($start === false) return null;
  $depth = 0; $inStr = false; $esc = false; $len = strlen($html);
  for ($i = $start; $i < $len; $i++) {
    $c = $html[$i];
    if ($esc)        { $esc = false; continue; }
    if ($c === '\\') { $esc = true;  continue; }
    if ($c === '"')  { $inStr = !$inStr; continue; }
    if ($inStr) continue;
    if ($c === '{') $depth++;
    elseif ($c === '}') {
      $depth--;
      if ($depth === 0) return json_decode(substr($html, $start, $i - $start + 1), true);
    }
  }
  return null;
}

const TITLE_DEAD = "\x00dead"; // sentinel: snapshot crawled after removal

/** Extraction order mirrors lib/recover.js: og:title → <title> → playerResponse. */
function extract_title($html) {
  if (preg_match('/<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)/i', $html, $m) ||
      preg_match('/<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']/i', $html, $m)) {
    return trim(html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
  }
  if (preg_match('/<title[^>]*>([\s\S]*?)<\/title>/i', $html, $m)) {
    $raw = trim(preg_replace('/\s+/', ' ', html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8')));
    $raw = trim(preg_replace('/^YouTube\s*-\s*/i', '', preg_replace('/\s*-\s*YouTube\s*$/i', '', $raw)));
    if ($raw !== '') return $raw;
  }
  $pr = extract_json_after($html, '/ytInitialPlayerResponse["\'\]]*\s*=\s*\{/');
  if (is_array($pr)) {
    $t = trim((string)($pr['videoDetails']['title'] ?? ''));
    if ($t !== '') return $t;
    $status = $pr['playabilityStatus']['status'] ?? null;
    if ($status !== null && $status !== 'OK') return TITLE_DEAD;
  }
  return null;
}

function action_research($videoId) {
  $watchUrl = "https://www.youtube.com/watch?v={$videoId}";
  $result = [
    'videoId' => $videoId, 'title' => null, 'url' => $watchUrl,
    'waybackSnapshot' => null, 'lastSeenAlive' => null,
    'firstSeenGone' => null, 'snapshotCount' => 0,
  ];

  // One CDX query serves both title walking and the deletion window.
  $q = http_build_query([
    'url' => "youtube.com/watch?v={$videoId}", 'output' => 'json',
    'fl' => 'timestamp,statuscode', 'collapse' => 'digest',
  ]);
  $body = http_get(CDX_API . '?' . $q, 60) ?? http_get(CDX_API . '?' . $q, 60); // one retry
  $rows = $body ? json_decode($body, true) : null;
  if (!is_array($rows) || count($rows) < 2) { echo json_encode($result); exit; }
  $rows = array_slice($rows, 1); // drop header

  // Deletion window — port of deriveWindow() in lib/timeline.js.
  $lastAlive = null; $count = 0;
  foreach ($rows as $r) {
    if (!is_array($r) || count($r) < 2 || !preg_match('/^\d{8}/', (string)$r[0])) continue;
    $count++;
    if ((string)$r[1] === '200' && ($lastAlive === null || $r[0] > $lastAlive)) $lastAlive = $r[0];
  }
  $firstGone = null;
  if ($lastAlive !== null) {
    foreach ($rows as $r) {
      if (!is_array($r) || count($r) < 2 || !preg_match('/^\d{8}/', (string)$r[0])) continue;
      if (!in_array((string)$r[1], ['404', '410'], true) || $r[0] <= $lastAlive) continue;
      if ($firstGone === null || $r[0] < $firstGone) $firstGone = $r[0];
    }
  }
  $iso = fn($ts) => $ts === null ? null :
    substr($ts, 0, 4) . '-' . substr($ts, 4, 2) . '-' . substr($ts, 6, 2);
  $result['snapshotCount'] = $count;
  $result['lastSeenAlive'] = $iso($lastAlive);
  $result['firstSeenGone'] = $iso($firstGone);

  // Title walk over the earliest 200 snapshots.
  $alive = array_values(array_filter($rows, fn($r) =>
    is_array($r) && count($r) >= 2 && (string)$r[1] === '200' && preg_match('/^\d{8}/', (string)$r[0])));
  usort($alive, fn($a, $b) => strcmp($a[0], $b[0]));
  $tried = 0;
  foreach ($alive as $r) {
    if ($tried++ >= MAX_SNAPSHOTS) break;
    $ts = $r[0];
    $html = http_get(WAYBACK . "/{$ts}id_/{$watchUrl}", 25);
    if ($html === null) continue;
    $title = extract_title($html);
    if (is_string($title) && $title !== TITLE_DEAD) {
      $result['title'] = $title;
      $result['waybackSnapshot'] = WAYBACK . "/{$ts}/{$watchUrl}";
      break;
    }
  }
  if ($result['waybackSnapshot'] === null && count($alive) > 0) {
    $result['waybackSnapshot'] = WAYBACK . "/{$alive[0][0]}/{$watchUrl}"; // for manual digging
  }
  echo json_encode($result);
  exit;
}

// ─────────────────────────────────────────────────────────────────────────────
// action=playlist — YouTube Data API v3 enumeration (mirrors lib/ytdata.js
// plus the availability classification from lib/playlist.js)
// ─────────────────────────────────────────────────────────────────────────────

function iso8601_to_seconds($d) {
  if (!preg_match('/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/', (string)$d, $m)) return null;
  return (int)($m[1] ?? 0) * 3600 + (int)($m[2] ?? 0) * 60 + (int)($m[3] ?? 0);
}

function action_playlist($playlistId, $apiKey) {
  if ($apiKey === '') fail(503, 'Playlist enumeration is not configured on this server.');

  // Playlist title (best-effort).
  $title = 'YouTube Playlist';
  $body = http_get(YT_API . '/playlists?' . http_build_query([
    'part' => 'snippet', 'id' => $playlistId, 'key' => $apiKey]), 20);
  $d = $body ? json_decode($body, true) : null;
  if (isset($d['items'][0]['snippet']['title'])) $title = $d['items'][0]['snippet']['title'];

  // Enumerate items (deleted/private entries included).
  $videos = []; $pageToken = null; $pages = 0; $truncated = false;
  do {
    $q = ['part' => 'snippet,contentDetails', 'playlistId' => $playlistId,
          'maxResults' => 50, 'key' => $apiKey];
    if ($pageToken) $q['pageToken'] = $pageToken;
    $body = http_get(YT_API . '/playlistItems?' . http_build_query($q), 25);
    if ($body === null) {
      if ($pages === 0) fail(502, 'YouTube API request failed — the playlist may be private or the quota exhausted.');
      break;
    }
    $d = json_decode($body, true);
    foreach (($d['items'] ?? []) as $it) {
      $sn = $it['snippet'] ?? [];
      $id = $sn['resourceId']['videoId'] ?? null;
      if (!$id) continue;
      $rawTitle = (string)($sn['title'] ?? '');
      $availability = 'public';
      if (strcasecmp($rawTitle, 'Deleted video') === 0)      $availability = 'deleted';
      elseif (strcasecmp($rawTitle, 'Private video') === 0)  $availability = 'private';
      $available = ($availability === 'public');
      $videos[] = [
        'index'            => count($videos) + 1,
        'id'               => $id,
        'title'            => $available ? $rawTitle : null,
        'available'        => $available,
        'availability'     => $availability,
        'url'              => "https://www.youtube.com/watch?v={$id}",
        'duration'         => null,
        'thumbnail'        => $sn['thumbnails']['medium']['url'] ?? ($sn['thumbnails']['default']['url'] ?? null),
        'dateAdded'        => isset($sn['publishedAt']) ? substr($sn['publishedAt'], 0, 10) : null,
        'videoPublishedAt' => isset($it['contentDetails']['videoPublishedAt'])
                              ? substr($it['contentDetails']['videoPublishedAt'], 0, 10) : null,
      ];
    }
    $pageToken = $d['nextPageToken'] ?? null;
    $pages++;
    if ($pageToken && $pages >= MAX_PAGES) { $truncated = true; break; }
  } while ($pageToken);

  if (count($videos) === 0) fail(404, 'Playlist not found, empty, or private.');

  // Durations for available videos (1 quota unit per 50).
  $availIds = array_column(array_filter($videos, fn($v) => $v['available']), 'id');
  $durations = [];
  foreach (array_chunk($availIds, 50) as $chunk) {
    $body = http_get(YT_API . '/videos?' . http_build_query([
      'part' => 'contentDetails', 'id' => implode(',', $chunk), 'key' => $apiKey]), 25);
    $d = $body ? json_decode($body, true) : null;
    foreach (($d['items'] ?? []) as $it) {
      $durations[$it['id']] = iso8601_to_seconds($it['contentDetails']['duration'] ?? '');
    }
  }
  $returned = [];
  foreach ($videos as $v) {
    if ($v['available']) {
      $v['duration'] = $durations[$v['id']] ?? null;
      // A public-titled entry whose video no longer resolves is unavailable.
      if (!array_key_exists($v['id'], $durations)) {
        $v['available'] = false; $v['availability'] = 'unavailable'; $v['title'] = null;
      }
    }
    $returned[] = $v;
  }
  $availableCount = count(array_filter($returned, fn($v) => $v['available']));
  echo json_encode([
    'title' => $title,
    'count' => count($returned),
    'availableCount' => $availableCount,
    'unavailableCount' => count($returned) - $availableCount,
    'truncated' => $truncated,
    'videos' => $returned,
  ]);
  exit;
}

// ── Dispatch ────────────────────────────────────────────────────────────────
$action = $_GET['action'] ?? '';
$id     = $_GET['id'] ?? '';

if ($action === 'research') {
  if (!preg_match('/^[A-Za-z0-9_-]{11}$/', $id)) fail(400, 'Invalid video id.');
  rate_limit('research', 60);
  action_research($id);
} elseif ($action === 'playlist') {
  if (!preg_match('/^[A-Za-z0-9_-]{10,60}$/', $id)) fail(400, 'Invalid playlist id.');
  rate_limit('playlist', 10);
  $config = is_file(__DIR__ . '/config.php') ? (include __DIR__ . '/config.php') : [];
  action_playlist($id, trim((string)($config['youtube_api_key'] ?? '')));
} else {
  fail(400, 'Unknown action.');
}

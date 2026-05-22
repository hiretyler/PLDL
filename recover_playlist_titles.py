#!/usr/bin/env python3
"""
recover_playlist_titles.py

Given a list of YouTube video IDs (or full URLs) in input.txt, one per line,
this script queries the Wayback Machine for each one and tries to recover the
original video title. Writes results to a CSV.

Usage:
    python recover_playlist_titles.py input.txt output.csv

Requires:
    pip install requests
"""

import csv
import re
import sys
import time
import requests

CDX_API = "http://web.archive.org/cdx/search/cdx"
WAYBACK_BASE = "https://web.archive.org/web"
USER_AGENT = "Mozilla/5.0 (playlist-title-recovery)"
REQUEST_DELAY = 0.5  # seconds between requests; be polite to archive.org

VIDEO_ID_RE = re.compile(r"(?:v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})")
TITLE_TAG_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
OG_TITLE_RE = re.compile(
    r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)',
    re.IGNORECASE,
)


def extract_video_id(line):
    """Parse a bare ID or any YouTube URL form into an 11-char ID."""
    line = line.strip()
    if not line:
        return None
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", line):
        return line
    m = VIDEO_ID_RE.search(line)
    return m.group(1) if m else None


def find_snapshot(video_id):
    """Return the timestamp of the earliest 200-status Wayback snapshot, or None."""
    params = {
        "url": f"youtube.com/watch?v={video_id}",
        "output": "json",
        "filter": "statuscode:200",
        "limit": 1,
    }
    try:
        r = requests.get(
            CDX_API, params=params, timeout=15,
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
        rows = r.json()
        # rows[0] is the header row
        if len(rows) < 2:
            return None
        return rows[1][1]  # timestamp column
    except Exception as e:
        print(f"  CDX lookup failed for {video_id}: {e}", file=sys.stderr)
        return None


def fetch_title(video_id, timestamp):
    """Fetch a specific snapshot and extract the title."""
    # The "id_" modifier asks Wayback for the raw original content without its
    # toolbar/rewrites, which keeps og:title intact.
    snapshot_url = (
        f"{WAYBACK_BASE}/{timestamp}id_/https://www.youtube.com/watch?v={video_id}"
    )
    try:
        r = requests.get(
            snapshot_url, timeout=20,
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
        html = r.text
    except Exception as e:
        print(f"  Fetch failed for {video_id}: {e}", file=sys.stderr)
        return None

    m = OG_TITLE_RE.search(html)
    if m:
        return m.group(1).strip()
    m = TITLE_TAG_RE.search(html)
    if m:
        title = re.sub(r"\s*-\s*YouTube\s*$", "", m.group(1).strip())
        return title or None
    return None


def main():
    if len(sys.argv) != 3:
        print(
            "Usage: python recover_playlist_titles.py input.txt output.csv",
            file=sys.stderr,
        )
        return 1

    in_path, out_path = sys.argv[1], sys.argv[2]

    with open(in_path) as f:
        raw_lines = f.readlines()

    ids = []
    seen = set()
    for line in raw_lines:
        vid = extract_video_id(line)
        if vid and vid not in seen:
            ids.append(vid)
            seen.add(vid)
        elif line.strip() and not vid:
            print(f"  Skipping unparseable line: {line.strip()}", file=sys.stderr)

    print(f"Processing {len(ids)} unique video IDs...")

    found, missing = 0, 0
    with open(out_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["video_id", "title", "url", "wayback_snapshot"])

        for i, vid in enumerate(ids, 1):
            url = f"https://www.youtube.com/watch?v={vid}"
            timestamp = find_snapshot(vid)

            if not timestamp:
                print(f"[{i}/{len(ids)}] {vid}  no snapshot")
                writer.writerow([vid, "(no snapshot found)", url, ""])
                missing += 1
                time.sleep(REQUEST_DELAY)
                continue

            snapshot_url = f"{WAYBACK_BASE}/{timestamp}/{url}"
            title = fetch_title(vid, timestamp)
            label = title or "(snapshot found, title not parsed)"
            print(f"[{i}/{len(ids)}] {vid}  {label}")
            writer.writerow([vid, label, url, snapshot_url])
            found += 1 if title else 0
            time.sleep(REQUEST_DELAY)

    print(f"\nDone. {found} titles recovered, {missing} with no snapshot.")
    print(f"Results: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

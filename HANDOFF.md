# PLDL — Development Handoff Notes

*Snapshot for restarting your computer mid-development. Delete when no longer useful.*

Last commit on `main`: **`dd4e9df` — Tauri v2 desktop scaffold + SEA sidecar build pipeline** (pushed to https://github.com/hiretyler/PLDL).

---

## TL;DR — what's next

Item 2 (distribution) is **scaffolded and the Node side is verified**. The remaining step happens on this Mac, requires the Rust toolchain, and may need 1–2 small Rust compile fixes I couldn't catch without compiling:

```bash
# one-time setup (skip what you already have)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
xcode-select --install
cargo install tauri-cli --version "^2.0"

# build
cd ~/projects/PLDL
npm install                            # restore node_modules after restart
npm run build:sidecar                  # produces build/pldl-server (verified working)
cp build/pldl-server "src-tauri/binaries/pldl-server-$(rustc -Vv | sed -n 's/host: //p')"
mkdir -p dist && cp index.html dist/
cargo tauri icon path/to/a-square-png  # any 512px+ square PNG
cargo tauri build                      # -> src-tauri/target/release/bundle/...
```

If `cargo tauri build` errors, paste the error to me in chat — the Rust scaffold (`src-tauri/src/lib.rs`) is unverified (no compiler in my last build env). It's idiomatic Tauri v2 but may need minor API tweaks.

Full step-by-step is in **`TAURI.md`** (committed).

---

## What's verified vs. unverified right now

| Piece | Status |
|---|---|
| `lib/bindeps.js` — detect/download yt-dlp+ffmpeg on first run | **Verified** (detection + forced-download path both tested) |
| Backend wiring (`PLDL_YTDLP`/`PLDL_FFMPEG_DIR`, 503 guard, health/SSE) | **Verified** |
| `scripts/build-sidecar.mjs` + `npm run build:sidecar` | **Verified** — produced a 128 MB `build/pldl-server` that runs the full server |
| `src-tauri/` (Cargo.toml, tauri.conf.json, capabilities, lib.rs, main.rs) | **Scaffolded, NOT compiled** — JSON validated, Rust is idiomatic v2 but unverified |
| `cargo tauri build` end-to-end | **Pending — your machine** |
| App signing / notarization | **Skipped by decision** (no Apple/MS account); end users do the one-time Open Anyway / Run anyway dance |

---

## Local state to be aware of after restart

- **Working tree:** clean as of last commit, no pending uncommitted changes (except this `HANDOFF.md`).
- **`.env`:** present locally with your **YouTube Data API key** — gitignored, will NOT survive a clean wipe but survives a normal restart. (If you ever need to recreate it: `cp .env.example .env` and paste the key.)
- **`node_modules/`:** gitignored. If you cloned fresh, run `npm install`. After a restart of an existing checkout, it's still there.
- **`build/`, `dist/`, `src-tauri/target/`, `src-tauri/binaries/pldl-server-*`:** all gitignored build artifacts; `npm run build:sidecar` regenerates them.
- **The current key in `.env`** was pasted into chat earlier; if you ever want to rotate it, regenerate in Google Cloud Console → Credentials and update `.env`.

---

## Where the session left off (in one paragraph)

We shipped, in order over the last few sessions: the unified PLDL build, the per-row archive video recovery (yt-dlp `ytarchive:`), the four investigative link-outs (Filmot/Ghostarchive/archive.today/Reddit) + deletion-window timeline + YouTube Data API date-added enrichment + 12-column CSV, the dark/light theme toggle (blue light accent), the in-app data-viewer modal with TSV/CSV export, the tabbed multi-OS setup guide, the bindeps auto-download manager, and finally the Tauri v2 scaffold + SEA sidecar pipeline. Item 1 (recovery sources) is fully done. Item 2 (distribution) is one `cargo tauri build` away from a working desktop app.

---

## When you sit back down

1. Open this file (`HANDOFF.md`) in `~/projects/PLDL/`.
2. Run the build commands above.
3. If it compiles cleanly → you've got a `.app` and `.dmg` in `src-tauri/target/release/bundle/`. Launch with right-click → Open the first time.
4. If it errors → paste the error into Claude Code chat; I'll patch the Rust.
5. Then we can move on to anything else (e.g. that Google-search-snippet scrape fallback, or icons).

Delete this file once it's no longer useful: `rm HANDOFF.md`.

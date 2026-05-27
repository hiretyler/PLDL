# PLDL — Tauri Desktop Build

This wraps the existing PLDL YouTube-playlist downloader (a Node.js + Express
app) in a native desktop window using **Tauri v2**. The web UI is unchanged; it
is shipped as a static `index.html` and talks to the bundled server over
`http://localhost:3001`.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  PLDL.app  (Tauri native window — Rust + system WebView)  │
│                                                           │
│   WebView  ── loads ──▶  dist/index.html                  │
│      │                                                    │
│      │  fetch / SSE (EventSource) over HTTP               │
│      ▼                                                    │
│   http://localhost:3001                                   │
│      ▲                                                    │
│   spawns (sidecar)                                        │
│      │                                                    │
│   binaries/pldl-server  ── Node SEA single-file exe ──▶   │
│        Express server (server.js, bundled)                │
│            │                                              │
│            └── on first run, downloads yt-dlp + ffmpeg    │
│                (the app's existing bindeps behaviour)     │
└─────────────────────────────────────────────────────────┘
```

- **Native window:** Rust/Tauri creates the window and loads the bundled
  `dist/index.html`. It does not render HTML itself — it uses the OS WebView
  (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux).
- **Sidecar:** the Express server is compiled to a **single-file Node executable**
  (Node SEA — Single Executable Application) and bundled as a Tauri *external
  binary*. On app startup the Rust `setup` hook spawns it via the
  **tauri-plugin-shell** sidecar API, pipes its stdout/stderr into the Tauri log,
  stores the child handle in managed state, and kills it on window close / app
  exit.
- **First run:** the server, on first launch, downloads `yt-dlp` and `ffmpeg`
  (the app's existing binary-dependency bootstrap). This needs network access and
  happens inside the sidecar process, not the Rust layer.
- **Startup ordering:** Rust does **not** wait for the server before showing the
  window. `index.html` polls `http://localhost:3001/api/health` and shows a
  "preparing → connected" badge on its own.

---

## 2. Prerequisites

Install once per machine:

1. **Rust** (stable toolchain) via rustup: https://rustup.rs
2. **Platform build tools:**
   - **macOS:** Xcode Command Line Tools — `xcode-select --install`
   - **Windows:** Microsoft C++ Build Tools (MSVC) **and** the WebView2 runtime
     (preinstalled on Windows 10/11; otherwise install the Evergreen runtime)
   - **Linux (Debian/Ubuntu):**
     ```
     sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
       libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
     ```
3. **Tauri CLI** — either of:
   ```
   cargo install tauri-cli --version "^2.0"      # then invoke as: cargo tauri <cmd>
   ```
   or, via npm:
   ```
   npm i -D @tauri-apps/cli@^2                    # then: npx tauri <cmd>
   ```
   Commands below use the `cargo tauri ...` form.

---

## 3. Build the sidecar (Node single-file executable)

The repo owner defines `build:sidecar` in `package.json`. It compiles
`server.js` (plus `lib/`) into one executable at `build/pldl-server`:

```
npm run build:sidecar     # -> produces build/pldl-server (or build\pldl-server.exe on Windows)
```

Tauri requires sidecar binaries to be **named with the Rust target triple** of
the machine you're building for. Find your host triple:

```
rustc -Vv | grep host
# e.g. host: aarch64-apple-darwin
```

Then copy the built binary into `src-tauri/binaries/` with that suffix. The base
name must match `externalBin` in `tauri.conf.json` (`binaries/pldl-server`):

| Target                      | Destination filename                                    |
|-----------------------------|---------------------------------------------------------|
| macOS Apple Silicon         | `src-tauri/binaries/pldl-server-aarch64-apple-darwin`   |
| macOS Intel                 | `src-tauri/binaries/pldl-server-x86_64-apple-darwin`    |
| Windows x64                 | `src-tauri/binaries/pldl-server-x86_64-pc-windows-msvc.exe` |
| Linux x64                   | `src-tauri/binaries/pldl-server-x86_64-unknown-linux-gnu` |

Examples:

```
# macOS Apple Silicon
cp build/pldl-server src-tauri/binaries/pldl-server-aarch64-apple-darwin

# macOS Intel
cp build/pldl-server src-tauri/binaries/pldl-server-x86_64-apple-darwin

# Linux x64
cp build/pldl-server src-tauri/binaries/pldl-server-x86_64-unknown-linux-gnu

# Windows x64 (note the .exe extension is kept)
copy build\pldl-server.exe src-tauri\binaries\pldl-server-x86_64-pc-windows-msvc.exe
```

You only need the binary for the platform/arch you are building. The sidecar
binaries are git-ignored (see `src-tauri/binaries/.gitignore`).

---

## 4. Copy the UI into `dist/`

Tauri loads the frontend from `../dist` (relative to `src-tauri/`, i.e. `dist/`
at the repo root). There is no frontend build step — just copy the page:

```
mkdir -p dist && cp index.html dist/
```

`dist/` is not created by this scaffold; it must contain `index.html` before any
`cargo tauri dev` or `cargo tauri build`.

---

## 5. Generate icons

The `icons/` directory referenced in `tauri.conf.json` is **not** included (no
fabricated binaries). Generate the full icon set from a single high-res PNG
(512×512 or larger, square, with transparency):

```
cargo tauri icon path/to/icon.png
```

This writes `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`,
`icon.ico`, etc. into `src-tauri/icons/`.

---

## 6. Build the app

With the sidecar in place, `dist/index.html` present, and icons generated:

```
cargo tauri build
```

Output bundles land under `src-tauri/target/release/bundle/`:

- **macOS:** `bundle/macos/PLDL.app` and `bundle/dmg/PLDL_0.1.0_<arch>.dmg`
- **Windows:** `bundle/msi/PLDL_0.1.0_x64_en-US.msi` and
  `bundle/nsis/PLDL_0.1.0_x64-setup.exe`
- **Linux:** `bundle/deb/`, `bundle/rpm/`, and `bundle/appimage/`

(`bundle.targets` is set to `"all"`, so every installer type available on the
build host is produced.)

---

## 7. First-launch on unsigned builds (end users)

These bundles are **unsigned** — there is no Apple Developer ID signature/
notarization and no Microsoft Authenticode certificate. The OS will warn on
first launch. This is expected; the workarounds:

- **macOS:** Gatekeeper blocks the app ("...cannot be opened because the
  developer cannot be verified" or "...is damaged").
  - Right-click (or Control-click) the app → **Open** → confirm **Open** in the
    dialog. *or*
  - **System Settings → Privacy & Security**, scroll to the blocked-app notice,
    click **Open Anyway**.
  - If macOS reports the app as "damaged" (quarantine on a downloaded unsigned
    app), clear the quarantine attribute:
    `xattr -dr com.apple.quarantine /Applications/PLDL.app`
- **Windows:** SmartScreen shows "Windows protected your PC". Click
  **More info** → **Run anyway**.

To ship without these prompts you would need a paid Apple Developer ID (+
notarization) and a Windows code-signing certificate. Not configured here.

---

## 8. Dev run

For an iterative loop (still requires the sidecar binary in `src-tauri/binaries/`
and `dist/index.html` present):

```
npm run build:sidecar
cp build/pldl-server src-tauri/binaries/pldl-server-<your-triple>
mkdir -p dist && cp index.html dist/
cargo tauri dev
```

Because there's no dev server (`beforeBuildCommand`/`devUrl` are intentionally
omitted), `cargo tauri dev` serves the static `dist/` directly. If you edit
`index.html`, re-copy it into `dist/` and reload.

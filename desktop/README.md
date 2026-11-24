# Three Studio desktop alpha

This is an **unsigned alpha** Electron shell around the standalone server. It
does not fork the app: the window loads `http://127.0.0.1:<port>/`, and the
existing `standalone/server.mjs` serves the same Studio UI and API.

## Requirements

- Node.js **24+** on `PATH`, or set `THREE_STUDIO_NODE` to a Node 24 binary.
- Node.js is also needed to install the Electron dev dependencies.
- `npm start` runs the server with that external Node. `npm run dist` first
  copies a Node 24 binary into `vendor/` (see `scripts/prepare-node.mjs`), so
  the packaged app does not depend on the user's `PATH`.

For a cross-platform build, prepare the target binary first on that platform or
pass a target Node 24 binary:

```sh
npm run prepare-node -- --node /path/to/node24 --platform darwin --arch arm64
npm run dist
```

Signing, notarization and auto-update are still follow-up work.

## Run

```sh
cd desktop
npm install
npm start
```

Data lives under Electron's `userData` directory:

- macOS: `~/Library/Application Support/Three Studio/data`
- Windows: `%APPDATA%\Three Studio\data`
- Linux: `~/.config/Three Studio/data`

Scenes, revision history, assets, share links and thumbnails are persisted
there. On macOS/Windows the portable snapshot backend is used; on Linux the
fd-anchored durable store is used.

## Package

```sh
cd desktop
npm run dist
```

This produces an unsigned build for the current platform. `predist` runs
`prepare-node` automatically; it copies the current Node 24 binary, or skips if
`vendor/node/<platform>-<arch>/` already contains one. The packaged app uses
the bundled binary first and falls back to `THREE_STUDIO_NODE`/`PATH`.

## CI packaging

`.github/workflows/desktop.yml` builds on GitHub Actions for:

- `ubuntu-latest` → AppImage + deb
- `macos-15-intel` → x64 dmg + zip
- `macos-14` → arm64 dmg + zip
- `windows-latest` → NSIS exe + zip

It runs `prepare-node` before `electron-builder` and uploads the installers as
workflow artifacts (14-day retention). The workflow runs on `workflow_dispatch`
and `v*` tags; it does not publish a GitHub Release automatically.

### Signing and notarization

Electron-builder signs automatically when these repository secrets are set:

- `CSC_LINK` and `CSC_KEY_PASSWORD` for the macOS Developer ID / Windows
  code-signing certificate.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for macOS
  notarization. After configuring them, set `mac.notarize` in
  `desktop/package.json` (for example `{ "notarize": true }` or an options
  object) to enable it.

Without those secrets the artifacts are unsigned and macOS/Windows may show
Gatekeeper/SmartScreen warnings. Auto-update is still not configured.

## Window chrome

- Windows: hidden title bar with the native window controls overlay; the
  Studio header is the drag region and leaves room for minimize/maximize/close.
- macOS: `hiddenInset` with traffic lights over the left side of the header.
- Linux: native frame.
- The renderer gets only `{ platform, versions }` from `preload.cjs`; there is
  no Node or IPC surface.

## Pro license

Desktop Pro uses an offline signed `*.tslicense` file. The local editor is
Apache-2.0 and remains functional in Free mode; the license unlocks the PRO
badge, the template pack and support/update entitlements.

```sh
cd desktop
npm run license -- keygen --out ~/.three-studio-release
npm run license -- issue --key ~/.three-studio-release/private-key.pem \
  --customer "Acme Studio" --email billing@example.com --days 365 \
  --out /tmp/acme.tslicense
npm run license -- verify --public license/public-key.pem --license /tmp/acme.tslicense
```

Keep `~/.three-studio-release/private-key.pem` offline. The app bundles only
`license/public-key.pem`. Activate in the app via **Help → Activate Three Studio
Pro…**; the file is copied to `<userData>/data/license.tslicense` with mode
`0600`. See [license/README.md](license/README.md) for the format and fulfillment
flow.

## Template pack

The public repository ships the template-pack **contract**, not the paid
scenes. `templates/manifest.json` is an empty free pack; the private Pro pack
lives outside this repository and is assembled into the gitignored
`templates/pro/` directory at build time:

```sh
cd desktop
# default source: ../three-studio-private/pro-templates
npm run templates

# or point at the private pack explicitly
THREE_STUDIO_PRO_TEMPLATES=/path/to/three-studio-private/pro-templates npm run templates
npm run release-check
npm run dist
```

`scripts/assemble-templates.mjs` validates ids, titles and flat `.js` filenames
(rejecting directories, traversal and symlinks), then atomically replaces
`templates/pro/`. `predist` runs it automatically. A missing pack is skipped
with a warning for open-source builds; set
`THREE_STUDIO_REQUIRE_PRO_TEMPLATES=1` to fail instead. The assembler always
removes a stale `templates/pro/` when the source is missing, so an open-source
build cannot silently bundle an old Pro pack. See
[`../docs/OPEN-CORE.md`](../docs/OPEN-CORE.md) for the boundary.

Before packaging:

```sh
npm run release-check
```

It checks the icon, public key, both template manifests and the signing
environment. It does not sign or upload anything.

## Icon

The app icon is a line-style triangular prism with an S-shaped signal:

- `build/icon.svg` — source artwork
- `build/icon.png` — 1024 px RGBA
- `build/icon.ico` — 16/24/32/48/64/128/256 px PNG entries

Regenerate after editing the SVG (uses the repo's Playwright/Chromium):

```sh
npm run render-icon
```

## Smart App Control / Application Control

If Windows **Smart App Control** or an Application Control policy is enforced,
an unsigned, renamed `Three Studio.exe` is blocked ("An Application Control
policy has blocked this file"). The same policy can make NSIS fail while
generating the uninstaller (`spawn UNKNOWN`). This is a Windows trust-policy
problem, not an application error.

Options:

- Sign the packaged app/installer with a trusted code-signing certificate and
  configure `CSC_LINK`/`CSC_KEY_PASSWORD` (the desktop workflow already wires
  these secrets).
- For development, run the app through an unmodified, reputable Electron
  binary: `electron.exe <desktop-dir>`. The official Electron binary is
  allowed on the build machine tested here; the renamed/edited exe is not.
- In a managed environment, ask IT for an Application Control exception for the
  build directory. Turning Smart App Control off is a system-wide, one-way
  decision and is not recommended just for an unsigned alpha.

## Security notes

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Navigation is limited to the local Studio origin; other HTTP(S) links open in
  the system browser.
- The server keeps its loopback-only binding, Host/Origin checks, per-process
  API token and sandboxed preview.

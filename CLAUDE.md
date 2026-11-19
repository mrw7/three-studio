# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Three Studio is an AI-native Three.js workbench. The AI writes self-contained
scene scripts through tools; the browser renders them in a sandboxed `srcDoc`
iframe alongside an editor, timeline, assets, history, sessions and model
settings. There are two deployment shapes:

1. **Standalone (primary)** — `standalone/server.mjs` serves everything with
   Node 24. No package install, no build step; React and Three.js are vendored.
2. **Optional Harness plugin** — `index.js` + `client.js` loaded by a DeepSeek
   Harness checkout via `./start.sh`. Legacy; only touch it when the task is
   explicitly about that mode.

## Commands

Node 24+ is required. This environment also has `~/.local/node24/bin/node`,
which the docs and CI-style checks use; `standalone/start.sh` prefers it
automatically.

```sh
./standalone/start.sh                     # http://127.0.0.1:3090/
THREE_STUDIO_PORT=4000 ./standalone/start.sh
THREE_STUDIO_HOME=/tmp/studio ./standalone/start.sh
npm test                                  # unit/protocol + standalone runtime tests
```

Tests use `node:test` with no external framework:

```sh
node --test tests/behavior.test.mjs                          # one file
node --test --test-name-pattern="frame-step" tests/behavior.test.mjs
node --test standalone/plugins/runtime.test.mjs standalone/settings.test.mjs
node --check client.js                                       # syntax check every file you touch
```

`tests/disk.test.mjs` (`npm run test:disk`) is excluded locally because its
disk-lock probes hang under this WSL environment; run it on a native filesystem
or in CI when changing the durable scene store.

Browser E2E (`npm run test:e2e`) needs `WORKBENCH_URL` pointing at a disposable
loopback server plus Playwright + Chromium; it SKIPs with exit 0 when either is
missing. Failures write screenshots and sanitized JSON under
`/tmp/three-workbench-e2e-artifacts/<run>/`.

## Architecture

```
browser: index.html -> boot.js (host shim) -> client.js (Studio UI)
                    <-> fetch/SSE -> standalone/server.mjs
server:  static + /api/*  -> agent.mjs (provider adapters, 8-round tool loop)
                          -> plugins/runtime.mjs + settings.mjs
                          -> fake Cordis ctx -> index.js (scene engine tools/routes)
storage: ~/.three-studio (models, credentials, sessions, plugins, skills, scenes)
```

- **`client.js`** (~33k lines, no build): the entire Studio UI, registered via
  the `window.__ModuleLoader__.load` facade. It also *generates* the sandboxed
  preview runtime as `srcDoc`. Keep sibling panels together; route user-facing
  copy through the `t()` dictionary with both `zh` and `en` entries; use the
  `--twb-*` CSS tokens for colour. Standalone-only surfaces are gated on
  `window.ThreeStudioStandalone`.
- **`index.js`** (~11k lines): the scene engine. Exports `apply(ctx)` plus test
  hooks `__assetInternal`, `__shareInternal`, `__historyInternal`,
  `__diskInternal`. Registers `three_scene` (full revised scene script, 256 KiB
  cap) and `workbench_proposal` (inert, reviewable edit proposals), durable
  revision/asset/share/thumbnail routes, and the disk store with in-memory
  fallback.
- **`standalone/server.mjs`** supplies the minimal Cordis surface `index.js`
  expects (`effect`, `tools.register`, `systemPrompt.section`, `inject`,
  `webServer.register`), plus session/model/plugin APIs and SSE streaming.
- **`standalone/agent.mjs`** is provider-neutral: canonical history (OpenAI
  chat-completions and Anthropic Messages adapters), streaming text/tool calls,
  live tool registry. Tool `presentationMeta`/`render` feed transcript cards.
- **`standalone/public/boot.js`** is the host contract `client.js` was written
  against (module loader, snapshot store, locale, sessions, `EventSource` shim,
  model directories) and mounts the Studio as the whole page.
- **`runtime/`** is vendored Three.js r186 plus the loaders/exporters the
  preview and exports need.

`docs/ARCHITECTURE.md` is the component map; `docs/PROTOCOL.md` is the
authoritative parent↔iframe command contract (its line anchors drift — re-grep
the named symbol before relying on one).

## Security invariants

- Scene code is untrusted. The iframe sandbox is exactly
  `allow-scripts allow-pointer-lock allow-downloads` — never add
  `allow-same-origin`, and never serve a scene as a navigable URL. Share and
  export viewers use the same sandbox.
- `postMessage` uses `targetOrigin: '*'` deliberately; opaque origins cannot be
  addressed. Do not put secrets or authorization decisions on that channel.
- The server binds loopback only. Credentials live in
  `~/.three-studio/credentials.json` (mode `0600`) and API keys are never
  returned by the API.
- The marketplace installs native in-repo modules only; it must not execute
  downloaded code.

## Project conventions

- **Data dir**: `THREE_STUDIO_HOME` defaults to `~/.three-studio`;
  `THREE_WORKBENCH_DATA_DIR` can point the scene store at an existing
  workbench directory. Everything there is disposable local data.
- **Adding a plugin**: metadata in `standalone/plugins/catalog.mjs`, an
  activator in `IMPLEMENTATIONS` in `runtime.mjs`, tests in
  `standalone/plugins/runtime.test.mjs`, and docs in `docs/PLUGINS.md`.
- **Docs stay in sync**: update `README.md`/`README.zh.md` and the relevant
  `docs/*.md` in the same change. The screenshots in `docs/screenshots/` are
  committed; replace them when a surface changes materially.
- `AUDIT.md`, `TODO.md`, `docs/BATCH-*.md`, `docs/P*-*.md`, `docs/DESIGN-*.md`
  and `docs/DECISIONS.md` are gitignored internal notes, not published docs.
- The repository is not open source; do not add license or contribution
  scaffolding, and follow `CONTRIBUTING.md` only if asked to contribute.

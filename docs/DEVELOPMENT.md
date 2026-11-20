# Development

## Requirements

- Node.js 24+ (the project is developed against Node 24.22)
- A modern Chromium/Firefox/Safari browser
- No package install for the standalone Studio; React and Three.js are vendored

## Layout

| Path | Purpose |
| --- | --- |
| `standalone/server.mjs` | HTTP server, fake Cordis context, APIs, SSE, route dispatch |
| `standalone/agent.mjs` | provider-neutral agent loop and OpenAI/Anthropic adapters |
| `standalone/settings.mjs` | providers and credentials |
| `standalone/plugins/` | catalog, native plugin runtime, tests, research notes |
| `standalone/public/` | HTML shell, host shim, vendored React |
| `client.js` | Studio UI (module-loader bundle, no build step) |
| `index.js` | scene engine: tools, durable store, routes |
| `runtime/` | vendored Three.js r186 and loaders |
| `tests/` | unit and protocol tests |
| `tests/e2e/` | optional browser/end-to-end harness |
| `docs/` | architecture, models, plugins, security, protocol |
| `examples/` | standalone scene examples |

## Run

```sh
./standalone/start.sh                 # http://127.0.0.1:3090/
THREE_STUDIO_PORT=4000 ./standalone/start.sh
THREE_STUDIO_HOME=/tmp/studio ./standalone/start.sh
```

The optional Harness plugin mode uses `./start.sh` and a Harness checkout; see
[HARNESS-PLUGIN.md](HARNESS-PLUGIN.md).

## Tests

Unit and protocol tests (Node 24; no external runner):

```sh
~/.local/node24/bin/node --test \
  tests/assets.test.mjs tests/behavior.test.mjs tests/export.test.mjs \
  tests/export-fbx.test.mjs tests/history.test.mjs tests/share.test.mjs \
  tests/smoke.test.mjs tests/studio-ai.test.mjs tests/tracks.test.mjs
```

Standalone runtime tests (plugins, sessions and model settings):

```sh
~/.local/node24/bin/node --test \
  standalone/plugins/runtime.test.mjs standalone/settings.test.mjs \
  standalone/sessions.test.mjs
```

The plugin suite covers every installable id, including an in-process MCP echo
server for `mcp-connectors`; tests that touch the network (web search) only
validate argument and key handling. The scheduled-tasks test shortens the tick
with `scheduleTickMs` so it finishes in under a second.

Syntax checks:

```sh
~/.local/node24/bin/node --check client.js
~/.local/node24/bin/node --check index.js
~/.local/node24/bin/node --check standalone/server.mjs
~/.local/node24/bin/node --check standalone/agent.mjs
```

`tests/disk.test.mjs` is excluded from the default local run because its
disk-lock probes hang in this WSL environment. Run it on a native filesystem or
in CI when changing the durable store.

Three standalone browser probes use a temporary Three Studio home and a local
mock OpenAI-compatible gateway. They never contact a real provider and each
uses its own port:

```sh
npm run test:e2e:standalone   # tests/e2e/standalone.mjs (port 3193)
npm run test:e2e:exports      # tests/e2e/exports.mjs    (port 3195)
npm run test:e2e:plugins      # tests/e2e/plugins.mjs    (port 3196)
```

- `standalone` covers mobile overlay entry, desktop session switching, provider
  connection testing, session archive/restore/delete, and cancel-then-send.
- `exports` answers the first prompt with a `three_scene` tool call, then
  downloads USDZ and FBX through the real export menu and validates the file
  magic, stored-zip entries and the FBX 7.4 node stream.
- `plugins` installs action-cards, deliverables, voice-input, file-browser,
  document-preview and browser-pane, then drives the transcript cards, the
  Files panel (traversal into the session deliverables and preview) and the
  Web pane (private-host refusal and the sandbox attribute). A stub
  `SpeechRecognition` is injected so the dictation button renders headlessly.

Each probe prints one JSON summary line and exits non-zero on failure. Keep the
browser setup local; never point these probes at a real provider key.

## Screenshots

The documentation screenshots in `docs/screenshots/` were captured at
1600×1000 from the standalone app. They show the seeded `examples/scene-watch.js`
scene, the model settings view and the plugin market.

Screenshots are committed as PNG (roughly 400–500 KiB each). Keep UI changes
consistent with them, or replace them when a surface changes materially.

## Adding a UI surface

`client.js` is a single no-build module; it is intentionally large. Keep new
components next to their sibling panels, route labels through the `t()` dictionary
for both `zh` and `en`, and use the `--twb-*` tokens for color. Standalone-only
surfaces can be gated on `window.ThreeStudioStandalone`.

## Adding a plugin

See [PLUGINS.md](PLUGINS.md). The short version:

1. Add metadata to `standalone/plugins/catalog.mjs`.
2. Add an activator to `IMPLEMENTATIONS` in `runtime.mjs`.
3. Add or update `standalone/plugins/runtime.test.mjs`.
4. Verify install/uninstall in the market and that the tool appears in a prompt.

## Data reset

`~/.three-studio` is disposable local data. Stop the server, remove the
directory, and start again to get a fresh provider catalog, skill seed and
session. `THREE_WORKBENCH_DATA_DIR` can point the scene store at an existing
workbench data directory for migration experiments.

## Known limitations

- The standalone build ships no Harness-only features: scheduled tasks, plugin
  manager, skills/chat UI, MCP connectors, subagents UI, voice and account
  services are roadmap entries or deliberately absent.
- The scene engine persists scenes to disk; the browser's editor overrides are
  localStorage-scoped and revision-checked.
- The screenshot environment uses SwiftShader; heavy scenes may take 20–30 s to
  reach the first frame and report low FPS.

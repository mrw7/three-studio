# Changelog

## Unreleased

- **Models:** the default seed now contains only DeepSeek. The untouched
  built-in Anthropic provider is removed from an existing `models.json` on
  startup, while a user-customized Anthropic provider is preserved. Custom
  Anthropic-compatible endpoints still work through the provider form.
- **License:** the core is now open source under Apache-2.0 (`LICENSE`,
  `NOTICE`), with `GOVERNANCE.md`, `CODE_OF_CONDUCT.md`, `TRADEMARK.md`, DCO
  sign-off in `CONTRIBUTING.md`, issue/PR templates and CODEOWNERS. Hosted,
  team and enterprise services remain outside this repository.
- **Security:** the loopback API now validates `Host` and
  `Origin`/`Sec-Fetch-Site`, requires a per-process API token on browser-like
  state-changing requests, requires `application/json` for API bodies, caps
  request bodies by route, and sends `nosniff`/`Referrer-Policy` headers.
  `index.html` receives a restrictive document CSP and the token meta tag;
  `boot.js` attaches the token to same-origin `fetch` and `XMLHttpRequest`
  calls. New regression tests cover the rejection paths.
- **Security:** MCP child processes now run in `~/.three-studio/mcp/<id>/`
  with only a minimal base environment plus the user-declared `env`, instead of
  inheriting `process.env` while using the Studio home as `cwd`.
- **Exports:** standalone HTML now embeds the full Three.js MIT license text;
  the docs no longer claim that project ZIP can be re-imported or that
  standalone HTML is offline (it loads Three.js from jsDelivr).
- **Desktop persistence:** macOS/Windows now use a portable atomic-snapshot
  store for scenes, revision history, assets, share links and thumbnails
  instead of falling back to memory. It writes content-addressed asset/blob
  directories plus a validated manifest under `scenes/portable/`, quarantines
  corrupt manifests and cleans orphaned blobs. Set
  `THREE_STUDIO_PORTABLE_STORE=1` to exercise it on Linux.
- **Desktop alpha:** `desktop/` adds an unsigned Electron shell that spawns the
  standalone server, binds data under Electron's `userData`, keeps
  `contextIsolation`/`sandbox` on and opens external links in the system
  browser. `npm start` needs Node 24 on `PATH` (or `THREE_STUDIO_NODE`);
  `npm run dist` runs `prepare-node` to bundle a Node 24 binary under
  `vendor/` and packages it with the app.
- **Desktop CI:** `.github/workflows/desktop.yml` packages unsigned
  Linux/macOS x64+arm64/Windows artifacts on `workflow_dispatch` and `v*` tags,
  uploads them for 14 days, and wires optional `CSC_*` and Apple notarization
  secrets. Publishing a release and auto-update are still manual/future work.
- **UI / icon:** the Studio uses a refreshed professional dark palette,
  clearer header grouping, wider rail/panels and a shared UI/mono font token
  set. The desktop window now uses hidden native chrome on Windows/macOS with
  an in-app drag region, and ships a line-style triangular-prism app icon
  (SVG, 1024 PNG, multi-size ICO).
- **Desktop theme:** the light/dark toggle now syncs to the native window
  controls. Windows updates `titleBarOverlay` colors through a narrow preload
  IPC bridge; macOS updates `nativeTheme` so traffic lights follow the app
  theme. The renderer never receives Node or filesystem access.
- **Demos:** `site/` now hosts a demo gallery with eight standalone sales
  assets, all using a shared vendored Three.js r186 runtime and no external
  requests:
  - `agency-demo/` — AUREL Chrono Watch, scroll-driven camera and four live
    material variants.
  - `configurator-demo/` — LUMEN desk lamp with finish/shade/light options,
    live price, configuration JSON and GLB export through `GLTFExporter`.
  - `education-demo/` — ORBIT LAB four-step solar-system workshop with live
    scene, code snippets and teaching tips.
  - `nebula-demo/` — 120K-particle galaxy with a custom GLSL vertex/fragment
    shader, three palettes, regenerate/pause and an FPS HUD.
  - `kinetic-demo/` — animated torus-knot sculpture with chrome/gold/
    iridescent physical materials, procedural PMREM environment and a speed
    control.
  - `audio-demo/` — SONAR radial spectrum driven by Web Audio
    `AnalyserNode`, microphone input or a silent procedural demo track.
  - `data-demo/` — SIGNAL 3D globe with city nodes, bezier routes, animated
    packets and Traffic/Latency/Capacity datasets.
  - `atrium-demo/` — procedural gallery corridor with skylights, framed art,
    a chrome sculpture and wheel/drag camera walkthrough.
  The gallery and demos default to English with a remembered Chinese toggle
  (`site/i18n.js`). `.github/workflows/pages.yml` deploys `site/` to GitHub
  Pages, and `site/README.md` covers free Cloudflare Pages/Netlify hosting.
  These are sales assets, not part of the Studio runtime.
- **Desktop Pro licensing:** offline Ed25519-signed `*.tslicense` files,
  issue/verify CLI, canonical payloads, expiry/feature checks, startup
  verification, native Help-menu activation/removal, a PRO header badge and a
  two-scene Pro template pack. The local core stays fully functional without a
  license; there is no activation server or machine binding in v1.
- **Open core:** `docs/OPEN-CORE.md` (and its Chinese counterpart) records what
  is Apache-2.0 and what stays private. The paid Pro scenes moved out of the
  public tree: `desktop/templates/` now ships only the pack contract and an
  empty free manifest. `desktop/scripts/assemble-templates.mjs` validates and
  copies a private pack into the gitignored `templates/pro/` at build time,
  rejecting traversal and symlinks; `predist` runs it automatically and
  `release-check` validates both manifests.
- **Migration:** `standalone/migrate-portable.mjs` loads a Linux fd store
  through the normal scene-engine startup and writes a portable manifest plus
  content-addressed blobs. It leaves the source untouched, refuses to
  overwrite an existing portable manifest without `--force`, and is also wired
  as `npm run migrate:portable`.
- **Portable merge:** `standalone/merge-portable.mjs` merges scenes, assets,
  shares and thumbnails from another portable store. Conflicts default to
  `skip`; `--on-conflict replace` overwrites same-id records. The source is
  read-only; assets with the same session/name are skipped. It is also wired
  as `npm run merge:portable`.
- **Profile merge:** `standalone/profile-merge.mjs` merges `sessions.json` and
  `models.json` between Studio homes, with skip/replace policies, session
  compaction, timestamped backups and `--dry-run`. It never reads or writes
  `credentials.json`. Wired as `npm run merge:profile`.
- **Docs:** README/README.zh and `standalone/README.md` describe the split
  persistence model; `docs/EXPORTS.md`/`docs/EXPORTS.zh.md` are corrected.
- **CI:** runs the full `npm test` suite (including FBX and session tests),
  checks `boot.js`, and adds a native-filesystem disk-test job.
- Documentation is bilingual for the new surfaces: `docs/PLUGINS.zh.md`,
  `docs/EXPORTS.zh.md`, `docs/SECURITY.zh.md`, paired README limitation
  sections, and copy-ready plugin config samples under
  `examples/plugin-config/` with Chinese and English guides.
- The full plugin catalog is now installable (twenty modules). Batch 2 adds
  the workspace file browser (guarded home-directory routes plus a Files
  panel) and document preview; batch 3 adds background jobs, scheduled tasks
  (session-scoped recurring prompts) and user-authored automation hooks;
  batch 4 adds web search (zero-config DuckDuckGo, keyed Tavily/Brave) and
  sourced deep research; batch 5 adds opt-in MCP stdio connectors, CDP browser
  automation and a sandboxed web pane behind the frozen trust-boundary design
  (`docs/TRUST-BOUNDARIES.md`).
- Five more marketplace plugins are available: project memory (durable
  `memory_write`/`memory_forget` with prompt re-injection), context files
  (sandboxed `~/.three-studio/context/` reading with AGENTS.md injection),
  action cards (clickable follow-ups that fill the composer, never auto-send),
  deliverables (session-scoped text file handover with copyable transcript
  cards) and voice input (SpeechRecognition dictation in the composer).
- Added USDZ export (vendored three r186 `USDZExporter`, stored zip with
  `model.usda`) and a native binary FBX 7.4 exporter for static scenes:
  geometry, hierarchy, local transforms, normals, one UV set and
  Phong-converted materials; verified end-to-end through the real three.js
  `FBXLoader` and a browser export probe (`npm run test:e2e:exports`).
- Model settings now include a live provider connection test with latency and
  redacted failure feedback.
- Sessions can be archived, restored and deleted; persisted conversations use
  atomic writes, bounded whole-turn history compaction and prompt/session caps.
- Added a standalone browser smoke command covering mobile layout, session
  switching, session lifecycle and cancel-then-send behavior.
- Session status in the standalone shell now stays in sync while an agent is
  running or stopping; canceled requests cannot overwrite a replacement
  prompt's transcript or state.
- Clearing or removing a model provider clears stale per-session selections,
  and streaming responses from CRLF or incomplete SSE gateways keep their
  final content.
- Light/dark theme toggle; the default viewport background follows the theme
  while authored scene backgrounds are preserved
- Background color edits commit on native change and are allowed on the demo
  scene
- Model providers can be edited and deleted inline, including model-list
  changes; deleting a provider also removes its credential and resets stale
  session selections
- **Demo gallery:** added ONE MINUTE, a 60-second procedural Three.js film,
  plus localized English pricing and tiered sprint/configurator/workshop
  offers; README, docs and package metadata link the live gallery.
- **Product content:** added an optional `presentation` editor record with
  bounded manual steps and film settings, a Manual rail panel, a Film dock
  panel with ordered shots, eased start→end camera keys, safe-area guides, SRT
  captions, local music muxing (Opus or video-only fallback), BOM CSV
  import/export, and 1080p 16:9/9:16/1:1/4:5 deterministic MP4 export that
  fails visibly instead of falling back to realtime WebM, an AI manual
  proposal, and a
  read-only manual sidebar in share links with hotspots/BOM, print-to-PDF and
  a local QR code. The local core keeps the full authoring/share/export loop;
  hosted collaboration, analytics, translations, 4K and batch rendering remain
  Pro/private.

## 0.1.0 — 2026-11-13

Initial standalone release.

- Standalone Node server and browser shell; no DeepSeek Harness runtime
- Studio UI: AI prompt, preview, code, outliner, inspector, parameters,
  timeline, dope sheet, shots, review, measurements, assets, history and
  sessions
- Scene engine: `three_scene` and `workbench_proposal` tools, durable scene
  revisions and sandboxed preview
- Agent loop: OpenAI-compatible and Anthropic Messages streaming, tool calls
  and multi-round execution
- Model settings: built-in DeepSeek and Anthropic providers, API keys and custom
  OpenAI/Anthropic-compatible providers
- Plugin market: native install/uninstall with skills, planning, todo,
  subagents and web reader available; roadmap catalog for additional
  capabilities
- Local data under `~/.three-studio`, loopback-only server and `0600`
  credentials
- Documentation, screenshots and CI workflow
- Optional legacy Harness plugin mode retained

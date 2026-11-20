# Changelog

## Unreleased

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

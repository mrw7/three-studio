# Changelog

## Unreleased

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

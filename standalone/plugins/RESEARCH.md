# Harness capability research for the Studio plugin market

Three parallel read-only reviews covered: core agent/automation packages,
client/workspace UI packages, and connectors/model providers/packaging in the
MIT-licensed `deepseek-harness` checkout. The market catalog keeps the
recommendations that fit an AI-native Three.js studio; entries are native
modules, not Harness plugins.

## Highest-value candidates

| Candidate | Harness source | Studio value | Status |
| --- | --- | --- | --- |
| Skills | `packages/skill/*`, `client/ui-skill` | Reusable Three.js/material/lighting recipes with low prompt cost | **Installed now** |
| Planning / Todo | `packages/plan/plan-mode`, `packages/todo/tool-todo` | Inspectable plans and visible progress for multi-step scene work | **Installed now** |
| Subagents | `packages/subagent/tool-subagent` | Parallel research, review and independent verification | **Installed now** (one-shot MVP) |
| Web reader | `packages/web/web-fetch-http`, `tool-web` | Read Three.js docs, asset pages and references | **Installed now** |
| Web search | `packages/web/web-search-*` | Current ecosystem docs and asset discovery | **Coming soon** (provider key) |
| Deliverables | `packages/deliverables/*`, `client/ui-deliverables` | Show delivered GLB/textures/exports and changed files | **Coming soon** |
| MCP connectors | `packages/mcp/mcp-client`, `mcp-resources` | Blender, asset libraries, Figma, GitHub, custom tools | **Coming soon** |
| Browser automation | `experimental/browser-use-playwright-mcp`, `browser-use-chrome-devtools-mcp` | Run exported scenes, screenshots, WebGL/debug logs | **Coming soon** |
| Background jobs | `packages/jobs/*`, `client/ui-jobs` | Long renders, conversions, exports without blocking chat | **Coming soon** |
| Files / document preview | `client/ui-sidebar-files`, `client/ui-sidebar-documentpreview` | Asset/file browsing and Markdown/PDF/image inspection | **Coming soon** |
| Voice input | `experimental/client-ui-voice-input` | Hands-free prompting while modeling | **Coming soon** |
| Memory | documented MCP memory integrations | Project conventions and material preferences across sessions | **Coming soon** |

## Why these, and what was rejected

- Skills, web reading, planning and subagents give the largest capability gain
  for a small native surface; all four are implemented.
- Deliverables, files and document preview are valuable but need workspace and
  file-serving infrastructure before they can be honest "installable" entries.
- MCP and browser automation are the strongest connector layer but require
  process isolation, trust prompts and secret scrubbing first.
- Terminal, computer use, workflow scripting and agent teams were deferred:
  they add arbitrary command execution, native permissions or high cost
  fan-out without a matching 3D-specific payoff yet.
- Product analytics and Harness account/sign-in were intentionally excluded.

## Security and licensing

- Harness first-party packages are MIT; third-party surfaces bring their own
  licenses (PDF.js Apache-2.0, DOMPurify MPL-2.0/Apache-2.0, xterm MIT,
  LibreOffice MPL-2.0, search providers' own terms).
- The native web reader refuses loopback/private destinations and resolves
  hostnames before each request.
- Subagents inherit the current model credentials and are capped to one
  one-shot call per tool invocation.
- Skills and MCP/tool descriptions are untrusted prompt input; do not execute
  skill-provided scripts automatically.
- Scheduled tasks, MCP servers and browser automation stay disabled until the
  Studio has explicit trust and sandbox boundaries for them.

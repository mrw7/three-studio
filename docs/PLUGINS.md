# Plugins and marketplace

The standalone Studio has a native plugin system and a curated marketplace. It
does **not** execute Harness/Cordis plugins or arbitrary package code.

## Marketplace

- Entry point: **Plugin market** in the left rail, or the plug icon in the header.
- Catalog source: `standalone/plugins/catalog.mjs`.
- Runtime: `standalone/plugins/runtime.mjs`.
- Installed state: `~/.three-studio/plugins.json`.
- API:
  - `GET /api/plugins`
  - `POST /api/plugins/:id/install`
  - `DELETE /api/plugins/:id/uninstall`

Installing activates tools and prompt sections immediately; no restart is
needed. Uninstalling removes the exact contributions it added.

## Installable now

| Id | Adds | Notes |
| --- | --- | --- |
| `skills` | `read_skill`, `studio:skills` prompt section | Reads flat `<name>.md` files from `~/.three-studio/skills/`; seeds `threejs-scene.md` |
| `planning` | `write_plan`, plan-first guidance | Validates a small goal + step list |
| `todo` | `todo_write` | Replaces a bounded checklist for multi-step work |
| `subagents` | `spawn_subagent` | One-shot research/review with the current provider/model; no scene edits |
| `web-fetch` | `web_fetch` | Public http(s) only; refuses loopback/private addresses and re-checks redirects; bounded output |
| `memory` | `memory_write`, `memory_forget`, `studio:memory` prompt section | Durable per-home project memory (`~/.three-studio/memory.json`, atomic writes, 200-entry/newest-first cap); the prompt section re-injects entries every session |
| `context-files` | `list_context_files`, `read_context_file`, `studio:context` prompt section | Reads flat text files from `~/.three-studio/context/` only (no paths, no binaries, 128 KiB read cap); an `AGENTS.md` there is auto-injected |
| `action-cards` | `propose_actions` | The agent ends a turn with up to six clickable follow-ups; clicking fills the composer — nothing is sent without the user's confirmation |
| `deliverables` | `save_deliverable` | Text deliverables land in `~/.three-studio/deliverables/<session>/` (text extensions only, 256 KiB cap, atomic writes); the transcript card shows the path and offers copy for small files |
| `voice-input` | composer dictation button | Client-side only: adds a mic button using the browser's SpeechRecognition when the plugin is installed; dictation appends to the draft, one utterance per click |
| `file-browser` | `list_workspace_files`, `read_workspace_file`, Files panel + `/api/plugins/file-browser/*` routes | Browses the Studio home from a panel; path-traversal, binary and credential guards on both the tools and the routes, which exist only while installed |
| `document-preview` | Files-panel viewer | Client-side viewer for workspace text and images (inline, bounded); the panel shows a hint instead when not installed |
| `background-jobs` | `start_background_job`, `check_background_job` | Detached one-shot research jobs (subagent-based, 20 concurrent, 3-minute budget); poll results in later turns instead of blocking the reply |
| `scheduled-tasks` | `schedule_prompt`, `list_schedules`, `cancel_schedule` | Recurring prompts persisted in `~/.three-studio/schedules.json` (10 max, 5–1440 min, session-scoped); fires through the same turn pipeline as manual prompts; uninstall stops the timer |
| `hooks` | `list_hooks` | User-authored `~/.three-studio/hooks.json` (`turn-end` events) whose notes are injected into the next turn's context; the agent can list but never write hooks |
| `web-search` | `web_search` | Zero-config DuckDuckGo Lite by default; keyed Tavily/Brave via `~/.three-studio/search.json` (`{"provider":"tavily","key":"…"}`). Result data only — page fetching stays with `web_fetch` |
| `deep-research` | `deep_research` | Fans out up to 3 queries, reads up to 4 pages (same SSRF guards as web_fetch) and synthesizes with one subagent; returns a sourced summary |
| `mcp-connectors` | `mcp_list_tools`, `mcp_call_tool` | Opt-in MCP stdio servers from a user-authored `~/.three-studio/mcp.json` (`{ id, command, args?, env? }`); newline-delimited JSON-RPC, 30 s per call, processes killed on uninstall; install fails with guidance until the config exists |
| `browser-automation` | `browser_navigate`, `browser_screenshot`, `browser_evaluate` | Drives the user's own Chrome over CDP after they create `~/.three-studio/browser-automation.json` and start Chrome with `--remote-debugging-port`; public http(s) targets only; screenshots land in `browser-captures/` |
| `browser-pane` | Web pane | Client-side user-driven sandboxed iframe (`allow-scripts allow-forms allow-popups`, never same-origin access, `no-referrer`); refuses private/local hosts; X-Frame-Options sites may refuse to embed |

## Roadmap

All twenty catalog entries are implemented and installable. New candidates
follow the same rule set: native modules only, trust surfaces stay
user-authored, and anything needing new trust boundaries ships a design note
first (see [TRUST-BOUNDARIES.md](TRUST-BOUNDARIES.md) for the current one).

## Catalog entry

```js
{
  id: 'skills',
  nameZh: '技能库',
  nameEn: 'Skills library',
  descriptionZh: '...',
  descriptionEn: '...',
  category: 'agent',        // agent | workflow | connectors | content | interface
  glyph: 'bolt',            // StudioGlyph name
  source: 'packages/skill/skill + packages/client/ui-skill',
  tags: ['skills', 'prompt'],
  recommended: true,
  available: true,
  installed: false,         // computed by the runtime
}
```

## Configuration files

Every trust-sensitive surface is a file the user writes by hand. The agent has
no tool that writes these files, and a plugin refuses to install when its
required file is missing. Copy-ready samples live in
[`examples/plugin-config/`](../examples/plugin-config/README.md).

| File | Plugin | Shape |
| --- | --- | --- |
| `~/.three-studio/mcp.json` | `mcp-connectors` | `{"servers":[{"id":"blender","command":"node","args":["server.js"],"env":{"TOKEN":"…"}}]}` |
| `~/.three-studio/browser-automation.json` | `browser-automation` | `{"cdp":"127.0.0.1:9222"}` |
| `~/.three-studio/search.json` | `web-search`, `deep-research` | `{"provider":"tavily","key":"tvly-…"}` or `{"provider":"brave","key":"…"}`; omit for DuckDuckGo |
| `~/.three-studio/hooks.json` | `hooks` | `{"hooks":[{"event":"turn-end","say":"Remember metres."}]}` |
| `~/.three-studio/schedules.json` | `scheduled-tasks` | Written by the plugin; manage through the tools |
| `~/.three-studio/memory.json` | `memory` | Written by the plugin; manage through the tools |
| `~/.three-studio/context/*` | `context-files` | Flat text files; `AGENTS.md` is injected automatically |
| `~/.three-studio/deliverables/<session>/` | `deliverables` | Written by the agent through `save_deliverable` |

MCP servers are spawned lazily on first use, run with `cwd` = the Studio home,
and are killed on uninstall. Browser automation talks to the Chrome you started
with `--remote-debugging-port`; it only opens public `http(s)` URLs. The web
pane is a sandboxed iframe with an opaque origin and no shared storage.

## Known limitations

- `web-search`'s default DuckDuckGo HTML endpoint may rate limit or change its
  markup. Configure Tavily or Brave for reliability; results are data only, and
  page bodies come from `web_fetch`.
- `deep-research` caps at three queries and four pages per call, and synthesizes
  with one subagent; it cannot read paywalled or JavaScript-only pages.
- `browser-automation` supports navigation, screenshots and expression
  evaluation only (no clicking or form filling), and requires the user to start
  Chrome themselves.
- `browser-pane` cannot display sites that refuse framing; it refuses private
  and loopback hosts by design.
- `mcp-connectors` supports stdio transport and the tools capability only; MCP
  stderr is discarded so secrets never reach the transcript.
- `scheduled-tasks` fire only while the standalone server runs and target the
  session that created them.
- `background-jobs` are in-memory: restarting the server forgets pending jobs.
- `voice-input` requires browser SpeechRecognition and the plugin installed;
  dictation is one utterance per click and is never sent automatically.

## Runtime contract

A plugin implementation is a function `activate(options)` that returns a
disposer. The options are:

- `dataDir` — `~/.three-studio`
- `tools` — live `Map<name, definition>` used by the agent
- `promptSections` — live array of `{name, order, text}` sections
- `pluginRoutes` — routes contributed by installed plugins
  (`{method, path, handler(request, url)}`); they exist only while installed
- `subscribe(event, handler)` — best-effort event bus (`turn-end` fires after a
  completed agent turn)
- `submitPrompt(sessionId, text)` — start a turn through the same pipeline as a
  manual prompt (used by `scheduled-tasks`)
- `modelSettings` — provider/credential store
- `runSubagent` — one-shot provider completion helper
- `selectionOf(sessionId)` — current provider/model selection
- `scheduleTickMs` — test hook that shortens the scheduled-task tick

Helpers inside the runtime add and remove tools/prompt sections. A tool
definition has:

```js
{
  name,
  description,
  parameters: { /* JSON schema */ },
  output: { schema, render(args, value), presentationMeta?(args, value) },
  async execute(args, exec) { /* return a JSON-safe value */ },
}
```

`exec.agent.session.id` is the current Session id. Tool results are streamed to
the transcript; `presentationMeta` can attach scene/proposal metadata.

## Adding a plugin

1. Add a catalog entry in `catalog.mjs` (`available: true` only when an
   implementation exists).
2. Add an activator to `IMPLEMENTATIONS` in `runtime.mjs`.
3. Register tools/prompt sections through the helpers; return a disposer that
   removes exactly what was added.
4. Validate every tool argument and keep outputs bounded.
5. Add tests in `standalone/plugins/runtime.test.mjs` or a sibling test file.
6. Run:

```sh
~/.local/node24/bin/node --test standalone/plugins/runtime.test.mjs
```

## Security rules

- Do not execute third-party package code or install plugins from the network.
- Treat skill files, web pages and MCP descriptions as untrusted prompt input.
- Refuse private/loopback destinations and re-check DNS/redirects for network
  tools.
- Cap tool output, model rounds and subagent calls.
- Never expose API keys, tokens or raw session ids in tool output or logs.
- Prefer read-only tools; destructive actions need explicit user approval in the
  UI before they run.

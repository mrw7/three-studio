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

## Roadmap

The catalog also lists, as disabled entries:

- scheduled tasks, MCP connectors, web search
- deliverables and changed-files review
- file browser, document preview, browser pane and browser automation
- background jobs, project memory, automation hooks, voice input, deep research

Roadmap entries have `available: false`; the install endpoint refuses them.
Their source paths in the catalog point at the Harness packages that informed
the design. See [RESEARCH.md](../standalone/plugins/RESEARCH.md).

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

## Runtime contract

A plugin implementation is a function `activate(options)` that returns a
disposer. The options are:

- `dataDir` — `~/.three-studio`
- `tools` — live `Map<name, definition>` used by the agent
- `promptSections` — live array of `{name, order, text}` sections
- `modelSettings` — provider/credential store
- `runSubagent` — one-shot provider completion helper
- `selectionOf(sessionId)` — current provider/model selection

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

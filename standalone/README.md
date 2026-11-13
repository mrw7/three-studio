# Three Studio — standalone

Project overview and screenshots: [`../README.md`](../README.md). Architecture:
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

This directory runs the AI 3D workbench **without DeepSeek Harness**. It has no
Harness package dependency at runtime: Node's HTTP server, the existing scene
engine (`../index.js`), the Studio client (`../client.js`), a small host shim,
and two local React UMD files.

## Run

```sh
./standalone/start.sh            # http://127.0.0.1:3090/
THREE_STUDIO_PORT=4000 ./standalone/start.sh
```

Node.js 24+ is required. The server binds loopback only by default.

Data lives in `~/.three-studio` (override with `THREE_STUDIO_HOME`):

| Path | Purpose |
| --- | --- |
| `models.json` | providers, endpoints, protocols, model ids |
| `credentials.json` | API keys, mode `0600` |
| `sessions.json` | session metadata, event log and provider-neutral history |
| `plugins.json` | installed plugin ids |
| `skills/` | flat `<name>.md` skill files (seeded with a Three.js skill) |
| `scenes/` | the durable scene store served by the workbench routes |

Set `THREE_WORKBENCH_DATA_DIR` to reuse an existing scene store, for example the
old Harness location `~/.dsh/three-workbench`. Conversation logs are not
migrated automatically.

## Architecture

- `server.mjs` supplies the tiny Cordis surface `index.js` needs (`effect`,
  `tools.register`, `systemPrompt.section`, `webServer.register`), serves the
  Studio page and JSON/SSE APIs, and dispatches the scene routes.
- `public/boot.js` provides the host contract `client.js` expects: locale,
  snapshot store, session catalog and bindings, slots, model directories,
  providers/credentials/settings, and the full-page mount.
- `agent.mjs` runs a provider-neutral tool loop over OpenAI-compatible chat
  completions or Anthropic Messages, invoking the same `three_scene` and
  `workbench_proposal` tools.
- `settings.mjs` owns provider settings and the separate credential file.

## Plugin market

The **Plugin market** tab (`standalone/plugins/catalog.mjs`) lists capabilities
selected from the MIT-licensed Harness ecosystem and adapted as native Studio
modules. Installing one activates its tools and prompt guidance immediately:

- **Skills library** — flat `<name>.md` files in `skills/`, exposed through the
  `read_skill` tool. Seeded with a Three.js scene skill.
- **Planning and goals** — a `write_plan` tool plus prompt guidance.
- **Todo checklist** — a `todo_write` tool for visible multi-step progress.
- **Subagents** — a one-shot `spawn_subagent` tool for independent research and
  review using the current session model.
- **Web reader** — a `web_fetch` tool with private/loopback address refusal and
  bounded output.

The catalog also lists roadmap entries (scheduled tasks, MCP connectors,
deliverables, file/document/browser panes, background jobs, voice input and
more). They are visible but disabled until a native implementation lands.

## Supported

- Studio UI: preview, code, editor, timeline, dope sheet, shots, review,
  measures, assets, history, sessions, plugin market
- AI chat with streaming, tool calls and scene revisions
- Session model picker and reasoning effort (when a provider declares it)
- Provider API keys and custom OpenAI/Anthropic-compatible providers
- Sandboxed `srcDoc` scene execution and the existing export/share paths

## Not supported

Harness-only features are deliberately absent: scheduled tasks, plugin
management, skills, MCP connectors, subagents and Harness account sign-in.
There is no navigation back to a host shell; Studio is the whole page.

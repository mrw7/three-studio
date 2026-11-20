# Plugin configuration examples

Trust-sensitive plugin surfaces read files from `~/.three-studio`. Copy an
example, edit it, and install the plugin again:

```sh
mkdir -p ~/.three-studio/context
cp examples/plugin-config/mcp.example.json ~/.three-studio/mcp.json
```

| File | Copy to | Plugin | Notes |
| --- | --- | --- | --- |
| `mcp.example.json` | `~/.three-studio/mcp.json` | `mcp-connectors` | `command` is executed as a child process with cwd = the Studio home. Only add servers you trust; remove `env` values you do not need. |
| `browser-automation.example.json` | `~/.three-studio/browser-automation.json` | `browser-automation` | Start Chrome yourself: `chrome --remote-debugging-port=9222` (close other instances or use a separate profile). |
| `search.example.json` | `~/.three-studio/search.json` | `web-search`, `deep-research` | Omit the file for DuckDuckGo; set `provider` to `tavily` or `brave` and add the key. Keys stay local and are never returned by the API. |
| `hooks.example.json` | `~/.three-studio/hooks.json` | `hooks` | `say` strings are injected as plain text after completed turns (last 5, ≤1000 chars). |
| `AGENTS.example.md` | `~/.three-studio/context/AGENTS.md` | `context-files` | Project conventions injected into every session (≤6000 chars). |

Rules that apply to all of them:

- These files are user-authored on purpose. The agent has no tool that writes
  them, so it cannot grant itself new network or process capabilities.
- Credentials never belong in these files; use `credentials.json` (managed by
  the Settings UI) for model keys.
- After editing, uninstall and reinstall the plugin (or restart the server for
  `hooks`/`mcp` changes that were loaded at install time).

See [docs/PLUGINS.md](../../docs/PLUGINS.md) for the full contract and
[docs/SECURITY.md](../../docs/SECURITY.md) for the trust model.

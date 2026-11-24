# Security and trust boundaries

Three Studio is a single-user local application. The server binds
`127.0.0.1` only and has no account system. Treat it as a local developer tool,
not a hardened multi-tenant service.

## Browser and scene isolation

- Model-written scene code runs in a `srcDoc` iframe with
  `sandbox="allow-scripts allow-pointer-lock allow-downloads"`.
- The iframe never receives `allow-same-origin`; it cannot read app storage,
  cookies, the host API or the API token.
- The loopback API checks `Host` and `Origin`/`Sec-Fetch-Site`, requires a
  per-process API token on browser-like state-changing requests, enforces JSON
  content type, and caps request bodies. The token is injected into
  `index.html` and attached by `boot.js`; it is never exposed to the scene
  iframe.
- The scene is never served as a navigable URL. Exports and the share viewer use
  the same sandbox.
- Parent↔iframe messages are validated by shape and never trusted as executable
  input.

## Data and credentials

- Data lives in `~/.three-studio` (override with `THREE_STUDIO_HOME`).
- `credentials.json` is written with mode `0600`; API keys are write-only from
  the UI and never returned by the API.
- Provider settings contain endpoints and model ids, not secrets.
- No telemetry is collected or sent by the app.
- Removing `~/.three-studio` deletes all local Studio data.

## Network egress

- Outbound requests are limited to: model calls to the provider you configure,
  explicit `web_fetch` calls, `web_search`/`deep_research` queries, MCP servers
  you configure, and the browser-automation CDP endpoint you point at. Nothing
  else leaves the machine, and there is no telemetry.
- `web_fetch` and `deep_research` accept public `http(s)` URLs only. They refuse
  `localhost`, loopback, link-local, CGNAT, private IPv4/IPv6 ranges and
  `.local` hostnames, resolve DNS before the request, re-check every redirect
  and cap response size.
- `web_search` talks to the DuckDuckGo HTML endpoint by default; Tavily or Brave
  only after you add their key to `~/.three-studio/search.json`. Search keys are
  never returned by the API or written to logs.
- `browser-automation` applies the same public-target guard to every navigation
  and refuses private or local hosts. It never starts Chrome and cannot enable
  itself.
- `browser-pane` loads sites directly in an opaque-origin iframe; the server
  never proxies that traffic. The pane sends no referrer and shares no cookies
  or storage with the Studio.

## Agent and plugins

- The agent can call only the tools currently registered: scene tools plus
  installed plugin tools.
- Plugins are native modules in this repository. The marketplace does not
  download or execute third-party plugin code.
- Skills, fetched pages and tool descriptions are untrusted prompt input. They
  can influence the model; they do not gain code execution by themselves.
- Subagents use the same provider credentials and are limited to a single
  one-shot call per invocation.
- Destructive scene operations are exposed through the editing protocol with
  revision checks; proposals are inert until the user applies them.
- Trust configuration is user-authored and read-only to the agent:
  `mcp.json`, `browser-automation.json`, `hooks.json` and `search.json` have no
  write tool. MCP and browser automation refuse to install until their config
  exists, so there is no half-enabled state.
- MCP servers run as child processes chosen by the user (equivalent to running
  them yourself); stderr is discarded so secrets never reach the transcript.
  Each child gets its own `~/.three-studio/mcp/<id>/` working directory and only
  a minimal base environment plus the user-declared `env` map, so the Studio
  home is not its working directory and provider-key environment variables are
  not inherited by default. It still runs as the same OS user and can read
  absolute paths; only install MCP servers you trust. MCP tool descriptions are
  untrusted prompt input.
- `file-browser` tools and routes share one guard: relative paths only, no `..`,
  no absolute paths, `credentials.json` always refused, binaries refused. Those
  routes exist only while the plugin is installed.
- Plugin contributed routes are dispatched only after the built-in API router
  and only for exact method/path matches; unloading a plugin removes them.
- `hooks` can observe completed turns but cannot inject executable content: its
  notes are plain text in the next prompt section.

## Files, exports and sharing

- Asset upload/delete routes are session-scoped and size-limited.
- Export and share documents are generated from the current scene without
  embedding API keys, session tokens or local paths.
- Treat generated HTML/GLB/PNG/USDZ/FBX files as untrusted content when opened
  elsewhere.
- Deliverables and workspace reads are confined to the Studio home; paths that
  escape it are rejected before touching disk.

## Known limitations

- Loopback binding is the only access control. Do not expose the port to an
  untrusted network without adding authentication and TLS.
- The disk scene store has a lock and recovery path; `tests/disk.test.mjs`
  exercises failure modes and is excluded from the default local test run in
  this environment.
- Model providers receive the prompts and tool context needed to answer; review
  their retention and data policies before sending sensitive content.
- Web search's free DuckDuckGo endpoint may rate limit or change markup;
  keyed providers are the reliable path.
- MCP support is stdio + tools only (no HTTP/SSE, sampling or roots).
- The web pane cannot display sites that refuse framing, and the safety of what
  it renders is the site's responsibility; it has no access to Studio data.
- Scheduled tasks and background jobs run only while the local server is
  running; background results live in memory.

## Reporting a vulnerability

Open a private GitHub Security Advisory for the repository. Do not include API
keys, tokens or user session content in a public issue.

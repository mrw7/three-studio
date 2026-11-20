# Plugin trust boundaries

This page freezes how the three trust-sensitive plugin surfaces — MCP
connectors, browser automation and the web pane — are allowed to work. It is
the contract behind the code; change it deliberately, not incidentally.

## Shared principles

1. **The user owns the configuration.** The trusted configuration for all
   three is a file you write by hand (`mcp.json`, `browser-automation.json`) or
   a URL you type into a panel. The agent has no tool that writes these
   surfaces.
2. **Install means consent.** `mcp-connectors` and `browser-automation` fail to
   install with concrete instructions when their configuration is missing.
   There is no half-enabled state and no way for the agent to enable them.
3. **Least exposure.** The agent gets a generic call surface
   (`mcp_call_tool`, `browser_navigate/screenshot/evaluate`); it never sees
   process listings, environment variables or CDP endpoint details, and errors
   are truncated without echoing secrets.
4. **Lifecycle follows the plugin.** Uninstalling kills MCP child processes,
   closes the CDP socket and removes routes. Timers are `unref`'d so they never
   keep the server alive.

## MCP connectors

- Transport: stdio with newline-delimited JSON-RPC (the MCP base protocol), one
  lazily started child process per server, `cwd` = the Studio home.
- Limits: 8 servers, 64 tools, 30 s per call, 8 s initialization.
- Isolation: server stderr is discarded (it may contain secrets); only the
  declared `env` map is merged into the environment; server ids are constrained
  to `[a-z0-9][a-z0-9_-]` and tool descriptions are truncated before they enter
  the prompt.
- Accepted residual risk: a local MCP server is a program the user chose to run;
  the agent calling its tools is the capability the user opted into.

## Browser automation

- Precondition: the user starts Chrome with `--remote-debugging-port` and
  writes `browser-automation.json`. The agent cannot enable it.
- Target guard: the same public-address rules as `web_fetch` (loopback,
  private, link-local and CGNAT rejected; hostnames resolved and every address
  re-checked).
- CDP client: original implementation (fetch `/json/version` plus the global
  WebSocket), no third-party dependency; 15–20 s timeouts and load-event waits
  that degrade to completion instead of hanging.
- Captures: screenshots are written to `browser-captures/` with mode `0600` and
  never enter the transcript as binary.

## Web pane

- Client-side only; the server contributes nothing.
- The iframe sandbox is exactly
  `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox` —
  **never** `allow-same-origin`, so the page has an opaque origin and no access
  to Studio or site storage. `referrerPolicy` is `no-referrer`.
- Only the user types addresses; the client refuses private and loopback hosts.
  The iframe connects to the site directly; the server never proxies it, so
  there is no SSRF surface.
- Known limit: sites sending `X-Frame-Options`/frame-ancestors cannot be shown;
  the panel states this.

## Deliberately not done

- Any agent-writable path into trust configuration.
- Agent-driven use of the web pane. If that is ever added it must go through
  the `propose_actions` confirmation pattern.
- MCP HTTP/SSE transport, sampling or roots (stdio + tools only).

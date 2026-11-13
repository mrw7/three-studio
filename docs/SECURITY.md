# Security and trust boundaries

Three Studio is a single-user local application. The server binds
`127.0.0.1` only and has no account system. Treat it as a local developer tool,
not a hardened multi-tenant service.

## Browser and scene isolation

- Model-written scene code runs in a `srcDoc` iframe with
  `sandbox="allow-scripts allow-pointer-lock allow-downloads"`.
- The iframe never receives `allow-same-origin`; it cannot read app storage,
  cookies, the host API or the token.
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

- The only outbound requests are the model calls to the provider you configure
  and explicit `web_fetch` calls.
- `web_fetch` accepts public `http(s)` URLs only. It refuses `localhost`,
  loopback, link-local, private IPv4/IPv6 ranges and `.local` hostnames, resolves
  DNS before the request, re-checks each redirect and caps response size.
- There is no web search provider in the current build; adding one would add its
  own key and network endpoint.

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

## Files, exports and sharing

- Asset upload/delete routes are session-scoped and size-limited.
- Export and share documents are generated from the current scene without
  embedding API keys, session tokens or local paths.
- Treat generated HTML/GLB/PNG files as untrusted content when opened elsewhere.

## Known limitations

- Loopback binding is the only access control. Do not expose the port to an
  untrusted network without adding authentication and TLS.
- The disk scene store has a lock and recovery path; `tests/disk.test.mjs`
  exercises failure modes and is excluded from the default local test run in
  this environment.
- Model providers receive the prompts and tool context needed to answer; review
  their retention and data policies before sending sensitive content.

## Reporting a vulnerability

Open a private GitHub Security Advisory for the repository. Do not include API
keys, tokens or user session content in a public issue.

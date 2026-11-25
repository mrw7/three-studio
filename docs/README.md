# Documentation

- [Live demo gallery](https://mrw7.github.io/three-studio/) — the static agency,
  configurator, education, motion, audio, data and space demos
- [Open-core boundary](OPEN-CORE.md) — what is Apache-2.0, what stays private,
  and how the Pro template pack is assembled ([中文](OPEN-CORE.zh.md))
- [Architecture](ARCHITECTURE.md) — standalone components, data flow, scene
  engine and agent loop
- [Models and providers](MODELS.md) — built-in providers, custom providers,
  credentials and wire behavior
- [Plugins and marketplace](PLUGINS.md) — catalog format, all twenty plugins,
  configuration files, runtime contract, install/uninstall and security rules
  ([中文](PLUGINS.zh.md))
- [Exports](EXPORTS.md) — every export target, USDZ/FBX scope and limits,
  verification commands ([中文](EXPORTS.zh.md))
- [Manual and film](MANUAL-FILM.md) — manual steps, film export, limits and the
  open-core/Pro boundary
- [Security](SECURITY.md) — sandbox, credentials, network egress, plugin trust
  and known limitations ([中文](SECURITY.zh.md))
- [Plugin trust boundaries](TRUST-BOUNDARIES.md) — frozen decisions for MCP,
  browser automation and the web pane ([中文](TRUST-BOUNDARIES.zh.md))
- [Development](DEVELOPMENT.md) — layout, run, tests, screenshots and data reset
- [Scene/editor protocol](PROTOCOL.md) — commands, tracks, assets, editor state,
  exports and sharing
- [Optional Harness plugin mode](HARNESS-PLUGIN.md) — the historical
  host-integrated build
- [IP provenance audit](IP-PROVENANCE-AUDIT.md) — isolation from local reference
  clones (Chinese)
- [Plugin research](../standalone/plugins/RESEARCH.md) — capability triage for
  the marketplace
- [Plugin configuration examples](../examples/plugin-config/README.md) —
  copy-ready `mcp.json`, `browser-automation.json`, `search.json`,
  `hooks.json` and `AGENTS.md` samples ([中文](../examples/plugin-config/README.zh.md))

Chinese versions exist for the reader-facing docs: [OPEN-CORE.zh.md](OPEN-CORE.zh.md),
[PLUGINS.zh.md](PLUGINS.zh.md), [EXPORTS.zh.md](EXPORTS.zh.md) and
[SECURITY.zh.md](SECURITY.zh.md).

Screenshots live in [`screenshots/`](screenshots/). The standalone deployment
guide is [`standalone/README.md`](../standalone/README.md).

Internal design briefs, batch plans, `AUDIT.md` and `TODO.md` are intentionally
kept out of the public repository state.

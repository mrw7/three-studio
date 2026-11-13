# Contributing

This repository is **not currently open source**. No license is granted and the
source is published for viewing and evaluation only. Do not submit unsolicited
code contributions; open an issue to discuss a change first. If you are invited
to contribute, the following applies.

## Ground rules

- Never commit API keys, tokens, `.env` files, user sessions or `~/.three-studio`
  data.
- Keep generated scenes, screenshots and test artifacts free of personal data.
- Do not copy source or assets from third-party projects; document any
  inspiration in the PR.
- Keep the scene iframe sandbox unchanged unless the security implications are
  reviewed.

## Development checks

```sh
~/.local/node24/bin/node --check client.js
~/.local/node24/bin/node --check index.js
~/.local/node24/bin/node --check standalone/server.mjs
~/.local/node24/bin/node --check standalone/agent.mjs
~/.local/node24/bin/node --test \
  tests/assets.test.mjs tests/behavior.test.mjs tests/export.test.mjs \
  tests/history.test.mjs tests/share.test.mjs tests/smoke.test.mjs \
  tests/studio-ai.test.mjs tests/tracks.test.mjs \
  standalone/plugins/runtime.test.mjs
```

`tests/disk.test.mjs` is excluded locally because its disk-lock probes hang in
this WSL environment; run it on a native filesystem or in CI.

## Documentation

Update the affected README or docs page in the same change. UI copy must exist in
both Chinese and English dictionaries. Plugin additions update
`standalone/plugins/catalog.mjs`, `runtime.mjs`, `runtime.test.mjs` and
`docs/PLUGINS.md`.

## Pull requests

- Keep changes focused and describe the user-visible effect.
- Include test output and screenshot changes when a surface changes.
- End commit messages with the project's attribution line if the repository
  requires one.

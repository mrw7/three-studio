# Contributing

Three Studio is open source under the Apache License 2.0. Contributions are
welcome. Open an issue for a user-visible change or a new plugin before writing
a large patch, so the scope and security impact can be discussed first.

## Ground rules

- Sign off every commit with the Developer Certificate of Origin 1.1
  (`git commit -s`; text in [`DCO`](DCO)). We do not require a CLA for the
  core.
- Disclose AI assistance in the pull request. You remain responsible for the
  code, its licensing and its tests.
- Never commit API keys, tokens, `.env` files, user sessions or `~/.three-studio`
  data.
- Keep generated scenes, screenshots and test artifacts free of personal data.
- Do not copy source or assets from third-party projects; document any
  inspiration and license in the PR.
- Keep the scene iframe sandbox unchanged unless the security implications are
  reviewed. Never add `allow-same-origin` or serve a scene as a navigable URL.
- Do not add arbitrary third-party plugin execution. The plugin market installs
  native in-repo modules only.

## Development checks

```sh
~/.local/node24/bin/node --check client.js
~/.local/node24/bin/node --check index.js
~/.local/node24/bin/node --check standalone/server.mjs
~/.local/node24/bin/node --check standalone/agent.mjs
~/.local/node24/bin/node --check standalone/public/boot.js
npm test
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
- Add a regression test for security-sensitive changes (API routes, sandbox,
  credentials, plugin boundaries, path handling).
- State any AI assistance and any third-party code or assets you used.
- Every commit must be signed off (`Signed-off-by:`), certifying the DCO 1.1.
- End commit messages with the project's attribution line if the repository
  requires one.

## Security

Do not open a public issue with exploit details. Use a private GitHub Security
Advisory as described in `SECURITY.md`.

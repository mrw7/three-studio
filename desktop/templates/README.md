# Template pack slot

The public repository ships the **pack contract**, not the paid scenes.

- `manifest.json` — the free pack. It is empty in the open-source repository;
  the schema and validation live in `scripts/template-pack.mjs`.
- `pro/` — created at build time by `scripts/assemble-templates.mjs` from the
  private Pro pack. Gitignored; never commit it.

The desktop app opens the assembled pack via **Help → Open Pro templates** when
a Pro license with the `templates` feature is active. The private pack lives
outside this repository (`../three-studio-private/pro-templates` by default) and
is assembled with:

```sh
cd desktop
THREE_STUDIO_PRO_TEMPLATES=/path/to/three-studio-private/pro-templates npm run templates
npm run release-check
npm run dist
```

See [`../README.md`](../README.md) and
[`../../docs/OPEN-CORE.md`](../../docs/OPEN-CORE.md) for the open/private
boundary.

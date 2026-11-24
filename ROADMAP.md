# Roadmap

This roadmap describes the open-source core. Hosted, team and enterprise
services may be developed separately; the core must stay useful without them.

## 0.2.0 — external beta hardening

- [x] Apache-2.0 license, NOTICE, governance, DCO, code of conduct and
      trademark/privacy documents.
- [x] Loopback API `Host`/`Origin`/`Sec-Fetch-Site` checks, per-process token,
      JSON content type and route body limits, with regression tests.
- [x] MCP child processes in a dedicated working directory with a minimal
      environment.
- [ ] DNS pinning for `web_fetch` and redirect re-checks for browser automation.
- [ ] Full CSP for the Studio shell, validated against the sandboxed preview.
- [ ] Real-provider E2E (OpenAI-compatible and Anthropic) in addition to the
      mock gateway.
- [x] Portable snapshot storage for macOS/Windows scenes, revision history,
      assets, share links and thumbnails, with corruption quarantine and
      restart tests.
- [x] Linux fd store → portable snapshot migration command, with a restart
      test that loads the migrated data in portable mode.
- [x] Portable → portable merge/import with skip/replace conflict policies and
      a cross-process merge test.
- [x] Sessions and non-secret provider settings merge between Studio homes,
      with backups, compaction, dry-run and no credential copying.
- [ ] Project ZIP re-import and a truly self-contained Standalone HTML option.
- [x] Desktop alpha scaffold (Electron shell, unsigned, Node 24 on PATH).
- [x] `prepare-node` bundling script for the packaged app (current platform or
      a supplied target Node 24 binary).
- [x] CI packaging matrix for Linux/macOS x64+arm64/Windows, with unsigned
      installer artifacts.
- [x] Code-signing/notarization secret wiring in the desktop workflow.
- [x] Desktop Pro offline license/activation, PRO badge and template pack.
- [x] Open-core boundary: public core + contract; paid Pro scenes assemble from
      a private pack into gitignored `desktop/templates/pro/`.
- [ ] Payment checkout + license fulfillment automation.
- [ ] Publish signed releases automatically and add auto-update.

## Sales demos

- [x] Agency interactive product page (`site/agency-demo/`).
- [x] Product configurator demo (`site/configurator-demo/`, finish/shade/light,
      price, GLB export).
- [x] Education/workshop walkthrough demo (`site/education-demo/`).
- [x] Motion studies: particle galaxy (`site/nebula-demo/`) and physical
      material sculpture (`site/kinetic-demo/`).
- [x] Audio visualizer (`site/audio-demo/`), data globe (`site/data-demo/`) and
      spatial walkthrough (`site/atrium-demo/`).
- [x] Demo gallery (`site/index.html`).
- [x] Bilingual gallery/demos, English by default with a remembered Chinese
      toggle (`site/i18n.js`).
- [x] Free static hosting path (`.github/workflows/pages.yml`, Cloudflare
      Pages/Netlify instructions in `site/README.md`).
- [ ] Landing page + checkout + license fulfillment automation.

## 0.3.0 — workflow depth

- [ ] More deterministic export coverage (skinning/animation limits documented
      per format).
- [ ] Curated asset/model-provider plugins (Meshy/Tripo/Rodin-style APIs) as
      optional native modules.
- [ ] Template packs for agency/marketing and product-configurator workflows.
- [ ] Better accessibility and small-screen editing coverage.

## Later / separate services

- [ ] Hosted share viewer and team review (proprietary service).
- [ ] Team workspaces, SSO/SAML, audit logs and enterprise policy.
- [ ] Model gateway and usage metering for managed AI.
- [ ] Signed plugin registry with a permission manifest; never execute
      arbitrary downloaded code in-process.

## Non-goals

- Multi-tenant accounts, billing or telemetry in the local core.
- Running arbitrary third-party plugin code in-process.
- Serving scene code as a navigable URL or adding `allow-same-origin` to the
  preview sandbox.

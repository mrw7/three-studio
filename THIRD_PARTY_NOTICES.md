# Third-party notices

This repository includes or derives from the following third-party components.
Their licenses apply to those components; the rest of the repository is
licensed under the Apache License 2.0 (see `LICENSE` and `NOTICE`).

## Three.js

- Version: r186 (0.186.1)
- License: MIT
- Files: `runtime/three.module.js`, `runtime/three.core.js`, loaders,
  controls, exporters and related files under `runtime/` and `site/runtime/`
- License texts: `runtime/THREE-LICENSE.txt`, `site/runtime/THREE-LICENSE.txt`

## Export helper libraries

These pinned builds are used by deterministic MP4/GIF export, USDZ export and the share viewer QR code.

- `runtime/vendor/fflate.module.js` — fflate 0.8.2, MIT; license header in
  the file.
- `runtime/vendor/gifenc.js` — gifenc 1.0.3, MIT; license text in
  `runtime/vendor/GIFENC-LICENSE.txt`.
- `runtime/vendor/mp4-muxer.js` — mp4-muxer 5.2.2, MIT; license text in
  `runtime/vendor/MP4-MUXER-LICENSE.txt`.
- `runtime/vendor/qrcode-generator.js` and `runtime/vendor/qrcode_UTF8.js` —
  qrcode-generator 1.4.4, MIT; license text in
  `runtime/vendor/QRCODE-LICENSE.txt`.
- Provenance, versions and SHA-256 pins: `runtime/vendor/README.md`.

## Electron and Chromium

The optional `desktop/` app bundles Electron and Chromium at build time.
`electron-builder` includes their license texts in the packaged application;
they are development/runtime dependencies and are not committed to this
repository.

## React and ReactDOM

- Version: 18.3.1
- License: MIT
- Files: `standalone/public/vendor/react.production.min.js`,
  `standalone/public/vendor/react-dom.production.min.js`
- License texts: `standalone/public/vendor/REACT-LICENSE`,
  `standalone/public/vendor/REACT-DOM-LICENSE`

## DeepSeek Harness

The project was designed after studying the DeepSeek Harness package ecosystem
(MIT). The standalone build does **not** bundle or require Harness runtime code.
Package paths cited in `standalone/plugins/catalog.mjs`,
`standalone/plugins/RESEARCH.md` and the documentation are provenance references
for capabilities and design research.

## Development tools

Playwright is used by maintainers for screenshot capture and browser checks. It
is not distributed with the Studio. See the Playwright license when installing it
locally.

## Project license

The project's own code is licensed under the Apache License 2.0. See `LICENSE`
and the README license section.

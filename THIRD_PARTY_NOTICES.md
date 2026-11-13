# Third-party notices

This repository includes or derives from the following third-party components.
Their licenses apply to those components; the rest of the repository is
published without a license (all rights reserved).

## Three.js

- Version: r186 (0.186.1)
- License: MIT
- Files: `runtime/three.module.js`, `runtime/three.core.js`, loaders,
  controls, exporters and related files under `runtime/`
- License text: `runtime/THREE-LICENSE.txt`

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

## No license for this repository

Nothing in this file grants a license to the project's own code. See the README
license section.

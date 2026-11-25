# Three Studio demos

**Live:** <https://mrw7.github.io/three-studio/>

Static sales demos that can be deployed to any static host. They are separate
from the Studio runtime and do not call the local API.

```sh
python3 -m http.server 4173 --directory site
# http://127.0.0.1:4173/
```

The root `index.html` is the demo gallery. Shared vendored Three.js r186 lives
in `runtime/`.

## Demos

- [`one-minute-demo/`](one-minute-demo/README.md) — ONE MINUTE, a 60-second
  procedural film with a six-chapter timeline and playback controls
- [`lamplighter-demo/`](lamplighter-demo/README.md) — THE LAMPLIGHTER 点灯人, a
  60-second ten-shot film with hard cuts, a procedural character, SRT captions
  and a deep-linkable player
- [`agency-demo/`](agency-demo/README.md) — AUREL scroll-driven 3D product page
  for the agency/marketing offer
- [`configurator-demo/`](configurator-demo/README.md) — LUMEN real-time product
  configurator with materials, light temperature, price rules and GLB export
- [`education-demo/`](education-demo/README.md) — ORBIT LAB four-step solar
  system workshop with code snippets
- [`engine-demo/`](engine-demo/README.md) — TURBOFAN eight-step digital manual
  over a procedural turbofan, with a BOM, per-step cameras and hotspots
- [`nebula-demo/`](nebula-demo/README.md) — 120K-particle galaxy with a custom
  GLSL shader, three palettes and live FPS
- [`kinetic-demo/`](kinetic-demo/README.md) — animated torus-knot sculpture with
  chrome/gold/iridescent physical materials
- [`audio-demo/`](audio-demo/README.md) — SONAR audio-reactive spectrum with
  microphone and silent demo track
- [`data-demo/`](data-demo/README.md) — SIGNAL 3D globe with routes, city labels
  and switchable synthetic datasets
- [`atrium-demo/`](atrium-demo/README.md) — procedural gallery corridor with a
  scroll/drag camera walkthrough

All demos are procedural, responsive, and free of external fonts/CDNs/assets.

## Generated demo sources

`engine-demo/` and `lamplighter-demo/` are built from the sandbox scenes under
`examples/`, so the gallery and the Studio never diverge:

```sh
node site/scripts/generate-demos.mjs
```

It writes `*/scene.js` (the example body wrapped with the globals the preview
provides), `engine-demo/manual.js`, `lamplighter-demo/film.js` and leaves the
hand-written `index.html`, `main.js`, `styles.css` and `README.md` alone. The
`preview.png` frames are captured from the running pages; see each demo's README
for the deep link used.

English prices on the gallery are localized USD list prices, not a symbol-swapped
copy of the CNY prices.

The gallery and every demo default to English. The header toggle switches to
Chinese, reloads the page so dynamic labels rebuild through `t()` in
[`i18n.js`](i18n.js), and remembers the choice in `localStorage`. Append
`?lang=en` or `?lang=zh` to a URL to force a language for a shared link.
Contact buttons use `three.studio.2026@outlook.com`; change them if you deploy
your own copy.

## Deploy

Everything here is static: HTML, CSS, ES modules and the vendored Three.js
runtime. There is no build step and no server-side code, so any static host
works. Publish the `site/` directory itself (not the repository root) so
`runtime/` and the demo folders stay siblings.

| Host | Free tier | Commercial use | Setup |
| --- | --- | --- | --- |
| **Cloudflare Pages** | unlimited bandwidth, 500 builds/month | yes | Connect the repo with an empty build command and output directory `site`, or run `npx wrangler pages deploy site` |
| **GitHub Pages** | 100 GB/month soft bandwidth, 1 GB site | yes | The bundled workflow (`.github/workflows/pages.yml`) deploys `site/` on pushes to `main` that touch it; set Settings → Pages → Source to “GitHub Actions” once |
| **Netlify** | 100 GB/month | yes | Drag `site/` onto <https://app.netlify.com/drop>, or connect the repo with publish directory `site` |
| **Vercel** | 100 GB/month | **no** on Hobby | Hobby excludes commercial use; use Pro or another host for client work |

Recommended: **Cloudflare Pages** for the gallery (no bandwidth cap, and the
edge cache keeps the ~1 MB Three.js runtime fast) with **GitHub Pages** as the
zero-config fallback. Both include HTTPS and a free custom domain.

Every path is relative, so a project site such as
`https://<user>.github.io/three-studio/` works without base-path configuration.
The demos never call the Studio API or a CDN.

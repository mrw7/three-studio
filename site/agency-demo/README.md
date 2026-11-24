# AUREL — agency interactive page demo

A self-contained Three.js product page used to sell the agency/marketing
offer. It is **not** part of the Studio runtime: it is a static demo with a
vendored Three.js module, scroll-driven camera, live material variants and
responsive copy.

## Run

```sh
python3 -m http.server 4173 --directory site
# open http://127.0.0.1:4173/agency-demo/
```

No build step. The shared `site/runtime/` folder contains the vendored Three.js
r186 module and its MIT license.

## What it demonstrates

- A sticky real-time WebGL scene behind long-form marketing copy
- Scroll-driven camera path with smooth interpolation and mouse parallax
- Four live material variants (Azure / Graphite / Champagne / Ember)
- Responsive panels for desktop and mobile
- Reduced-motion handling, loading state and a scroll progress bar
- All geometry and textures are procedural; no external assets/models

## Use it for sales

1. The contact button points at `three.studio.2026@outlook.com`; change it in
   `index.html` if you deploy your own copy.
2. Replace the AUREL copy/brand if you want, but keep the disclaimer in the
   footer (AUREL is fictional).
3. Record a 60–90 second screen capture: hero → scroll details → variant
   switch → contact.
4. Use it as the “agency” case in your landing page; link to the live demo and
   the source.
5. Offer the same page as a **2-week sprint**:
   - **Single scene** (`¥1.5万–2.5万`): one editable scene, responsive layout,
     performance pass, exports and handoff; client provides design/models.
   - **Design + modeling** (`¥2.5万–4万`): the same scope plus visual and 3D
     model adaptation.

## Customize

- `scene-watch.js` — procedural watch scene (adapted from the Studio example);
  edit materials/geometry or replace it with another product.
- `main.js` — renderer, camera keyframes, scroll/parallax, variants.
- `styles.css` — layout, typography, panels, responsive rules.
- `index.html` — copy and sections.

The scene wrapper expects the same helpers the Studio preview provides:
`renderer`, `camera`, `scene`, `controls`, `onFrame` and `wb.id`. That makes it
easy to port a Studio scene into a standalone marketing page.

## Notes

- Three.js is vendored under `runtime/` (MIT; see `runtime/THREE-LICENSE.txt`).
- No analytics, fonts, CDNs or external requests are used.
- The demo is intentionally a static site; deploy it to any static host.

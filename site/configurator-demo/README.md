# LUMEN — product configurator demo

A static, real-time product configurator for the configurator/commerce offer.
It shows live materials, shade geometry, light temperature, price rules and GLB
export; it can later be wired to a product catalog, Shopify/CPQ and AR.

## Run

```sh
python3 -m http.server 4173 --directory site
# open http://127.0.0.1:4173/configurator-demo/
```

Shared vendored Three.js r186 + `OrbitControls` + `GLTFExporter` live in
`site/runtime/`.

## What it demonstrates

- Procedural desk lamp: no external models or textures
- Four finishes, two shade shapes, three light temperatures
- Real-time price update and configuration JSON
- GLB download through the real three.js `GLTFExporter`
- Orbit controls, responsive split layout, reduced-motion support

## Sales use

- The contact button points at `three.studio.2026@outlook.com`; change it for your own
  deployment.
- Record a 30–60 second clip: switch finish → shade → light → download GLB.
- Offer as a **Product Configurator MVP**: 4–6 weeks, ¥60k–150k, including
  options/rules, GLB/USDZ export, responsive embed and handoff.
- The demo intentionally stops at “configurator MVP”; full CPQ/PIM/inventory is
  a separate integration scope.

## Customize

- `main.js` — lamp geometry, materials, options, price rules, export.
- `styles.css` — cream editorial layout and config panel.
- `index.html` — copy, options and CTA.

## Notes

- GLB export excludes the ground/cable; the lamp group is exported.
- The demo has no analytics, external fonts or CDN requests.

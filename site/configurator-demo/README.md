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

- Desk lamp built from lathe-turned profiles: chamfered cast base, turned
  collar, knurled band, machined shoulder, pivot pin, tapered arm with a
  counterweight and a frosted diffuser — no external models or textures
- Shades are an open metal cone plus a separate matte inner cone 30 mm apart,
  which is what stops a double-sided reflective shell from mirroring itself
- Four finishes, two shade shapes, three light temperatures
- Real-time price update and configuration JSON
- GLB download through the real three.js `GLTFExporter`
- Orbit controls, responsive split layout, reduced-motion support

## Sales use

- The contact button points at `three.studio.2026@outlook.com`; change it for your own
  deployment.
- Record a 30–60 second clip: switch finish → shade → light → download GLB.
- Offer as a **Product Configurator MVP**: 4–6 weeks, `¥6万–10万`, including
  options/rules, GLB/USDZ export, responsive embed and handoff.
- Quote **catalog/Shopify/CPQ/AR integration** separately: `¥10万–20万+`, by
  scope. The demo intentionally stops at “configurator MVP”; full
  CPQ/PIM/inventory is a separate integration scope.

## Customize

- `main.js` — lamp geometry, materials, options, price rules, export.
- `styles.css` — cream editorial layout and config panel.
- `index.html` — copy, options and CTA.

## Notes

- Prices are localized: CNY on the Chinese page and USD on the English page.
  They are separate price lists, not a 1:1 currency-symbol swap.
- GLB export excludes the ground/cable; the lamp group is exported.
- The demo has no analytics, external fonts or CDN requests.

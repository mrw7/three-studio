# TURBOFAN — turbofan digital manual

An eight-step interactive manual over a procedurally modelled high-bypass
turbofan. No models, textures, fonts or CDNs: the engine and every step are
generated in the browser.

**Live:** <https://mrw7.github.io/three-studio/engine-demo/>

## Run

```sh
python3 -m http.server 4173 --directory site
# open http://127.0.0.1:4173/engine-demo/
```

Shared vendored Three.js r186 lives in `site/runtime/`.

## What it demonstrates

- A procedurally built turbofan: inlet lip, 22-blade fan with root→tip twist,
  nacelle with two thrust-reverser grille rings, five-stage axial compressor,
  annular combustor with 16 injectors (pulsing emissive), three-stage turbine,
  nozzle cone, pylon and accessory gearbox.
- An eight-step manual (overview → intake/fan → nacelle → compressor →
  combustor → turbine/nozzle → pylon → final inspection) with a seven-part BOM.
- Per-step cameras with an eased tween, authored part hiding, emissive
  highlight of the step's focus object, hotspot chips that frame the object,
  clickable BOM rows, and ← / → keyboard navigation.
- One scene serves three surfaces: this manual page, a share viewer, and the
  film/screenshot source.

## Generated files

`scene.js`, `manual.js` and this demo's `preview.png` are generated. Do not edit
them by hand:

```sh
node site/scripts/generate-demos.mjs
```

`scene.js` wraps `examples/scene-engine.js` (the sandbox scene) with the globals
the preview provides, so the example stays the single source of truth.
`manual.js` is `examples/turbofan-manual.json`'s manual object. `index.html`,
`main.js`, `styles.css` and this README are hand-written.

## Sales use

- Product manuals, installer training and after-sales documentation for a
  physical product that already has CAD or a low-poly model.
- Because steps are data (camera + text + parts + highlights), the same page can
  be re-authored for a second product without touching the renderer.
- The BOM and hotspot structure maps directly to spare-parts tables and
  installation checklists.

## Notes

- Every `wb.id` referenced by the manual exists in `examples/scene-engine.js`;
  `tests/examples.test.mjs` fails the build if that drifts.
- The preview frame is a 1440×900 screenshot of the page at step 01.

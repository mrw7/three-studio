# ORBIT LAB — education/workshop demo

A four-step Three.js workshop: build a solar system in the browser, with live
scene preview, code snippets and teaching tips. It is a sales asset for
education/training, not a full LMS.

## Run

```sh
python3 -m http.server 4173 --directory site
# open http://127.0.0.1:4173/education-demo/
```

Shared vendored Three.js r186 + `OrbitControls` live in `site/runtime/`.

## What it demonstrates

- Four guided steps: stage → sun → orbits → moon
- Step 01 shows the scaffolding the first lesson actually creates — a camera
  frustum gizmo, the two light-rig markers and the origin axes over the ground
  grid — instead of an empty frame
- Live scene that changes with each step
- Matching code snippet and teaching tip per step
- Copy-code action, progress bar, play/pause and responsive layout
- Fully procedural scene; no external assets

## Sales use

- The contact button points at `three.studio.2026@outlook.com`; change it for your own
  deployment.
- Record a 2–3 minute walkthrough: step 1 → step 4 → copy code.
- Offer as a **workshop**: 90 minutes (`¥2,980`), half day (`¥4,800`), full day
  (`¥6,800–9,800`) or 2 days (`¥12,800–18,800`); corporate teams,
  design/frontend groups and universities.
- Use the free 60-minute version as a lead magnet; sell the recorded course or
  team workshop as the paid product.

## Customize

- `main.js` — scene, steps, code snippets and tips.
- `styles.css` — workshop layout and stage.
- `index.html` — course copy and CTA.

## Notes

- The code snippets are deliberately short and illustrative; the actual scene
  is the source of truth.
- No analytics, external fonts or CDN requests.

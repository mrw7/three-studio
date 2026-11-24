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
- Live scene that changes with each step
- Matching code snippet and teaching tip per step
- Copy-code action, progress bar, play/pause and responsive layout
- Fully procedural scene; no external assets

## Sales use

- The contact button points at `three.studio.2026@outlook.com`; change it for your own
  deployment.
- Record a 2–3 minute walkthrough: step 1 → step 4 → copy code.
- Offer as a **workshop**: 90 minutes to 2 days, ¥3k–8k/day; corporate teams,
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

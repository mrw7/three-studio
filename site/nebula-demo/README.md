# NEBULA — GPU particle motion study

A full-screen motion study: 120,000 particles (52,000 on mobile) in a
differentially rotating spiral galaxy, driven by a custom GLSL shader. It is a
visual demo for motion backgrounds, launch pages and creative pitches.

## Run

```sh
python3 -m http.server 4173 --directory site
# open http://127.0.0.1:4173/nebula-demo/
```

## What it demonstrates

- Custom vertex/fragment shader for size, twinkle and per-particle rotation
- 120K points with additive blending; no textures or external assets
- Three palettes: Aurora / Ember / Ice
- Regenerate the galaxy with a new seed
- Pause, palette switch, orbit/zoom controls and an FPS HUD
- Mobile particle budget

## Customize

- `main.js` — galaxy generator, shader, palettes and animation.
- `styles.css` — overlay composition and responsive controls.
- `index.html` — title/copy and HUD.

## Sales use

Use as a hero/loop background for brand launches, event sites or keynote
openers. The same particle system can be adapted to a product reveal, audio
reactivity or a data-driven constellation.

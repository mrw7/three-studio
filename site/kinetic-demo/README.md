# KINETIC — real-time metal sculpture

A full-screen motion study: an animated torus knot with real-time physical
materials, a procedural environment, a ghost wireframe shell, an orbiting halo
and material switching. It is a visual demo for product/abstract motion.

## Run

```sh
python3 -m http.server 4173 --directory site
# open http://127.0.0.1:4173/kinetic-demo/
```

## What it demonstrates

- `MeshPhysicalMaterial` chrome/gold/iridescent variants
- Procedural PMREM environment for reflections
- Animated torus knot, ghost shell, halo and orbiting satellites
- Speed slider, pause, reset view and FPS HUD
- Orbit controls and reduced-motion-friendly layout

## Customize

- `main.js` — geometry, materials, environment, lights and animation.
- `styles.css` — overlay composition and responsive controls.
- `index.html` — title/copy and HUD.

## Sales use

Use as a hero animation for hardware/consumer products, a brand ident or a
keynote transition. The material/environment setup is reusable for product
reveals and configurable hero objects.

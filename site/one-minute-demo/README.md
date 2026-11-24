# ONE MINUTE — a 60-second procedural film

A silent, self-contained Three.js short: a seed drifts in the void, grows into
a luminous tree, gathers a swarm and dissolves into a planet and a ring of
stars. Six chapters, 60 seconds, no video, textures, fonts or CDNs.

## Run

```sh
python3 -m http.server 4173 --directory site
# open http://127.0.0.1:4173/one-minute-demo/
```

Shared vendored Three.js r186 lives in `site/runtime/`.

## What it demonstrates

- A 60-second timeline with six chapters and camera choreography
- Procedural fractal tree drawn with line and point shaders
- GPU particle swarm, procedural planet, atmosphere and ring shaders
- Playback UI: play/pause, seek, replay, fullscreen and keyboard shortcuts
- `prefers-reduced-motion` starts paused on a representative frame
- `?t=36&paused=1&still=1` deep-links a frozen frame for previews and stills

## Sales use

- Use it as a brand opener, launch film or gallery loop; the six-chapter
  structure makes it easy to re-time for a 30- or 90-second cut.
- Swap the seed/tree/planet palette and the end card to fit a product story.
- The film is silent by design, so it can autoplay in a booth or lobby without
  an audio permission prompt.

## Customize

- `main.js` — scene, shaders, timeline, camera keys and player logic.
- `styles.css` — cinematic chrome, title/end cards and player layout.
- `index.html` — copy, chapter labels and controls.

## Notes

- No external assets or network requests; all geometry and color are procedural.
- The player pauses when the tab is hidden.
- The preview frame is rendered from `?t=36&paused=1&still=1`.

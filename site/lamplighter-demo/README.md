# The Lamplighter 点灯人 — a 60-second film

A silent, ten-shot short. A small robot that lives on the bulb in its chest walks
a foggy street, climbs a lamp post, falls, climbs again and screws its own light
into the socket — then goes dark so the whole street can glow.

**Live:** <https://mrw7.github.io/three-studio/lamplighter-demo/>

## Run

```sh
python3 -m http.server 4173 --directory site
# open http://127.0.0.1:4173/lamplighter-demo/
```

Shared vendored Three.js r186 lives in `site/runtime/`.

## What it demonstrates

- Ten hard cuts, not one flying camera: `SHOTS` in the example holds ten
  independent camera setups and the timeline selects one per frame.
- A procedural character (capsules and boxes) with a sine-driven walk cycle, a
  climb that follows the real lamp pole, a mid-climb fall with camera shake and
  two dying flickers, a second climb that screws the chest bulb into the socket,
  a delayed street-light cascade, a self-extinguishing silhouette and a rising
  title card.
- Cinematic depth without post-processing: the sandbox has no `EffectComposer`,
  so `FogExp2` density/colour animate across the story, bulbs use additive halo
  sprites and wet-road light pools, and shot 9 relies on the chest emission going
  to zero so only the silhouette remains. No global bloom.
- Player UI: play/pause, seek, shot chips, replay, SRT captions driven by the
  playhead, `←`/`→` to step one second, `Space` to toggle, and pause on hidden
  tab. `prefers-reduced-motion` opens on a representative frame instead of
  autoplaying.

## Deep links

| URL | Result |
| --- | --- |
| `?t=39.6&paused=1` | frozen on shot 7 (first light) |
| `?t=26.9&paused=1&still=1` | frozen on the fall |
| `?t=57.5&paused=1` | frozen on the title card |

## Generated files

`scene.js`, `film.js` and this demo's `preview.png` are generated. Do not edit
them by hand:

```sh
node site/scripts/generate-demos.mjs
```

`scene.js` wraps `examples/scene-lamplighter.js` with the globals the preview
provides, so the example stays the single source of truth. `film.js` is the
storyboard (shot list) plus the SRT captions from
`examples/lamplighter-film.json`. `index.html`, `main.js`, `styles.css` and this
README are hand-written.

## Sales use

- A brand opener, launch film or gallery loop that can be re-timed to 30 or 90
  seconds by editing the shot table.
- Swap the palette, the character silhouette and the end card and the same
  structure carries a product story.
- Silent by design, so it can autoplay in a booth or lobby without an audio
  permission prompt; the captions are a real sidecar, not baked pixels.

## Notes

- The preview frame is a 1440×900 screenshot of `?t=39.6&paused=1&still=1`.
- The film pauses when the tab is hidden.
- No external assets or network requests; every frame is computed.

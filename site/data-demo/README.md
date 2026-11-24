# SIGNAL — 3D data globe

A synthetic global-network visualization: a dotted globe, eight city nodes,
twelve routes, animated packets and three switchable datasets.

## Run

```sh
python3 -m http.server 4173 --directory site
# open http://127.0.0.1:4173/data-demo/
```

## What it demonstrates

- Procedural globe with graticule, dotted surface and atmosphere
- Lat/lon city nodes with canvas labels and glows
- Quadratic-bezier routes with animated pulses
- Traffic / Latency / Capacity dataset switching
- Orbit controls, pause/reset, HUD and FPS

The data is synthetic; it is a visual demo, not a real network feed.

## Sales use

Use for infrastructure, logistics, fintech, SaaS telemetry or “global network”
narratives. A real deployment can swap the synthetic routes for an API or a
dataset and keep the same scene.

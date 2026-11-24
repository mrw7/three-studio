# SONAR — audio visualizer

A full-screen audio-reactive demo. The microphone is optional; a silent
procedural demo track can drive the visuals without any uploaded audio.

## Run

```sh
python3 -m http.server 4173 --directory site
# open http://127.0.0.1:4173/audio-demo/
```

## What it demonstrates

- Web Audio `AnalyserNode` frequency and time-domain data
- 96 instanced frequency bars in a radial layout
- Waveform ring, reactive core and particles
- Microphone input or a silent procedural demo track
- Pause, source switching, reset view and FPS/level HUD

Audio never leaves the browser. The demo track is generated with oscillators
and routed to a near-silent output so it drives the analyser without noise.

## Sales use

Use for music/brand/event pages, launch teasers, audio-reactive installations,
or as a live visual layer for a product demo. A mic-driven installation is a
natural add-on for events and retail spaces.

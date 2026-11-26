# Scene examples

These are standalone scene scripts for the Three.js sandbox. They use the
globals provided by the preview (`THREE`, `scene`, `camera`, `renderer`,
`clock`, `controls`, `onFrame`, `wb`, `setBackground`, asset helpers).

## Scenes

- `scene-watch.js` — blue mechanical watch product showcase (the scene used in
  the documentation screenshots)
- `scene-city.js` — procedural hand-drawn night city
- `scene-engine.js` — procedural turbofan engine (fan, core, combustor, turbine,
  nozzle, nacelle, pylon). Ships with `turbofan-manual.json`.
- `scene-lamplighter.js` — *The Lamplighter*: a 60-second, ten-shot
  film with hard cuts, procedural gait, climbing, a fall, a lamp-lighting
  cascade and a title card. Ships with `lamplighter-film.json`.

## Product content

Two JSON documents accompany the scenes. Both are ordinary editor state, so
they can be pasted into the app or applied as a `workbench_proposal`:

- `turbofan-manual.json` — `{ v: 1, manual, film }`: an eight-step manual
  (overview → intake/fan → nacelle → compressor → combustor → turbine/nozzle →
  pylon → final inspection) with a seven-part BOM, per-step cameras, hidden
  UIDs, highlights and hotspots. Every UID refers to a `wb.id` declared in
  `scene-engine.js`.
- `lamplighter-film.json` — `{ v: 1, manual, film }`: the film settings plus ten
  SRT captions, one per shot of the storyboard.

To load a manual: open the **Manual** rail panel and apply it through the AI
proposal flow, or paste the `manual` object into the editor record. The Film
captions go through the Film drawer's SRT box (`lamplighter-film.json` →
`film.captions` is already the parsed form).

## Routes for the animated character

`scene-lamplighter.js` uses the procedural route: the robot is capsules and
boxes, and every motion (walk cycle, climb, fall, sit) is driven by pure code in
`onFrame`. That keeps the film fully local and revision-controlled. The other
two routes from the storyboard note — glTF + Mixamo, or fully baked Blender
animation — would swap the character group for an `assets.model(...)` holder and
leave the shot table untouched, because shots address world position, not rig
internals.

## Camera craft used by the film

- **Hard cuts, not one flying camera.** `SHOTS` holds ten independent camera
  setups; the shot is selected from the timeline and the camera is repositioned
  every frame of that shot.
- **Depth cues without post-processing.** The sandbox has no EffectComposer, so
  depth is expressed with `FogExp2` (density and colour animate across the
  story), additive glow sprites for the lamps, a ground light pool, and
  silhouette geometry. No global bloom: only the bulbs, the chest light and the
  wet-road pools emit.
- **Two story fulcrums.** Shot 5 (the fall) and shot 9 (the self-extinguishing)
  carry the whole piece; both are driven by explicit curves
  (`climbHeight`, `chestIntensity`) rather than being left to ambient motion.

## Using an example

Ask the AI to adopt one, paste it into a prompt as the scene code, or seed it
through the scene engine during development. The examples are provided as
reference material and are covered by the repository's no-license notice.

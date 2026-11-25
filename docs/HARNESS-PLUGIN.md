# Optional Harness plugin mode

> This document describes the original host-integrated mode: the workbench
> loaded as a DeepSeek Harness client plugin. It is **optional**. The primary
> deployment is the standalone Studio in [`standalone/`](../standalone/README.md),
> which needs no Harness runtime.

# AI-native Three.js Workbench

A host-integrated workbench that turns the chat into a live Three.js animation
workspace: the agent writes scene code with the `three_scene` tool, and a
sandboxed preview column renders it **left of the conversation**, in real time.

Layout:

```
[ nav sidebar ] [ Three.js preview ]   [ conversation ]   [ right sidebar (optional) ]
```

The preview column is a first-class frame track: resizable (drag its right
edge), collapsible from its toolbar, and reopenable from the **3D** button in
the conversation header or from a generated scene's chat card.

- **Host half** (`index.js`): the `three_scene` tool, prompt guidance, a
  scene store persisted to the Host data directory on Linux (memory-only
  elsewhere), the Session-scoped asset store, and
  `/three-workbench/{state,scene,runtime,assets}/*` routes.
- **Browser half** (`client.js`): the `workbench` column seat, a `three_scene`
  chat card, the header toggle, and a `three-preview` right-Sidebar tab.
- **Frame change** (host `packages/client/ui-layout`): a fourth
  `workbench` column with its own width, drag handle, and eligibility solve.
- **Runtime** (`runtime/`): vendored Three.js r186 (0.186.1, MIT) plus
  `OrbitControls`, `TransformControls`, and the five unmodified addons used by
  asset loading (`GLTFLoader`, `HDRLoader`, `RGBELoader`, `BufferGeometryUtils`,
  `SkeletonUtils`); served locally so previews work offline. The upstream MIT
  text ships as `runtime/THREE-LICENSE.txt` and in every project ZIP.

Every preview message and command, the sandbox/trust boundary, the P4 Back
marker, track and asset contracts, share viewer and persistence semantics are
documented with source anchors in [`docs/PROTOCOL.md`](PROTOCOL.md).

## Standalone Studio and plugin market

[`standalone/`](../standalone/README.md) runs the same Studio **without DeepSeek
Harness**: its own Node server, storage, agent loop, model providers and React
shell. Start it with `./standalone/start.sh` (port 3090). Its **Plugin market**
tab lists capabilities selected from the MIT-licensed Harness ecosystem and
adapted as native modules: skills, planning, todo, subagents and the web reader
are installable now; scheduled tasks, MCP connectors, deliverables, file and
document panes, background jobs and voice input are roadmap entries.

## Run

```sh
./start.sh                 # loopback; Windows opens http://localhost:3080
./start.sh --lan           # bind the WSL interface address instead
./start.sh --port 4000     # extra flags go to the host web command
./open.sh                  # open the Windows default browser via a tokenless handoff
```

This machine's `~/.wslconfig` uses `networkingMode=mirrored`. In mirrored mode
the Windows browser reaches a WSL service that listens on `127.0.0.1` through
`localhost`, but **not** one bound to the interface address — so the launcher
defaults to loopback and `open.sh` rewrites `127.0.0.1` to `localhost` for the
browser. `--lan` binds the interface address with `--trusted-host` entries for
NAT-style setups. Keep the server running; `open.sh` reads the token from the
startup log but never prints it or passes it to the browser. A short-lived
helper on `127.0.0.1` hands the browser a one-time redirect from a tokenless
URL, then exits; the 0600 temp file is removed on exit.

The launcher expects:

- this directory beside the host checkout, or `HARNESS_CHECKOUT=/path/to/host-checkout`
- Node >= 24.9 and pnpm 11.28.5 (the script prefers `~/.local/node24/bin`)
- the host installed and built once: `pnpm install && pnpm run build`
- the host's model API key in the environment or the harness `.env` to chat

Then in the chat ask for something visual, e.g.

> 画一个旋转的低多边形星云，带粒子流动和缓慢的镜头环绕

The agent calls `three_scene`; the preview column reloads on every revision
(1.2 s revision poll). Before the first generated scene it shows a built-in demo
with starter templates. A new result from an active call opens the column;
selecting a saved conversation does not reopen a closed preview. Close it from
its toolbar and reopen it with the **3D** button in the chat header, or open the
docked fullscreen copy from the right Sidebar's **+** menu (Three.js preview).

## Workbench controls

- **Preview / Code** switch; the iframe stays mounted so the camera survives.
- **Language** switch (**中 / EN**) in the Studio header: switches the workbench
  and the whole Host UI immediately, and persists through the Host locale
  preference. Both locales are complete; the narrow overlay exposes the same
  control as a single target-language button.
- **Display & layout** (⋯ menu): move the preview **left / top / bottom** of the
  conversation (a draggable divider sets its size), pick a frame aspect (auto,
  16:9, 1:1, 9:16, 4:3 — letterboxed), and a render resolution (0.5×–2×); the
  HUD shows the backing pixel size.
- **Stats HUD** (bottom-right of the preview): objects, triangles, FPS and draw
  calls, refreshed at 2 Hz from the sandboxed runtime; click it to collapse to
  a compact FPS chip. It is parent-page DOM outside the canvas, so it never
  appears in PNG/WebM captures, thumbnails, or exported models.
- **Filmstrip** of the last 12 revisions with rendered thumbnails; click one to
  view it, **回到最新** to return, and **▶** to replay the build as a
  thumbnail time-lapse (no WebGL reloads).
- **Building state**: while the model is writing `three_scene`, the pane shows an
  elapsed-time bar; the first scene gets a ghost stage instead of a blank canvas.
- **⋯ menu**: snapshot PNG, record a 5 s WebM, export glTF (`.glb`), reset view,
  pick an object, copy code, starter templates.
- **Templates + styles**: five starter scenes and ten style presets (neon,
  minimal, low-poly, ink, vaporwave, glass, clay, retro-futurism, night nature,
  hand-drawn); the chosen style is appended to the template prompt.
- **Pick**: click an object in the scene, describe the change, and the workbench
  sends the object's name/type/position/material plus your instruction to the
  agent as a chat prompt.
- **New task** in the AI prompt footer: with a draft, creates a fresh Host
  Session in the current Workspace, opens it, and sends the typed instruction
  with the active Intent directive as its first message. With an empty prompt it
  just opens a fresh Session and focuses the input. The new task starts with a
  fresh scene context; the prompt stays in the Studio input if creation fails.
- **Fix with AI** on the error bar sends the stack trace back to the agent.
- The preview keeps the user's camera and FOV across revisions; **Reset view**
  clears the camera override and restores the script's position, target and FOV.

## Studio mode

Studio is the default desktop surface — there is no separate entry gesture. It
opens immediately with the conversation: a 54px header with brand,
revision/status, undo/redo, playback, panel toggles, preview/code, share and AI; a
46px icon rail plus a resizable left panel (default 288px); the live stage in the centre; a resizable 312px inspector on the right; and a
timeline/console dock along the bottom (the timeline sheet is height-draggable).
The accent is cobalt (`#4f7cff`, `#2450d8` in light mode) with a prism brand
mark. The layout is a working DCC surface, but the visual language is the
workbench's own: flat charcoal panels, hairline seams, a single accent and
compact icon controls.

The studio reuses the existing Outliner, Inspector, Parameters, history,
timeline, dope sheet and console panels; it does not duplicate editor logic.
Left-panel tabs: **Scene** (outliner), **Sessions** (recent Host Sessions),
**Assets**, **Parameters**, **History** (revisions and replay/diff/restore),
**AI** (the native host conversation surface and its Settings view), and
**Display** (layout/aspect/resolution). The right
panel is the Inspector. The bottom dock switches between **Timeline** (transport
+ dope sheet), **Shots**, **Review**, **Measure**, **Log**, **Geometry** and
**Console**. At narrow desktop widths the side panels start
collapsed (`<900px` left, `<1200px` right) and the header toggles bring them
back; the stage then uses the full width.

Because Studio covers the Host sidebar, the **Sessions** tab is the way back to
an earlier conversation: it lists the user-facing Sessions in the Host catalog,
newest first with the current Session pinned, and opening a row asks the Host
main view to retain that Session while Studio stays mounted. Subagent rows and
untouched empty scratch Sessions are omitted; the active empty Session and any
empty Session visited in this page stay visible. The search field filters by
title or Session id. The header windows button and the rail entry reopen the
tab after the left panel was collapsed.

Settings live inside the AI Prompt rather than a separate tab. Its composer
keeps the Session model switch inside the input box at the bottom-right:
provider/model and, when declared, reasoning-effort selects backed by the Host
model directory, so the choice matches the Host composer and persists in
Session history. The gear next to them opens the AI Prompt's model-only
**Settings** view: the Session selector, then the Host provider directory with
inline API-key cards for active/configured providers, a **Show all** toggle for
the full directory, and **Add** for a custom OpenAI- or Anthropic-compatible
provider (route, base URL, model ids, key). Keys go to the Host credential store
and profiles to the Host settings document; nothing navigates to a host settings
page. The workbench never leaves the embedded AI Studio: session switching and
history use the **Sessions** tab, model and provider setup stay in the AI Prompt,
and every editor panel remains mounted. Scheduled tasks, plugins, skills and
connectors are intentionally not surfaced from Studio yet, because their native
managers live on the host shell; exposing them needs Studio-native views rather
than a navigation jump. The Settings view works at every Studio width.

The studio is a plugin-owned fixed overlay inside the preview component, not a
new Host layout mode: it only re-lays out the same mounted iframe, so the scene,
camera, playback position, overrides and unsaved Code draft survive. It is not
built from any reference clone's source or assets; only generic DCC arrangement
ideas were considered during design. The workspace's surfaces, colour system, typography,
icon set and AI workflow are this project's own, so the page does not read as a
reskin. The host's docked columns and
conversation stay mounted underneath, so the host needs no core
refactor for this workspace. Desktop Studio has no exit gesture: it is the
default surface, and `Esc` only closes the innermost layer or menu. A page
load always starts with Studio open, even if an older `open` preference is
still in `three-workbench:prefs`; the host header's **3D** control reopens the
preview column if the host hides it. The narrow-screen overlay keeps its own
close button, since that overlay already owns the viewport and keeps the
compact chrome.

A load is branded before the client bundle can run. The Host plugin contributes
`webserver/index-inject` rows that set the **Three Studio** title, replace the
kernel boot page's wordmark, hint and favicon, and paint a full-viewport cover
with the prism mark and cobalt spinner. The cover is body markup, so it exists
on the first frame even on a warm reload where the plugin graph finishes before
paint and the kernel boot page is already gone. It is removed only after the
Studio overlay mounts, with an eight-second bound and a loader-failure escape;
below 776px it is hidden so the narrow host surface still appears normally.

The chrome follows the host's colour scheme. Colours are CSS variables on the
preview root and a `MutationObserver` watches `body[data-ds-dark-theme]`, so
switching the host between light and dark repaints Studio immediately
without a reload. Light mode uses a deeper cobalt (`#2450d8`) for readable
contrast on white; the AI panel, header, rail, side panels, dock/console,
viewport HUD and code pane all share the same tokens.

### Studio AI panel

The AI prompt is the first rail item and the default left tab on a fresh
layout. Layouts saved before the current Studio layout version are migrated
once: a legacy `tab: 'scene'` becomes `'ai'`, then the user's later tab choice
is kept.

The AI tab is wired straight to the host session binding — the same
`SessionSnapshot`, event window, pending submissions and verbs
(`beginSubmission`/`prompt`/`cancel`/`loadOlder`) the host conversation uses.
No third-party chat UI is embedded. The transcript is folded locally from `user/message`,
`assistant/message`, `assistant/attempt`, `assistant/live-chunk`, `tool/call`
and `tool/result` events, so streamed text, tool activity and `three_scene`
revisions appear as they happen; Stop maps to the binding's `cancel()`.

When **Scene context** is on (the default), each send prepends a compact
`<three-workbench-context>` block with the current revision, object/material/
asset counts, selected object transforms, manual tweaks, parameters, assets,
camera and timeline state. The block is stripped from the visible transcript so
only the user's words are shown. The toggle persists with the rest of the
studio layout in `three-workbench:studio-layout`.

**New task** in the prompt footer uses the Host Session Controller and Workspace
navigation: it creates a Session in the origin Session's Workspace and opens it.
A draft becomes the first message, keeping the active Intent directive but
omitting the current scene context, because the new Session has its own scene
record. With an empty prompt the new Session simply opens for typing. If
creation or delivery fails, the Studio prompt is kept and the failure is shown
under the input.

### AI-native workflow

The AI is not a chat box bolted onto an editor. It works through four
surfaces that share the scene's revision number:

**Modes.** The compose bar selects **Ask**, **Edit**, **Review** or **Direct**.
Ask explains and proposes without touching the scene; Edit starts the agent's
normal proposal-first flow; Review is aimed at the current selection,
composition and review pins; Direct explicitly lets the agent call
`three_scene` and apply changes without waiting for proposal approval. Each
mode prepends a one-line directive to the prompt so the model's intent matches
the button the user pressed. Modes are prompt-level guidance, not a tool
gate: sandboxing, revision auditing and override limits apply in every mode.

**Context Shelf.** Chips above the compose bar choose what accompanies a
message: scene, selection, camera, timeline, assets, parameters, shots, review
pins, measurements, the Insert Shelf library (built-in shapes and saved
recipes), object links and the active case brief. All are on by default;
turning one off removes it from the `<three-workbench-context>` block. The
selection follows the Outliner and the viewport, so "this" in a prompt has a
concrete referent.

**Proposals.** The host registers a second tool, `workbench_proposal`. The
agent calls it to return structured data (`kind`: shots, pins, measure, explode,
view, geometry, insert, recipe, link, scene) with a rationale and the
`baseRevision` it reasoned from. A proposal is inert until the card is applied: **Preview** shows the
camera/explode effect on the stage, **Apply** writes the editor state, **Ask**
sends a follow-up, **Reject** discards it. If the scene head has moved since
`baseRevision`, the card is marked stale and cannot be applied blindly; the user
can ask the agent to rebase. Applying or rejecting a proposal appends an entry
to the decision log. Proposal cards are data, not permission: they cannot run
code or bypass the sandbox.

**Editor-side AI surfaces.** The dock carries **Shots** (named camera frames
with live capture thumbnails and timeline-aligned playback), **Review** (pins
anchored to a scene UID, with severity and resolve state), **Measure** (point-to-
point distance with labels), **Geometry** (the manual-primitive lens: creates
and edits box/sphere/cylinder/cone/torus/plane parameters without a revision,
an explode-view slider, and a glTF/GLB import entry point) and **Log** (the
per-session decision trail). Each surface can hand its state back to the AI
through the Context Shelf or a pre-filled ask prompt. The AI tab also shows up
to two context-driven suggestions (for example shot list, procedural material,
live parameters, reusable recipe, animation, review fixes and performance),
chosen from the live scene, selection, tracks, assets and review state. Using or
dismissing a card hides it for the session and brings the next one forward;
**Shuffle** cycles the remaining pool. A suggestion only pre-fills the composer;
nothing is sent until the user presses Send.

**Insert Shelf, object links and labels.** The Create rail opens an Insert
Shelf with the six manual primitives and saved recipes. A click inserts at the
view center; dragging a row onto the stage asks the runtime for the ground
point under the pointer. Parts are validated, capped at 32, and committed as
one atomic manual batch; recipes come from `recipe` proposals and are inert
assembly data, never executable components. An object can be linked to another
through the Links dock (relation, flow or dependency); links are editor-only
metadata, and a `link` proposal previews its endpoints before the user applies
it. Review pins can also be `label` pins, which name or describe an object
rather than flag a defect. Both appear in the AI Context Shelf.

**Selection action strip and plan view.** A single selected object gets a
stage strip with Explain, Improve, Variants, Annotate, Measure and Link. Every
action only prefills the AI draft (Annotate opens Review with a draft); nothing
is sent automatically, and Dismiss hides the strip for that object. The stage
bar's plan toggle switches to a mirrored orthographic camera: orbit rotation
and the gizmo are disabled, while the script's perspective camera remains the
source of truth for shots, captures, recordings and exports. Reloading the
runtime restores plan view without snapping the user's camera back to a preset.

**Case library.** The Cases rail is a library of original, multi-stage
production briefs for AI-native model and animation work. Twelve curated cases
cover model, animation, camera, look development and review; each case has
three ordered stages, per-stage Intent modes and acceptance checks. Starting a
stage selects its mode, records the case as per-session editor metadata,
enables the `case` Context Shelf ref and prefills a structured brief — it
never sends a prompt or writes the scene. The active case stays pinned in the
AI panel and its brief and acceptance checks accompany later messages through
the context block. A draft can be saved as a custom case; custom cases are
prompt text only (capped, normalized, never executed) and can be started or
deleted from the same panel. The curated briefs are written for this
workbench; no external case gallery code, assets or URLs are bundled or run.

Shots, pins, measures, decisions, links, recipes, custom cases, the active case
and the context refs live in `three-workbench:studio-meta:<sessionId>` per
Session. They are editor-only metadata: they never enter the scene code,
`INITIAL_EDITOR_STATE`, exports or share documents, and another Session cannot
read them. The Geometry tab's import button opens the same Assets picker, which
accepts raster textures and HDR environments as before; **mesh import is
glTF/GLB only**, because the runtime ships no OBJ/STL/PLY loaders, so those
formats are not offered.

### Studio resize, viewport and shortcuts

Both side panels and the console dock can be resized by dragging their seams.
Widths are clamped to left 208–460px, right 240–460px and console 140–420px.
Double-clicking a seam resets only that pane (left 288, right 312, console 220);
arrow keys nudge it by 8px (Shift: 32px). The current widths, active left tab
and bottom dock tab persist in the separate `three-workbench:studio-layout`
localStorage key, so the Host preference schema in `three-workbench:prefs` is
untouched. A resize uses a temporary transparent pointer shield so dragging
across the sandboxed frame cannot lose the gesture.

The viewport's top-left cluster controls the editor camera and diagnostic
display without writing scene overrides or history:

| Control | Behaviour |
| --- | --- |
| View selector | Perspective, front, back, left, right, top, bottom; presets frame the whole helper-excluding scene |
| Rendered / Wireframe / Normals | Scene-level `overrideMaterial`; authored materials are never mutated and return on **Rendered** |
| Grid button | Adds `GridHelper` + `AxesHelper` marked `wbHelper`, excluded from the Outliner, picking, statistics, framing, captures and all exports |

Refreshing the preview re-sends the current shading and grid state, but never
forces the camera back to a preset. The Outliner supports right-click for
**Focus**, **Duplicate**, **Hide/Show**, **Delete** and (in Studio) **Ask AI**;
Ask AI only pre-fills the AI tab and focuses its textarea — it never sends.
Locked objects disable the destructive entries, and Escape closes the menu
before it closes anything behind it.

Global shortcuts work with focus either in the page or inside the sandboxed
canvas. Editable fields opt out.

| Keys | Action |
| --- | --- |
| `Alt+1` / `Alt+2` / `Alt+3` | Rendered / wireframe / normals |
| `Alt+J` / `Alt+K` / `Alt+H` | Front↔back / right↔left / top↔bottom |
| `Alt+G` | Restore the script camera |
| `W` / `E` / `R` / `Q` | Move / rotate / scale / gizmo off |
| `F` | Focus the selected object |
| `Space` | Play or pause |
| `K` | Keyframe the current pose |
| `Delete` | Delete selected keys (sheet focus) or objects |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Y` | Undo / redo |
| `Ctrl/Cmd+K` | Command palette |
| `?` | Shortcut help overlay |
| `Esc` | Close the innermost layer or menu |

The command palette mirrors these entries, including the six view presets,
shading modes, grid toggle and a full Studio layout reset.

The reference editors were consulted only at the level of feature behaviour.
Their licences include additional restrictions in at least one case
(commercial use requires authorization; competing business use is prohibited).
No source, assets, icons, templates or copy are included, and the UI, colour
system and AI workflow are independently designed. A reproducible static
provenance audit was performed against the local reference checkouts; it is an
internal engineering record and is not part of this repository.

## Narrow screens and touch

Below 776px of viewport width the open preview becomes a full-viewport overlay
instead of closing the preview track and squeezing the conversation past its
400px floor. The **3D** header button opens it; Escape closes it (Back also
closes it while the History marker is active), and focus is trapped while it is
open. The overlay pushes one same-document History marker, not a URL change or
router route; the marker carries no scene, token or Session data.

The 776–1023px band is not a separate tablet layout: a docked track stays
docked, and when the Host reports no dock width (`width === 0`) or cannot show a
dock (`canShow === false`) the overlay entry is used. There is no
tablet-specific feature set.

Touch editing is implemented in the preview: one finger orbits, two fingers
pinch and rotate, long-press toggles selection when the editor is in select mode,
and gizmo handles are enlarged for touch. A second finger during a gizmo drag is
ignored; a cancelled drag emits one cancelled commit and writes no undo entry.

## Editor (fine-tune without re-prompting)

The **☰** toggle opens an editor dock over the preview:

- **Scene** — a searchable flat outliner (meshes, lights, points, groups) with
  type dots, visibility toggles, lock toggles and a blue dot on objects you have
  tweaked. Click a row to select it, Ctrl/Cmd-click to add or remove one object,
  and Shift-click to select a range over the visible outliner order. Outliner and
  viewport share the same UID set and primary selection; every selected object
  gets a pooled box helper. Esc clears the whole selection. The **Add object**
  picker and **+ Add** button create any of the six primitives; the search
  matches the display alias as well as the script name and type. Each row also
  has **duplicate** (⧉) and **delete** (✕) buttons; double-click a row label to
  rename it inline (Enter/blur commits, Esc cancels). Rename and delete are
  disabled for locked rows, while duplicate stays enabled because it only reads
  the source (the clone is unlocked).
- **Inspector** — transform (position / rotation° / scale), visibility, material
  (color, emissive, emissive intensity, roughness, metalness, opacity,
  transparent, alpha test, side, flat shading, wireframe; shared materials show
  "shared ×N" and are cloned on first edit), light (intensity, color), and a
  camera section when nothing is selected (position, target, and FOV clamped to
  10–120; the script's base values are shown beneath the fields, and **Use
  current view** keeps the FOV override). Color pickers apply live and commit
  on the picker's native change, with blur as the fallback; one gesture writes
  the v2 record once, and material changes add exactly one history entry. A
  renderer preview is live-only, so React can restore the controlled display to
  the previous color before that native change: the gesture commits the value
  last read during the input phase, not that restored display value. When a
  Texture background is effective, the picker shows a fallback color; picking
  that exact fallback still commits a color background override. Every
  overridden property — including
  camera position, target and FOV — has a reset glyph that restores the script's
  value for that property only, and the pre-edit base value is shown beneath
  the field (or beside the material/light heading) so you can compare it with
  the current value. Selecting several objects shows an "N selected" summary
  with batch show/hide and reset actions instead of per-property fields. Locked
  objects are read-only until unlocked in the outliner.
- **Renderer** — a Render section below Camera is always visible, with or
  without a selection. It exposes tone mapping (the vendored three.js allowlist
  minus `CustomToneMapping`), exposure (0–10), shadows, background color and
  fog (color, near, far; fog on/off). Values are based on the post-script
  reference, each channel has its own reset glyph, and changes apply live to the
  preview. Renderer changes are settings-like: live edits only update the
  iframe, the gesture's commit writes the v2 record once (color pickers commit
  on the native change, with blur as fallback), and there is no undo/redo entry
  (unlike material changes). Persisted renderer overrides replay after reload
  and after a scene revision. Renderer overrides are applied after script and
  parameter output and before per-object overrides; the camera override is
  applied last. Camera and renderer are independent channels, so this order is
  only the application sequence, not a dependency between them. The post-script
  values remain the reset base: a script-set texture background is labeled
  Texture and restored by reset, and a script-set `FogExp2` is shown by type
  with the default near/far fields; because editor fog overrides are linear Fog,
  the first fog edit (including a color pick) switches to linear Fog using the
  shown near/far values. `onFrame` runs before the final pin pass, so a pinned
  renderer channel (including fog values mutated in place) cannot be defeated
  by the animation callback.
- **Lock** — the outliner lock toggle stores `objects[uid].locked` as v2
  metadata, preserving the object's overrides. Lock state survives reloads but
  is not an override-history entry. Locked objects can still be selected and
  viewed, but viewport picking, the transform gizmo, Inspector editing and batch
  visibility/reset skip them; exports and script animation are unaffected.
  Undo/redo preflights every target before writing: if any target is locked or
  no longer in the scene, the whole entry is rejected with a notice, the scene
  and history cursor stay unchanged, and unlocking a target makes the pending
  entry available again. Persisted overrides still replay after reload even
  while the object is locked. Lock also blocks delete, restore and rename, and
  it closes over the subtree: deleting a target with any locked descendant is
  refused (and a locked descendant re-locked after the fact blocks the redo).
- **Manual objects** — **Add object** creates a Box, Sphere, Plane, Cylinder,
  Cone or Torus (also available from the command palette, in Chinese or
  English). Each object has a deterministic default transform and
  `MeshStandardMaterial`, a parent-page-generated `m:<uuid>` UID and an
  `origin: "manual"` manifest stored in the same per-session v2 `objects` map.
  The definition is written once before the runtime creates the mesh, never
  replaced by a script `s:` UID, and rebuilt from the stored shape parameters/
  transform/material on reload and on every revision (manual objects first,
  then overrides). Creating selects the new object and is one undo entry;
  undo removes its definition, runtime mesh and selection, and redo recreates
  the same UID and manifest. Manual objects use the normal Outliner, pick,
  multi-select, gizmo, Inspector, stats, lock and export paths. A session is
  capped at 500 manual objects; invalid definitions and create failures are
  reported and rolled back. `Reset all overrides` keeps manual objects and
  their lock state while clearing their overrides.
- **Delete / restore** — deleting a **script** object writes `objects[uid].deleted:
  true` (metadata, not a name/type change); the runtime detaches and stashes the
  live instance so the script keeps mutating it, and it is re-inserted at the
  same parent/index on undo. Geometry and materials are never disposed for
  script objects. Deleting a **manual** object removes its manifest entry, but
  the full manifest (shape/clone, overrides, lock, alias, parent) travels in
  one history entry, so undo recreates the same `m:` UID and its overrides.
  Deleting a manual parent cascades to its manual descendants leaf-first in the
  same entry. One gesture (including a mixed script+manual selection) is one
  history entry and one v2 write; locked members are skipped and reported, and
  an all-locked selection is a no-op. There is no separate deleted-object list:
  restore is Undo, and undo history is revision-scoped (a reload/new revision
  keeps the deletion but clears the redo path).
- **Rename** — a display alias keyed by UID. It never writes `object.name` or
  the script source and never changes the UID; an empty alias clears it and the
  UI falls back to the script name/type (or the manual shape/UID label). One
  alias commit is one undo entry. `Reset all overrides` keeps aliases and
  deleted tombstones while clearing only property overrides, the camera override
  and the renderer override.
- **Duplicate** — clones the primary selected object into a new `m:` clone
  manifest (`kind:"clone"`, `sourceUid`, `sourceType`, the source's current
  local transform, alias and a deep copy of its override fragment). The runtime
  clones the geometry and every material slot independently (textures shared by
  reference); the clone is a stable, independently editable `m:` object and is
  selected after creation. Duplicate is primary-only when several objects are
  selected (the action title says so). v1 supports plain `Mesh` sources whose
  materials are all non-Shader: `SkinnedMesh`, `InstancedMesh`, `Group`,
  lights, Points/Line and any `ShaderMaterial` are refused with a translated
  notice and no write. Clones are derived from their source, so a clone whose
  source disappears is reported (`clone-source-missing`/`clone-cycle`) and
  skipped on the next rebuild rather than silently attached to the scene root.
  Cloning a locked source is allowed (the clone is unlocked).
- **Reparent / hierarchy** — drag an unlocked Outliner row onto another row to
  make it a child, or onto the **Scene root** drop zone (shown during a drag) to
  unparent; the palette **Move to Scene** is the keyboard path. World transform
  is preserved by default (`keepWorld:true`, using `Object3D.attach`); a
  non-uniform-scale or rotated parent can drop shear, so a one-time warning is
  shown for that case. One drop is one undo entry that restores the exact
  parent, unrounded local transform and transform-pin fragment. Dragging a
  multi-selection moves only the primary object. Script entries store
  `parent:{to,keepWorld}` (distinct from the identity anchor `parentUid`);
  manual entries update their construction `parent`/`parentKeepWorld` and their
  authoritative `transform`. Reparent survives reload and new revisions, and
  `Reset all overrides` keeps it. Self/descendant cycles, deleted/missing
  targets and locked sources/targets/subtrees are rejected atomically with no
  store or history write. A manual parent whose live subtree contains script
  children refuses deletion (`has-script-children`); move those children first.
- **Manual overrides** are keyed by a stable object UID, not by a display
  name or ordinal path. Give an object its identity with
  `wb.id(object, 'hero')` (or `object.userData.wbId = 'hero'`); the ID must be
  unique within the scene. Resolution tries the script-assigned ID first, then
  a unique named path plus type, then a unique bound parent UID plus ordinal
  path plus type. Legacy v1 path keys are migrated only when exactly one live
  object matches the old anchor; duplicates and missing matches stay unbound
  instead of being guessed. Overrides are applied after the scene script on
  every load, so they survive revisions while the object still resolves.
  Unmatched overrides show a banner; **Reset this** restores one object,
  **⨯** clears everything.
- **Undo / redo** (↶ ↷) cover manual edits; a batch visibility/reset action is
  one history entry, so one undo restores every target. Agent revisions stay on
  the filmstrip. History resets when the revision changes.
- **Send tweaks** (↗) turns the current overrides into a prompt so the agent can
  bake them into the next script. Manual objects are skipped because they have
  no script anchor, and the skip count is disclosed rather than sending a UID
  the agent cannot resolve.
- **Timeline** — play/pause, scrub, frame stepping (**◀|** / **|▶** with an
  FPS field, 1–120; stepping pauses playback and clamps at 0/duration), speed
  (presets 0.25×/0.5×/1×/2×; the runtime accepts 0.1–4×), loop and duration.
  The frame-step FPS survives reloads. Scrubbing
  sets the clock; scenes that accumulate state (`x += delta`, `Math.random`)
  may not rewind exactly.
- Exports embed the v2 editor state (UID registry including manual definitions
  and lock metadata, overrides, renderer settings, camera, duration, keyframe
  tracks and parameter values) in the standalone HTML and project ZIP. The
  exported runtime rebuilds manual meshes after UID resolution and before
  `applyEditorState` overrides, so it does not depend on the parent workbench
  tree. PNG, WebM, glTF (static and animated), STL and OBJ force the
  authoritative pin+track pose at the playhead, so they include manual objects,
  tweaks, parameter output and locked objects automatically; glTF carries
  materials but not renderer settings.

### Keyframes and dope sheet

Open the editor and press **K** (or the key button in the dope sheet) to key the
selected objects at the current frame-snapped time. The first gesture on an
object creates `position`, `rotation` (stored as an xyzw quaternion) and `scale`
tracks; later gestures key every enabled path the object already owns. Keying
uses exact values queried from the runtime, not a stale Inspector display.
**Auto-key is off by default**: editing an unkeyed channel still writes a static
override, while editing a channel that already has a track always upserts a key
even with auto-key off. Auto-key on additionally keys changed candidate
channels.

The dope sheet sits below the transport and header, full width above notices,
the filmstrip and the preview, with no page horizontal overflow. It shows one
row per object/path with key diamonds and a shared ruler/playhead. Click,
Ctrl/Shift multi-select or marquee
to select keys; drag them to retime (snapped to one frame, extending the
duration when a key passes its end); press **Delete** to remove a selection or
**Esc** to clear it. Right-click a key to choose **linear**, **easeIn**,
**easeOut**, **easeInOut** or **step**; step-only paths such as visibility and
textures always hold the outgoing key. The sheet can mute, delete, add a track
from the exact runtime value at the playhead, or clear all animation
session-wide with the two-click **Clear animation** button. It is 96 px tall in
the narrow layout and 140 px when the workbench column is wide; **Fit** restores
zoom 1. All controls and aria labels are zh/en, and the sheet is parent DOM, so
it can never appear in a capture or export.

Runtime precedence each frame is script `onFrame` → static pins → tracks →
transient key preview → deletion guard → controls → render. A keyed path owns
only that path: other script/pin motion continues, the stored static override
remains visible as "shadowed static override", and muting the track releases the
path back to the pin. Tracks evaluate on every frame, including while paused,
compare before writing values, and never send a track message per frame. The
timeline clock stays authoritative: loop wraps before evaluation, keys beyond a
shortened duration remain visible but dimmed, and evaluation clamps at the
first/last key.

Every gesture is atomic: one v2 record write, one `tracks replace-all` runtime
message and one `kind:'keys'` history entry. Locked, stale, over-limit, busy or
revision-mismatched edits fail closed with no partial store, runtime or history
change. Inspector drags render through a transient `key-preview` that is never
persisted or exported; the commit uses the exact values from the runtime query
for untouched axes, and rotation is displayed in Euler while stored as a
quaternion. Key times are snapped to six decimals at the frame-step FPS and
duplicate times keep the last key; values clamp to channel ranges. The parent
and sandboxed runtime share the same pure model: the runtime validates a
replace-all message atomically before touching the scene, while record
normalization quarantines bad members and reports them. An unknown `tracks.v`
fails closed, and the caps are 200 tracks, 1,000 keys per track and 10,000 keys
per session. Tracks live in the same
`three-workbench:editor:v2:<session>` record as
`{v:1,items:[{uid,path,enabled,keys:[{t,v,e}]}]}` and survive revisions,
reloads, standalone HTML and ZIP exports.

### User parameters (`wb.expose`)

The third editor tab, **Parameters**, is driven by the script. A script may call
`wb.expose(schema, apply)` once; the first valid declaration wins and a later
call is ignored and reported. `apply` receives a fresh frozen object containing
every declared key. It runs once after the script body — before UID resolution
and override replay, so objects it creates join the normal UID registry — and
again after every accepted panel change. `apply` must be idempotent: create only
objects it owns and do not assume the runtime cleans up removed nodes.

```js
const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 2),
  new THREE.MeshStandardMaterial())
scene.add(orb)

wb.expose({
  speed:  { type: 'number', label: { zh: '速度', en: 'Speed' },
            default: 1.2, min: 0, max: 5, step: 0.1 },
  tint:   { type: 'color', label: 'Tint', default: '#8ab4ff' },
  glow:   { type: 'boolean', label: 'Glow', default: true },
  motion: { type: 'select', label: 'Motion', default: 'orbit',
            options: [{ value: 'orbit', label: { zh: '环绕', en: 'Orbit' } },
                      { value: 'bob', label: 'Bob' }] },
  title:  { type: 'text', label: 'Title', default: 'WB', maxLength: 40 },
}, values => {
  orb.material.color.set(values.tint)
  orb.material.emissiveIntensity = values.speed
  orb.visible = values.glow
  orb.name = values.title
})
```

- **Controls** — number shows a range slider plus readout when both `min` and
  `max` exist (otherwise a number input); color shows a picker plus a hex
  readout; boolean, select and text use their native controls, with a character
  counter on text. Invalid saved values and dormant keys are called out, rows
  show a modified dot, and a per-row reset restores one default.
- **Limits** — 1–50 parameters. Keys match `[A-Za-z][A-Za-z0-9_]{0,63}` and
  cannot be `__proto__`, `constructor` or `prototype`. Labels are strings or
  `{zh,en}`, trimmed to 80 characters and fall back to the key. Number defaults
  must be finite; `min <= max`; `step > 0`; values clamp and snap. Colors are
  exactly `#rrggbb` (stored lowercase). Selects have 1–100 unique string options
  of at most 128 characters; a missing default falls back to the first option.
  Text defaults are strings; `maxLength` is 1–1024 (default 256).
- **Invalid schema** — validation is all-or-nothing: the callback is never
  called, the rest of the script keeps running, and the panel shows the issues
  with no controls. A throwing initial callback shows an apply-error banner
  while retaining the previous effective values; a throwing live callback
  reverts the draft, writes nothing and keeps the last good values.
- **Persistence** — accepted values are stored under `params:{v:1,values:…}` in
  the existing per-session v2 editor record; the schema is never stored.
  Reloads and revisions migrate by key. Same-type values carry over; numbers
  outside a new range or step clamp/snap for the session while the raw value is
  retained; a changed type, removed option or over-long text uses the default,
  keeps the raw value and reports the mismatch. Undeclared keys stay dormant —
  hidden, counted, cleared by reset-all, and revived if the key returns. Missing
  or corrupt `params` data is normalized with the rest of the record.
- **Reset** — **Reset all tweaks** clears object overrides, the camera override
  and the renderer override while keeping parameters (scene input), manual
  objects and their lock metadata. A per-channel renderer reset restores that
  post-script reference exactly and, like every renderer change, is not an undo
  entry. The Parameters header has its own two-click **Reset all
  parameters**; both it and the per-row reset send a `reset` and apply defaults.
  Parameter edits are not undo entries in v1.
- **Exports** — standalone HTML and project ZIP embed the current values in
  `INITIAL_EDITOR_STATE` and apply them during load; PNG/WebM/GLB/STL/OBJ inherit
  the live scene and never re-run `apply`. Standalone exports have no parameter
  UI; they open with the baked values.
- **Security** — schema and values are data, never code. Labels, option labels
  and text are rendered as React text nodes (never `innerHTML`) and embedded
  through the escaped state serializer, so markup stays literal; the parent
  re-validates every runtime message. The preview sandbox is unchanged.
- **No declaration** — the tab shows a `wb.expose` hint. During structural
  work the panel is disabled, and historical revisions are read-only; a pending
  final parameter commit disables only the parameter controls (live drags do
  not).

### Direct manipulation

A small toolbar sits over the viewport while the editor is open:

- **Select (Q) / Move (W) / Rotate (E) / Scale (R)** attach a transform gizmo
  when exactly one unlocked object is selected; the **W/L** toolbar button (not
  a keyboard shortcut) switches world ↔ local space, and **Snap** locks
  translation to 0.25, rotation to 15° and scale to 0.1. Locked objects are
  never picked or dragged.
- Dragging pauses the timeline for the gesture and resumes it on release; one
  drag is exactly one undo entry. Only the channels you actually changed are
  pinned as overrides, so moving an object does not freeze its script-driven
  rotation or scale. A click that does not move the gizmo adds no history.
- Click a mesh in the viewport to select it; click empty space or press **Esc**
  to deselect. **Double-click** an object or press **F** to frame it using its
  geometry bounds (rotation does not inflate the framing distance).

Shortcuts work with focus either in the page or inside the preview, whether the
editor dock is open or closed, except while typing in an editable field:

| Keys | Action |
|---|---|
| `W` `E` `R` `Q` | move / rotate / scale / select tool |
| `F` | frame the selection (the whole scene when nothing is selected) |
| `Space` | play / pause |
| `Esc` | close a menu, leave pick mode, or deselect |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` or `Ctrl+Y` | undo / redo manual edits |
| `Ctrl/Cmd+K` | command palette |

The command palette (also in **⋯ → Command palette**) searches every action:
tools and focus, playback and frame stepping, undo/redo, resets, snapshots,
recording, exports, templates and layout. Type to filter, `↑`/`↓` to choose, `Enter` to run.

## Assets (textures, models, HDR environments)

The editor's fourth tab order is **Scene / Inspector / Assets / Parameters**.
**Assets** uploads PNG, JPEG, WebP, GLB, GLTF and Radiance HDR files from the
browser. Files are untrusted data: the extension allowlist and byte sniffing
must both agree, so SVG, HTML, JavaScript and unknown formats are rejected even
when the bytes mimic an image. GLTF is accepted only when every buffer and
image is an embedded `data:` URI; external URLs and Draco/meshopt/KTX2
extensions are rejected because the vendored loaders have no decoders. Names
are decoded once, trimmed, NFC-normalized, unique case-insensitively per
Session and limited to 128 code points; they are always rendered as text, never
markup or paths.

Per-file limits are 8 MiB for PNG/JPEG/WebP and GLTF, 32 MiB for GLB and 16 MiB
for HDR. A Session holds at most 24 assets / 48 MiB; global limits are 128
assets / 256 MiB; uploads are rate-limited to 10/min per Session (3 concurrent)
and 60/min globally. Uploads show progress, can be cancelled, abort on a
Session switch, and never commit partial bytes; duplicate names, oversize
files, quotas and loader failures produce localized per-row errors without
stopping the scene. **Delete** needs a second click to confirm, and assets are
read-only while viewing a historical revision.

Assets are persisted per Session in the Host data directory on Linux:
restarting the Host retains them, and clearing the Scene Session or evicting it
by the 16-session product limit deletes them. On other platforms the Host
reports `disk-unsupported` and assets are memory-only. Bytes are never written
to localStorage, scene code, or v2 overrides; exports are snapshots. The list and delete routes require the Session header; content URLs use
an unguessable 22-character capability ID and never contain a Session ID or the
dev token. A deleted or unknown ID returns 404, including cross-Session probes.

### Script access

The runtime exposes a name-only API before the script runs; there is no URL
setter or arbitrary-URL option:

```js
assets.url(name)                      // string | null
assets.texture(name, options?)        // THREE.Texture | null (image)
assets.model(name, onLoad?, onError?) // THREE.Group | null (holder.ready)
assets.hdri(name, onLoad?, onError?)  // THREE.Texture | null (HDR)
```

`assets.texture` defaults to `SRGBColorSpace` and accepts
`{srgb, wrap, repeat}`; the model and HDR helpers import their vendored loaders
lazily. All handles return immediately because scene scripts are synchronous: a
missing name returns `null`, as does a wrong-kind asset requested through a
typed helper, while a model gets an empty `THREE.Group` whose `ready` promise
settles later. Add that holder to your scene yourself; the loaded glTF scene is
attached under it. Asynchronous completion refreshes the editor tree. A failed
load posts a non-fatal `asset-error` and keeps the placeholder texture (or the
empty holder), so the scene keeps rendering; a late result is discarded if the
asset was deleted or the manifest changed.

### Textures and environment

The Inspector exposes seven texture rows per material (`map`, `normalMap`,
`roughnessMap`, `metalnessMap`, `emissiveMap`, `alphaMap`, `aoMap`), each with
Script value / None / image asset choices, a preview and a reset glyph. `map`
and `emissiveMap` use sRGB; the other slots use linear data. Editing a shared
material clones it first (copy-on-write), an asset texture replaces the slot
only after it loads, and a reset restores the script-owned texture without
disposing it. Failed loads keep the previous texture and mark the row.

With no object selected, the Inspector has an **Environment** row: Script
value, None, or an HDR asset. HDR rows in **Assets** also offer **Use as
environment**. The HDR is loaded once and refcounted, mapped as an
equirectangular environment and set only on `scene.environment`; the camera and
P1-8 `scene.background` stay untouched. Resetting restores the script
environment and never disposes it. All asset loads must be idle before a
snapshot or recording capture; a load that exceeds the 5 s budget aborts the
capture with a localized notice rather than producing a partial frame.

## Local code (Code tab)

Switch to **Code** to edit the running scene's JavaScript in a plain monospace
textarea. Edits are local drafts: Apply (or Ctrl/Cmd+Enter) stores the draft in
this browser and rebuilds the preview; it never writes a Host revision, sends
code to the agent, or changes the scene record. The bar says "Local changes —
not written to Host" and shows whether the preview is running the agent code
or the local draft. Unsaved edits are outlined and can be discarded. **Revert
to agent code** returns to the agent code but keeps the draft for re-apply;
**Restore agent version** deletes the draft and reactivates agent code. Copy
copies the textarea text while in Code mode, otherwise the code the preview is
actually running.

Drafts are stored per Session and revision under
`three-workbench:code:v1:<encoded-session>:<revision>` as
`{v:1,text,updatedAt}`. Reads validate the version and field types; corrupt
entries are ignored and reported, never applied. Apply enforces the 512 KiB
UTF-8 limit with a translated notice and never truncates. The applied flag is
in-memory only, so a reload lists stored drafts as inactive and starts on the
agent code. Historical revisions are read-only. If the Host publishes a newer
revision while a draft exists for the old one, the preview uses the new agent
code and a banner names both revisions; **Apply draft to this revision** moves
the draft onto the current revision, while **Discard draft** deletes it. No
stale draft is applied or deleted automatically.

Apply rebuilds the sandboxed document with the authoritative v2 editor state:
overrides, camera, manual objects, hierarchy and pins remain, and the UID
registry is unchanged. UID resolution runs against the new code, so objects
whose identity disappears become unresolved exactly as on a revision reload.
Syntax and top-level errors use the normal runtime error box and parent error
bar/**Fix with AI** stack. A failed draft stays stored and retryable: **Revert
to agent code** deactivates it but keeps it for re-apply, while **Restore agent
version** deletes it. Standalone HTML and project ZIP exports embed the active
draft (otherwise the agent code); PNG/WebM/GLB/STL/OBJ capture the live frame
and inherit it automatically.

## Scene console

The **>_** toggle in the preview header opens a bottom console drawer (at most
30% of the preview height) with an unread badge. The sandboxed runtime wraps
`console.log/info/warn/error/debug`, serializes arguments safely (Error stacks,
circular values, named functions/undefined/symbols, 2,000-character strings,
at most five arguments), and batches at most 20 entries or every 200 ms. The
parent keeps the newest 200 entries, reports how many older entries were
dropped, and clears the buffer when the preview document changes. Filters are
All/Log/Info/Warn/Error; Debug entries appear under All but have no separate
filter. Clear empties the buffer, and the drawer auto-scrolls only when it is
already at the bottom. When closed, it is not mounted and does not intercept
pointer events.

`console.error` is an ordinary log level; thrown errors and unhandled
rejections still use the error box and parent error bar. Console output is
ephemeral: it is not stored in v2, sent to the agent, or included in any
export or capture.

## Export formats

| Format | Contents | Notes |
|---|---|---|
| PNG snapshot | current frame | 1x device pixel ratio; camera as you left it |
| WebM / MP4 | 5 s real-time recording | extension follows `MediaRecorder`'s MIME; needs a secure context (localhost/HTTPS) for MP4 |
| MP4 (deterministic) | fixed frame grid, 960×540 | WebCodecs H.264, else VP9-in-MP4, else realtime WebM fallback; see below |
| GIF (deterministic) | same fixed frame grid | local 256-colour palettes; capped at 600 frames; timing is quantized |
| glTF `.glb` | current frame, PBR materials | **static** (default): pins and tracks are forced to the playhead immediately before parse; procedural `onFrame` animation is not included; renderer settings (tone mapping, exposure, shadows, background, fog) are scene/format state and are not written to the file |
| glTF `.glb` (animated) | one clip from live, enabled TRS tracks | fixed FPS; only `position`, `rotation` and `scale`; visibility/material/light/texture/environment/particles/shaders and script motion is excluded, and visibility is never replaced by scale 0; temporary unique names; a 7200-frame cap is refused with no download |
| STL | current frame, geometry only | binary; for 3D printing |
| OBJ | current frame, geometry only | no MTL/materials |
| Project ZIP | `index.html` + local `runtime/` + `assets/` + README | offline; serve it (ES modules do not load from `file://`); includes the five vendored loaders and the MIT license |
| Standalone HTML | same scene, three.js from jsDelivr (0.186.1) | one file; assets are embedded as base64 data URIs; needs network |

Both project exports include **all** Session assets, not only those referenced
by the current v2 state, so a script may call `assets.*` for any uploaded name.
Standalone HTML is capped at 16 MiB of decoded asset bytes (24 MiB encoded);
project ZIP is capped at 64 MiB of raw asset bytes and 128 MiB total. An export
that would exceed a cap, or that references a deleted/missing asset, is
refused with a localized notice and produces no partial download. Standalone
imports resolve through a pinned CDN import map; the ZIP rewrites them to local
`runtime/` paths. The HDR environment is representable in both project exports
but not in scene glTF, so `.glb` mesh exports omit it (documented in the
exported README). No export contains a Session ID or the dev token.

Snapshots, recordings and mesh exports hide the editor's gizmo, selection box
and helpers first, so the exported media contains only the scene. They also
force the authoritative pin+track pose at the current playhead immediately
before the capture or parse, so a just-committed seek cannot lag by a render
frame. Captures and exports are refused while a track authoring transaction or
a structural intent is pending. Deleted
objects are absent from every export and clone meshes are present. Formats with
node names (GLB, OBJ) use the export naming rule: the display alias when set,
else the object's original name, else its type (manual objects fall back to
their shape/handle). The alias is assigned only during `parse` and every name is
restored in a `finally`, so it never leaks back into script names or the scene
code. STL has no node names.

Static `.glb` remains the default; the animated variant appears only when at
least one enabled `position`/`rotation`/`scale` track **with keys** is bound to
a UID present in the current runtime scene tree. Hidden nodes may be animated;
disabled, keyless, unresolved, deleted, detached and non-TRS-only tracks hide
the action. It samples the pure evaluator, not the live scene, pins or
`onFrame`: `fps` clamps to 1–120, sample times are `i/fps`, and a 5 s clip at
30 fps contains exactly 150 samples from 0 through 4.9667 s. The exported file
has one animation with only translation/rotation/scale channels and
temporarily unique node names, restored after parse. Visibility, material,
light, texture, environment, particle, shader and script motion are not
animated, and visibility is never emulated with scale 0.

glTF stores key instants, not an explicit clip-duration property, so
`GLTFLoader` reports the loaded clip duration as the last key: 4.9667 s for the
150-sample example. The intended values are written to `animations[0].extras` as
`extras.timelineDuration=5`, `extras.fps=30` and `extras.frameCount=150`, and
reappear as `clip.userData` after loading, so a viewer that needs the exact
timeline duration can read them. The acceptance probe loads the same bytes with the
vendored `GLTFLoader` and drives an `AnimationMixer`, checking sampled node
motion between t=0 and t=2.5.

Because `GLTFExporter` skips hidden nodes, every sampled tracked node and each
of its ancestors is temporarily shown for the export and restored by the same
idempotent cleanup path. A hidden ancestor is itself serialized; visible
descendants of a forced hidden tracked node and visible siblings under a forced
ancestor are serialized too. An isolated hidden non-tracked node that is not on
a forced chain stays omitted, matching static export, and detached/helper nodes
are never eligible. No pose, pin, track or key-preview pass runs after this
visibility forcing, so a hidden tracked node keeps a valid integer channel
target.

An animated plan above 7200 frames (60 s at 120 fps) is refused, never
truncated or partially written. The menu action shows the localized cap notice
and downloads nothing; a direct `export-gltf` protocol command with
`animated: true` posts a structured `animated-frame-cap` error carrying the cap
and computed count, surfaces the same localized notice, and delivers no `.glb`.
The normal 150-sample plan is unaffected.

Standalone HTML and project ZIP evaluate every track offline before the first
frame, including visibility, material and light tracks; video records the live
playhead. USDZ and FBX are not shipped; the market research defers them (no
first-party FBX exporter; USDZ files balloon).

### Deterministic MP4 / GIF

The menu and command palette expose **Export MP4 (deterministic)** and
**Export GIF (deterministic)** next to the realtime recorder. The frame plan is
fixed: 960×540, the timeline duration clamped to 0.1–60 s, and the current step
FPS clamped to 1–60. Frame `i` renders at exactly `i/fps` and the count is
`round(duration × fps)` — 5 s at 30 fps is exactly 150 frames, independent of
wall-clock speed, dropped animation frames or tab throttling. MP4 allows up to
3600 frames; GIF is capped at 600. Larger plans are refused before the first
frame with a localized notice.

Each frame temporarily resizes the preview canvas to 960×540 at pixel ratio 1,
hides selection/gizmo helpers, stops the live callback/track clock, evaluates
the script callbacks, pins and tracks at the plan time, renders, and reads the
WebGL drawing buffer (rows flipped to top-left order). Timeline/stats messages
are suppressed during capture. End, cancel, timeout or a Session/revision
change restores the original canvas size, CSS size, aspect, pixel ratio,
playhead, playing state and helper visibility. The progress modal is parent
DOM and never appears in a frame. **Cancel** (button or Escape) downloads
nothing. Keep the tab visible: frame capture is message-driven, but hidden-tab
throttling can hit the 5 s per-frame timeout, which aborts with no partial
file. A pending parameter/structural/key gesture cancels the export with the
usual notice; the realtime WebM recorder and deterministic export cannot run
at the same time.

MP4 uses WebCodecs plus the vendored `mp4-muxer` 5.2.2 (MIT). Codec selection
is preflighted in this order:

| Preflight result | Output |
|---|---|
| H.264 `avc1.42001f` supported | MP4 with AVC (`avc1`), fast-start in memory |
| H.264 unsupported, VP9 `vp09.00.10.08` supported | VP9-in-MP4 plus a translated compatibility notice (Chrome/Edge play it; use WebM for Safari/Firefox) |
| Neither supported, or the encoder/muxer cannot start before frame 1 | Translated notice and the existing realtime WebM recorder for the same duration; no fake MP4 |

Encoding uses one keyframe per second, a bounded `encodeQueueSize` with
`dequeue` backpressure, and flushes the encoder before finalizing the muxer.
A failure after frames have been captured aborts and downloads nothing;
fallback only happens before the first frame. `mp4-muxer` records a creation
timestamp, so two MP4s can differ byte-for-byte even when their frame pixels
and sample tables are identical. The deterministic claim is about the frame
grid, sample count and per-frame RGBA hashes, not container bytes.

GIF uses the vendored `gifenc` 1.0.3 (MIT): a 256-colour palette per frame,
`delay = round(1000/fps)` ms, then `finish()`. GIF stores delays in
centiseconds, so 30 fps becomes 3 cs per frame: 150 frames play for about
4.5 s, not 5.0 s. The file still contains exactly 150 image frames; the modal
and this README state the timing caveat instead of pretending otherwise.

Scripts that call `Date.now()`, `performance.now()`, `Math.random()` or use
real elapsed time are not made deterministic, and GPU/driver differences can
change individual pixels. Same machine, same inputs and the same session
produce identical per-frame RGBA hashes. No export contains a Session ID, dev
token or workbench chrome. The sandbox is unchanged
(`allow-scripts allow-pointer-lock allow-downloads`, no `allow-same-origin`).
Both libraries are served locally from `runtime/vendor/` with their MIT
licenses; they are imported only by the parent UI and make no network calls.
See `runtime/vendor/README.md` for pinned versions, hashes and the one local
modification (gifenc's source-map comment removed).

## Share links

**Share link…** in the **More actions** menu, or **Share link** in the command
palette, publishes the current scene as an unguessable 22-character link
(`/three-workbench/share/<id>`). The same command exists in English and Chinese.
Sharing waits until the editor runtime, the current scene revision and the
Session asset list are ready. It refuses with a localized notice when the
current revision has an **active local code draft** (drafts are browser-local
and revision-scoped), when the user is viewing read-only history, when the scene
changes during the snapshot, or when the selected row is the demo record for a
Session with no Host scene. Inactive drafts may be present without blocking the
share; the share never contains any local draft.

A share is a frozen snapshot: script code, the v2 editor state and step FPS are
captured together, and every asset in the Session is embedded in the document as
a `data:` URI under a fresh 22-character id. This includes uploads that the
current scene does not reference, so a script calling `assets.*` for an
uploaded name keeps working; the document never points at the original
capability asset route, and deleting an original upload later does not break the
share. Because the snapshot owns the bytes, link holders can see **all** Session
assets, including unreferenced uploads. Local code drafts and history revisions
are not included. A share is refused if the document or JSON body exceeds its
size caps (26 MiB document, 40 MiB body), if the decoded assets exceed the
16 MiB data-URL export cap, or if an exported override references a missing
asset; the stored share must also fit the 30 MiB per-share, 8-share / 64 MiB
per-Session and 32-share / 128 MiB global quotas. No partial share is created.

The link is fetched in a fresh context with no dev token or cookie:

- The shell is a constant Host response with no scene data. Its iframe sandbox
  is exactly `allow-scripts allow-pointer-lock allow-downloads` and never
  includes `allow-same-origin`; model code still never receives a navigable HTML
  URL. The document is served as a `text/plain` attachment and assigned to the
  frame's `srcdoc`.
- The shell's `Content-Security-Policy` is a constant, fixed-source policy (no
  Host, origin or request value is interpolated); its `frame-src about:` admits
  only the `srcdoc` frame. The document adds its own best-effort meta policy,
  with `frame-src 'none'` and `connect-src data: blob:`.
  External `fetch`/WebSocket/EventSource/prefetch/preload/ping/frame/worker/
  download attempts and external self-navigation are blocked, as is a nested
  external iframe. Chromium ignores `navigate-to`; nested `about:srcdoc` /
  `about:blank` frames and WebRTC are not blocked by CSP. The document
  restricts `connect-src` to `data:`/`blob:` because the runtime does not need
  a first-party fetch; if a future runtime does, first-party fetch would be
  explicitly scoped. The sandbox protects the editor origin, not the viewer's
  network, so a maliciously authored scene must not be treated as a network
  sandbox.
- There are no viewer controls: the page auto-plays and loops the timeline,
  applies camera/override/parameter/manual-object/track state, and supports
  OrbitControls in the sandbox.
- Shell, metadata and document responses are `no-store`/`nosniff` with no
  `access-control-allow-origin`, and contain no dev token, Session ID, scene
  code in the shell, or asset capability URL.

The **Manage shares…** dialog lists the links this browser created. Links
default to a 7-day lifetime; the allowed TTL is 1 hour to 30 days. Revoking
removes the link locally and makes the shell, metadata and document return the
same 404 as an expired or unknown id. The delete key lives only in this
browser's bounded 20-entry registry, alongside the link; losing that registry
means waiting for expiry. A successful create that loses its response can leave
an orphan that counts against quota until it expires; Close is disabled after
the POST is dispatched, but delivery cannot be guaranteed. Shares are persisted on Linux until their TTL expires or the delete key
revokes them; restarting the Host retains old links. The delete key remains
browser-side, the shared document embeds Session assets, and local drafts and
history revisions are never shared.

The Host strictly validates the `Host` header on every share route before any
lookup and rejects crafted values with a plain bad-request response and no
shell. Valid DNS names, IPv4 and bracketed IPv6 literals with valid ports are
accepted. A valid foreign DNS name still receives the same constant CSP; no
Host-derived source is possible.

## History, restore and diff

The filmstrip is the history view. Selecting an older revision makes the agent
code read-only and shows the history banner with **Compare with latest** and
**Restore as latest**; **Latest** and **Play** keep working. Scenes with no Host
revision show the demo and no history actions. The header clock button reopens
the History panel at any time, including after the left panel was collapsed;
the clock in the Studio rail selects the same tab while the panel is open.

**Diff** fetches the selected revision and the current latest from the
same-origin scene route and renders a side-by-side table. Only stored agent code
is compared; local drafts, camera state and overrides are excluded. Comparison
normalizes CRLF/lone CR and one final newline but compares all other whitespace
and Unicode exactly. Titles are display-capped at 200 code points plus `…`;
stored titles and code are never truncated. The diff refuses inputs that exceed
256 KiB of code per side, 4,000 lines per side or 16,008,001 comparison cells,
and refuses a raw scene response over 2 MiB, with distinct localized
`diffTooLarge` / `diffResponseTooLarge` messages. All code and titles render as
text nodes in the parent DOM, never as HTML or a new iframe.

**Restore** asks for confirmation, then copies the selected revision's agent
code and title into a new latest revision (`head + 1`); it never copies the
thumbnail. The new 200 response means *submitted*, not *done*: the selected
revision is pinned and the client waits until both the feed's latest row and the
returned record match the returned revision and timestamp. Record-only retries
run at 500/1500/3000 ms; if confirmation has not happened after 15 s the UI
shows the terminal unconfirmed/reload message, and a later feed cannot silently
confirm or move the view. A missing Session, a trimmed source revision and a
newer agent revision produce distinct session-gone, source-gone and superseded
states. The old draft is never applied or deleted by restore; overrides, camera,
parameters, tracks, manual objects and local code drafts are preserved and may
no longer match the restored code, which the confirmation and history bar warn
about.

The restore route is `POST /three-workbench/scene/restore`, same-origin only,
authenticated by the existing `x-workbench-session` header, with no CORS and no
public/share route. It accepts exactly `{sourceRevision, sourceUpdatedAt,
expectedRevision, expectedUpdatedAt, requestId}` in a 4 KiB body, with 2 s idle
/ 5 s total body limits, 6 requests/min per Session, 30 requests/min globally,
1 concurrent request per Session / 2 globally, and an 8-entry, 10-minute
idempotency cache per Session. The Host validates the strict Host allowlist,
Origin/Sec-Fetch-Site, content type/encoding and Session before rate limiting,
then source and head identity. Errors are split as 400 `bad-host`/`fields`,
403 `origin`, 404 `session`/`source-revision`, 405 `method`, 408 `timeout`,
409 `conflict`/`source-latest`/`idempotency-conflict`/`too-large`, 413
`too-large`, 415 `content-type`/`encoding`, 429 `rate` with `retry-after`, and
500 `internal`. Success appends one revision under the shared 12-revision trim
and returns only `{ok, revision, sourceRevision, updatedAt}`; no Session id,
token or request id is echoed. Every failure appends nothing and caches nothing.

Scene history and restore-appended revisions persist across Host restart on
Linux; restore idempotency entries and rate/bookkeeping state remain memory-only.
A lost restore response can be retried, but the first append may have committed,
so `editor.restoreConflict`'s "this restore did not execute" clause is not
guaranteed in that crash window; check the latest revision as the safe recovery.
If the append was not committed and the Session persisted: a present source
whose `updatedAt` matches and an expected head equal to the current head return
409 `source-latest` when the source equals the current head, while an older
source with the same matching expected head returns the normal 200 append; a
stale expected head returns 409 `conflict`; an absent or `updatedAt`-mismatched
source returns 404 `source-revision`; a new Session with no committed revision,
an LRU-evicted Session, or an explicitly cleared Scene Session returns 404
`session`. A committed append persists, and its retry returns 409 `conflict` or
404 `source-revision` (never `source-latest`), with no session-gone notice while
the Session remains in the 16-session keep set. A stalled restore still requires
reload.

Set the model key either in `.env` at the harness root or through the Web
**Models** page.

## Verify the wiring

```sh
./verify.sh                                   # plugin routes
TOKEN=<the ?token= value the host prints> ./verify.sh   # boot graph too
~/.local/node24/bin/node --test "tests/**/*.mjs"  # host + browser behavior tests
WORKBENCH_URL='<host-url-with-token>' npm run test:e2e  # browser E2E
```

`verify.sh` needs `curl --noproxy '*'` behavior (it already bypasses proxies,
which otherwise intercept 127.0.0.1).

The P5 browser harness (`tests/e2e/run.mjs`, exposed by `npm run test:e2e`)
needs `WORKBENCH_URL` set to a disposable Host URL; do not print or commit a
real token. When Playwright, Chromium or the URL is unavailable it reports a
clear SKIP instead of a failure. The default run is non-mutating. Failed checks
leave a screenshot and JSON record under
`/tmp/three-workbench-e2e-artifacts/<run>/<check-id>.{png,json}`. Set
`WORKBENCH_SHARE_URL` to opt into the separate read-only share-viewer check; it
is not required for the default run.

The message protocol, overlay history marker, stable-ID rules, track and asset
formats, share viewer and persistence model are specified in
[`docs/PROTOCOL.md`](PROTOCOL.md).

## Script contract handed to the model

The model's `code` is executed once as a plain function body with:

| Name | Meaning |
|---|---|
| `THREE` | Three.js namespace (r186) |
| `addons` | `{ OrbitControls }` |
| `scene`, `camera`, `renderer`, `canvas`, `clock`, `controls` | prepared stage; camera at `(0, 2.5, 7)` looking at origin |
| `onFrame(cb)` | per-frame callback receiving `{ time, delta, elapsed, THREE, scene, camera, renderer, controls, canvas }` |
| `setBackground(color)` | accepts a CSS color or `THREE.Color` |
| `setCamera(position, target)` | arrays of three numbers |
| `assets` | name-only `assets.url/texture/model/hdri` helpers; see **Assets** above |
| `wb.id(object, name)` | sets `object.userData.wbId`, returns the object; stable identity for selection, overrides, history and exports |
| `wb.expose(schema, apply)` | one user-parameter declaration; the callback receives frozen values at load and after accepted panel changes |

The runtime renders `scene` with `camera` every frame. Imports, `require`, and
top-level `await` are unavailable; the script must be ≤ 256 KiB.

## Security model

Model-written code runs inside `<iframe sandbox="allow-scripts
allow-pointer-lock allow-downloads">` (opaque origin, no `allow-same-origin`).
It cannot touch the app DOM, storage, or the `/api` bridge; pointer lock and
downloads are opt-ins for interactive scenes, not access to the host page. The preview document is passed as `srcDoc` and is never served
as a navigable URL, so there is no page where generated code runs unsandboxed.

The three.js runtime files are the only cross-origin reads the frame performs;
the Host serves them with `access-control-allow-origin: *`.

Uploaded assets are untrusted data, never navigable documents or code. The Host
stores only sniffed raster images, GLB/GLTF with embedded `data:` URIs, and HDR
bytes, then serves them by 22-character capability ID with the sniffed MIME
type, `x-content-type-options: nosniff`, `access-control-allow-origin: *`,
`content-security-policy: default-src 'none'; sandbox`, a safe
`content-disposition` (inline for images, attachment for models/HDR), and no
token or Session ID in the URL. Direct navigation to a stored file therefore
cannot execute script; upload/delete remain same-origin JSON endpoints guarded
by the Session header. The preview sandbox attribute is unchanged. Shared
scenes use the same sandbox triple in the Host's constant viewer shell; their
document is a `text/plain` attachment assigned to `srcdoc`, never a navigable
HTML response, and their CSP is constant with no Host-derived source.

## Install as a profile bundle (optional)

Instead of the `--patch` overlay:

```sh
cd /path/to/host-checkout
pnpm dsh plugin --profile web add /path/to/three-workbench
pnpm dsh web
```

`package.json` declares `dsh.bundle.patch`, so the profile reconciles the
bundle automatically.

## Limitations

- Uploaded assets are per Session and, on Linux, persisted in the Host data
  directory: restarting the Host retains them; clearing the Scene Session or
  evicting it by the 16-session product limit deletes them. On other platforms
  the Host reports `disk-unsupported` and they are memory-only. Bytes are never
  persisted to localStorage, scene revisions or export manifests beyond the
  copies an export snapshots. Uploads are capped at 24 assets / 48 MiB per
  Session and 128 assets / 256 MiB globally; exports snapshot the assets they
  contain and do not track later changes.
- Scenes and thumbnails are persisted on Linux (12 revisions per Session, 16
  Sessions, 240 thumbnails); restarting the Host retains valid data, and the
  product caps trim by order. On other platforms they are memory-only and a
  restart clears them until the agent writes the scene again.
- Committed assets of a Session with no acknowledged scene revision are
  preserved on Linux across restarts, survive scene-directory removal, and can
  be listed, served and deleted without creating a scene; a later committed
  scene adopts their asset-owner epoch instead of revoking them. A Session whose
  scene data is truncated or unscanned is preserved, is not counted in the
  16-session LRU, and refuses scene appends until the store is reduced; its
  committed assets remain available.
- A valid store that exceeds the cooperative startup deadline or load/scan/root
  budgets degrades and preserves data; some valid records or share links may be
  unavailable until the store is reduced or an operator intervenes. No
  acknowledged record is deleted.
- Layout and playback preferences (preview side, open/closed state, frame
  aspect, render scale, frame-step FPS) are stored in the client's
  `localStorage` and survive reloads in the same browser profile. Manual
  overrides, camera and timeline duration are stored per Session under
  `three-workbench:editor:v2:<session>` (camera, overrides, renderer settings,
  manual object definitions and tracks are separate from playback prefs such as
  speed, loop and step FPS). Tracks are capped at 200 per session, 1,000 keys
  per track and 10,000 keys per session; malformed members and unknown
  `tracks.v` are dropped fail-closed and reported rather than guessed. A v1
  override blob is migrated lazily on load and kept until the first
  successful v2 save. Corrupt v2 data is backed up and replaced with an empty
  editor state with a banner; a malformed manual manifest is retained in a
  quarantine backup, reported, and skipped by the runtime while valid entries
  keep loading. Quota failures are surfaced too. Legacy v1 anchors bind only on
  exactly one live match, so renamed or duplicated objects are not guessed.
  Overrides do not follow objects that the script removes and re-creates with
  a different `wb.id`.
- Local code drafts are browser-local and revision-scoped: at most 512 KiB of
  UTF-8 per Session/revision, with only the applied flag in memory. A reload
  starts on agent code; after a newer Host revision, a stale draft must be
  applied to the current revision or discarded from the conflict banner.
  Console output is capped at 200 entries in parent memory and is never
  persisted, sent to the agent, or exported.
- Below 776px of viewport width the preview becomes a full-viewport overlay
  rather than squeezing the conversation past its 400px floor; the header **3D**
  button opens it, and Escape or Back closes it (Escape does not close during an
  active export). In the 776–1023px band the plugin does not force a dock: a
  docked track stays docked, while a Host-reported zero width or withheld dock
  eligibility (`canShow === false`) uses the overlay entry. This is not a full
  tablet layout. Touch editing uses fixed thresholds (10px /
  500ms tap, 500ms long press, 1.25 gizmo handles) rather than per-device
  calibration. The overlay's safe-area CSS is unverified on real iOS; this
  Linux/WPE WebKit host reports zero insets, so the P4 IV-SAFE-AREA
  expected-nonzero behavior remains a platform-coverage gap (audit FAIL, 1
  MAJOR), not a demonstrated CSS defect.
- Share links are persisted on Linux until their TTL or delete-key deletion;
  restarting or stopping the Host retains old links, and expiry and revocation
  are the cleanup paths. The delete key exists only in the creating browser's
  registry. All Session assets (including unreferenced uploads) are embedded in
  the shared document, so a link holder sees assets the current scene does not
  use. Local code drafts and history revisions are never shared, and a demo row
  for a Session with no Host scene is blocked.
- Delete/restore/duplicate/rename keep one tagged history entry per gesture and
  the history is capped at 100 entries; undo/redo is revision-scoped and is
  cleared when the scene revision changes. There is no deleted-object list:
  deleted script objects are hidden tombstones restored only by Undo.
- Duplicate acts on the primary selected object only; multi-select duplicates
  the primary. v1 duplicates plain `Mesh` sources with non-Shader materials
  only. Clones are derived from their source (re-cloned per load): a clone whose
  source is deleted remains until reload, then is reported and skipped, and a
  cycle/missing source is surfaced in the outliner unresolved banner.
- Aliases are display-only and not unique: two objects may share an alias and
  exports may then contain duplicate node names. UIDs remain the identity.
- Reparent is single-object in v1 (dragging a multi-selection moves the primary
  only); `Object3D.attach` under a non-uniform-scale/rotated parent can drop
  shear. Script hierarchy intent survives reload/revision, but a script
  object's reloaded local can differ from its drop-time local when an ancestor
  is animated or a parent transform override is applied afterwards. Share
  documents carry the same v2 `parent` metadata; local drafts and history
  are never shared.

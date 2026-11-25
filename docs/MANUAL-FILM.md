# Manual and film

Three Studio treats the same 3D scene as reusable product content: an
interactive manual and a deterministic product film. Both are optional editor
metadata stored beside the existing scene record; the scene code stays the
source of truth.

## Manual mode

Open **Manual** from the left rail.

- **Capture step** records the current camera, timeline time and selected
  object as a step.
- Edit the step title and body, re-apply the current camera, highlight the
  selection, reorder or delete steps, and play the sequence.
- **Hotspots** add a named anchor to the selected object per step. The share
  viewer lists them with a Focus action and draws a projected leader line from
  each list row to the object while the scene runtime reports its screen
  position. The editor lists hotspots without projected lines.
- **Parts / BOM** stores part number, name, quantity and an optional object
  UID at the manual level. The share viewer and print view list the BOM.
  **Import CSV** appends rows from a `number,name,qty` table (English or
  Chinese headers; quoted fields and a leading UTF-8 BOM are accepted) and
  **Export CSV** downloads the current BOM for spreadsheets; both are capped
  at 64 parts.
- Steps are stored in `editorRecordV2.presentation.manual` and normalized on
  load: at most 64 steps, 16 step parts, 16 hotspots per step, 64 BOM parts and
  bounded text.
- Sharing a scene includes the manual. The share viewer shows a read-only step
  sidebar and drives the sandboxed scene through the existing camera, select,
  visibility and timeline commands.
- AI can draft a manual through `workbench_proposal` with kind `manual`. The
  proposal is inert until the user applies it.

A step currently contains a camera pose, optional timeline time, hidden UIDs,
one highlight UID, plain text, a parts list and hotspot UIDs. Rich text,
projected leader lines, per-locale step bodies and analytics are follow-up
work.

## Film mode

Open **Film** in the bottom dock.

- **Take shot** appends an ordered shot from the current camera; each shot
  stores a start and end camera pose plus a duration.
- Select a shot to edit its duration, set its start/end camera from the current
  view, reorder it, or play the sequence.
- Choose aspect ratio (16:9, 9:16, 1:1, 4:5) and FPS (24/30/60).
- **Captions** accept SRT text; **Download SRT** emits the sidecar. The film
  export also downloads the SRT automatically when captions exist.
- **Music** accepts a local audio file (up to 20 MiB). It is previewed with an
  audio element and stored in IndexedDB for this browser. MP4 export muxes a
  48 kHz stereo Opus track when the browser supports `AudioEncoder`; otherwise
  the video exports without audio and the UI says so. Safari playback of
  Opus-in-MP4 is limited.
- **Export 1080p MP4** renders the shot sequence through the existing capture
  protocol:

  | Aspect | Pixels |
  | --- | --- |
  | 16:9 | 1920 × 1080 |
  | 9:16 | 1080 × 1920 |
  | 1:1 | 1080 × 1080 |
  | 4:5 | 1080 × 1350 |

- The normal export menu keeps the 960 × 540 default; the Film drawer requests
  the larger plan explicitly.
- H.264 High profile level 4.0/4.2 candidates are probed first, then the
  960 × 540 baseline profile, then VP9. The capture protocol still caps a plan
  at 1920 × 1080 pixels, 60 seconds and 3,600 frames.
- **Safe-area guides** — while the Film dock is open, the viewport dims outside
  the selected aspect and overlays a 90% title-safe and 80% action-safe frame.
- A film export never falls back to the realtime WebM recorder: when no
  deterministic MP4 encoder is available the export cancels with a notice, so
  the file always matches the shot plan.
- **Export all aspects** runs 16:9, 9:16, 1:1 and 4:5 sequentially with the
  same shots, captions and music. Each file carries its aspect suffix; a failed
  or cancelled variant stops the batch and the notice reports how many files
  completed.

Each shot interpolates from its start camera to its end camera with a smooth
ease; cuts between shots are hard. Arbitrary multi-key camera curves, fades and
per-aspect reframing are follow-up work. The frame sampling and camera path are
deterministic; encoded bytes can differ across GPUs/browsers.

## Print / PDF and QR

The share viewer's manual sidebar has **Print / PDF**, which opens the browser
print dialog with a print-only document: title, product/version, every step's
text, step parts/hotspots, BOM and a QR code for the share URL. Choose "Save as
PDF" in the print dialog. The QR is generated locally from the vendored MIT
`qrcode-generator`; no external QR service is called.

## Local event log

The Log drawer keeps a bounded, browser-local log of coarse manual/film actions
(step or shot capture, BOM import, playback, exports). Entries contain counts
and enums only — never scene code, user text or asset content — are capped at
300 and can be cleared from the drawer. The log never leaves the browser: there
is no telemetry, upload or hosted dashboard in the open core.

## Limits

- Manual/film metadata is browser-local editor state, like camera overrides and
  keyframes. Share links carry it; switching machines does not. Music files are
  kept in this browser's IndexedDB and are not included in shares.
- Shares keep the existing asset and state caps (30 MiB record, 2 MiB editor
  state).
- Film duration is the sum of shot durations, or the current timeline when no
  shots exist, capped at 60 seconds / 3,600 frames.
- Film export requires a deterministic MP4 encoder; it cancels with a notice
  instead of falling back to realtime WebM.
- Camera paths are one eased start→end pose per shot with hard cuts. There are
  no arbitrary multi-key curves, fades, 4K or cloud rendering; local batch
  export covers the four aspects and runs one deterministic job at a time.
- SRT and Opus audio muxing are best-effort browser features. Safari playback
  of Opus-in-MP4 is limited; unsupported audio encoders produce a video-only
  file with a notice.
- PDF is browser print-to-PDF; the open core does not bundle a PDF library.
- The manual viewer uses text only for user content (`textContent`, never
  markup). Hotspots are a sidebar list with Focus; the sandboxed scene runtime
  draws the projected leader lines, and the share shell still never listens to
  scene messages.
- The local event log is browser-only; hosted analytics and dashboards are Pro
  services.

## Open core and Pro

The Apache-2.0 core includes the presentation schema, manual/film authoring,
the share viewer, 1080p deterministic export, and the AI manual proposal.

Hosted manual publishing, comments/review/approvals, team permissions, SSO,
audit logs, hosted analytics, translation workflow, managed AI/TTS, stock
music/SFX libraries, 4K/ProRes, cloud/parallel batch rendering, brand kits and
premium templates belong in separate Pro services or private repositories. The local core stays fully functional
without a license, and basic 1080p export is not paywalled.

See [`OPEN-CORE.md`](OPEN-CORE.md) for the boundary and
[`EXPORTS.md`](EXPORTS.md) for export details.

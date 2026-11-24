# Exports

Every export runs inside the sandboxed preview iframe and is delivered to the
parent page by `postMessage`; the parent only downloads the bytes. Exports
never include editor chrome, console logs, HUD text or API keys.

## Targets

| Menu item | Command | Output | Notes |
| --- | --- | --- | --- |
| Snapshot | `capture` | PNG | Current frame at the preview resolution |
| Record | `record` | WebM | Real-time `MediaRecorder` capture |
| Export MP4 | export job | MP4 | Deterministic fixed-grid frames (960×540 default) |
| Export GIF | export job | GIF | Same deterministic frame plan, palette-quantized |
| Export glTF | `export-gltf` | `.glb` | Static scene, binary glTF |
| Export animated glTF | `export-gltf` + `animated` | `.glb` | Sampled keyframe tracks with a frame cap |
| Export STL | `export-stl` | `.stl` | Binary STL for printing |
| Export OBJ | `export-obj` | `.obj` | Text geometry, no materials |
| Export USDZ | `export-usdz` | `.usdz` | AR Quick Look; stored (uncompressed) zip with `model.usda` |
| Export FBX | `export-fbx` | `.fbx` | Binary FBX 7.4 (version 7400), static meshes |
| Project ZIP | — | `.zip` | Scene, assets and editor-state archive; re-import is not implemented yet |
| Standalone HTML | — | `.html` | Single-file scene page with the same sandbox; loads Three.js from jsDelivr and needs network access |

## USDZ

- Exporter: vendored `three@0.186.0` `USDZExporter`, writing stored zip entries
  as the USDZ specification (and Apple) require. Textures are embedded through
  the exporter's default 1024 px limit.
- Scope: the visible scene at export time, including editor overrides and manual
  objects. Hidden helper objects are detached first.
- Not included: animation (the current pose is exported), editor helpers,
  console output.
- Use: open in AR Quick Look, Preview (macOS) or any USDZ-compatible viewer.

## FBX

- Writer: `runtime/exporters/FBXExporter.js`, an original, dependency-free
  binary FBX 7.4 writer. It is verified by round-tripping real output through
  the vendored three.js `FBXLoader` (hierarchy, compound rotations, corner
  geometry, UVs, normals and Phong colors).
- Coordinates and units: authored in metres with
  `GlobalSettings UnitScaleFactor = 100` (1 unit = 100 cm), matching Blender's
  metre-unit FBX output. Vertices are not rescaled.
- Geometry: triangles with per-corner normals and one UV set; missing normals
  fall back to face normals. `InstancedMesh` instances become sibling models
  sharing one geometry.
- Hierarchy: groups become FBX `Null` models so parenting survives; each model
  carries local translation/rotation/scale (XYZ Euler, `Rz·Ry·Rx`), so parent
  transforms are applied exactly once.
- Materials: converted to FBX Phong. Diffuse/emissive/specular colors are
  written in sRGB; roughness and metalness drive shininess/specular strength;
  opacity becomes `TransparencyFactor`. PBR channels, textures and vertex
  colors are not carried over. Material groups become per-polygon assignment.
- Names: transliterated to printable ASCII and made unique per object type.
- Not included: animation, skinning, lights, cameras, morph targets.
- Use: import into Blender, Maya, 3ds Max, Unity and other FBX 7.4 consumers.
  Because there is no animation track, re-animate in the DCC or export glTF for
  animated hand-off.

## Security notes

- USDZ and FBX are produced by code that runs inside the preview iframe; the
  parent never evaluates scene content.
- FBX is written from the same scene snapshot as glTF, so overrides, manual
  objects and hierarchy intents are honoured.
- Exported files are untrusted content once they leave the Studio; open them
  only in viewers you trust.

## Verification

```sh
~/.local/node24/bin/node --test tests/export-fbx.test.mjs
~/.local/node24/bin/node tests/e2e/exports.mjs   # npm run test:e2e:exports
```

The browser probe drives the real export menu against a mock provider and
checks the file magic, zip storage method and FBX version plus node names.

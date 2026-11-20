# Vendored export libraries

These files are pinned, unminified dependencies for the P2-2 deterministic
MP4/GIF export and the P2-4 USDZ/FBX exports. They are served by the existing
`/three-workbench/runtime/` route. The MP4/GIF builds are imported only by the
parent UI (`client.js`); `fflate.module.js` is additionally imported inside
the sandboxed preview runtime through the vendored `USDZExporter` (zip writing
only, no network). None of them make network requests at runtime.

| File | Upstream package | Version | License |
|---|---|---|---|
| `mp4-muxer.js` | [`mp4-muxer`](https://github.com/Vanilagy/mp4-muxer) `build/mp4-muxer.mjs` | 5.2.2 | MIT |
| `gifenc.js` | [`gifenc`](https://github.com/mattdesl/gifenc) `dist/gifenc.esm.js` | 1.0.3 | MIT |
| `MP4-MUXER-LICENSE.txt` | `mp4-muxer@5.2.2/LICENSE` | 5.2.2 | MIT |
| `GIFENC-LICENSE.txt` | `gifenc@1.0.3/LICENSE.md` | 1.0.3 | MIT |
| `fflate.module.js` | [`fflate`](https://github.com/101arrowz/fflate) via `three@0.186.0/examples/jsm/libs/fflate.module.js` | 0.8.2 | MIT (header in file) |

SHA-256 of the files as committed:

- `mp4-muxer.js`: `d2c4c782f180c86ed30b1f5d9487a34a0d370bf9b4535285734ea187d38f9bb5`
  (identical to the upstream build)
- `gifenc.js`: `cec614f6b77348eb6ea6a64921bab65e72d5e7f839a097c8fda8fc883c3146f7`
  (upstream pre-strip SHA-256 is
  `217761244379253ba5815510d3048a4fb1f4c4dbe9fb51a5cfbfe26f34eec093`)

## Local modifications

- `fflate.module.js`: unchanged `three@0.186.0` copy; its committed SHA-256 is
  `209a4412eb48ce609edb4391992a792ffcc3983d30ee7e2b0b89a8c470f3cd8a`.

- `gifenc.js`: the trailing `//# sourceMappingURL=...` line was removed. The
  minified build itself is otherwise unchanged; exports were not renamed.
- `mp4-muxer.js`: unchanged (the build has no banner; the license file is
  authoritative).

## P2-4 exporter provenance

- `runtime/exporters/USDZExporter.js` is the verbatim
  `three@0.186.0/examples/jsm/exporters/USDZExporter.js` with one change: the
  fflate import points at `../vendor/fflate.module.js`. It writes stored
  (level 0) zip entries as USDZ requires.
- `runtime/exporters/FBXExporter.js` is original code (a dependency-free
  binary FBX 7.4 writer; see its header for the documented limits), validated
  by `tests/export-fbx.test.mjs` and by round-tripping real exports through
  the vendored FBXLoader.
- `runtime/loaders/FBXLoader.js`, `runtime/curves/NURBSCurve.js` and
  `runtime/curves/NURBSUtils.js` are the verbatim `three@0.186.0` example
  modules (MIT, covered by `runtime/THREE-LICENSE.txt`) with import-path fixes
  only: fflate resolves to `../vendor/fflate.module.js` and NURBS utils
  resolve relatively inside `curves/`. The loader is vendored so interop
  validation and any future FBX asset import run on pinned repo code instead
  of CDN fetches.

## Why these are vendored

Exports must work offline and must not execute third-party code from a CDN.
Both libraries are small MIT builds with a stable API for the exact operations
the exporter needs (`Muxer`/`ArrayBufferTarget`/`addVideoChunk` and
`GIFEncoder`/`quantize`/`applyPalette`). Pinning them also keeps MP4 sample
tables and GIF timing reproducible across sessions.

`mp4-muxer@5.2.2` is upstream-deprecated in favour of Mediabunny. Pinning this
small, audited build is deliberate: it is sufficient for a single video track
with in-memory fast-start and avoids pulling a larger toolkit into the plugin.
Revisit only with a new design/audit cycle.

## Security notes

The files contain no tokens, Session IDs, host URLs, network fetches, `eval`,
or dynamic code loading. URL strings that appear inside source comments are
documentation only. The Host serves them as static `text/javascript`; the
parent imports them with a same-origin dynamic `import()`.

# Vendored export libraries

These files are pinned, unminified dependencies for the P2-2 deterministic
MP4/GIF export. They are served by the existing `/three-workbench/runtime/`
route and imported only by the parent UI (`client.js`). The sandboxed preview
runtime never imports them, and they make no network requests at runtime.

| File | Upstream package | Version | License |
|---|---|---|---|
| `mp4-muxer.js` | [`mp4-muxer`](https://github.com/Vanilagy/mp4-muxer) `build/mp4-muxer.mjs` | 5.2.2 | MIT |
| `gifenc.js` | [`gifenc`](https://github.com/mattdesl/gifenc) `dist/gifenc.esm.js` | 1.0.3 | MIT |
| `MP4-MUXER-LICENSE.txt` | `mp4-muxer@5.2.2/LICENSE` | 5.2.2 | MIT |
| `GIFENC-LICENSE.txt` | `gifenc@1.0.3/LICENSE.md` | 1.0.3 | MIT |

SHA-256 of the files as committed:

- `mp4-muxer.js`: `d2c4c782f180c86ed30b1f5d9487a34a0d370bf9b4535285734ea187d38f9bb5`
  (identical to the upstream build)
- `gifenc.js`: `cec614f6b77348eb6ea6a64921bab65e72d5e7f839a097c8fda8fc883c3146f7`
  (upstream pre-strip SHA-256 is
  `217761244379253ba5815510d3048a4fb1f4c4dbe9fb51a5cfbfe26f34eec093`)

## Local modifications

- `gifenc.js`: the trailing `//# sourceMappingURL=...` line was removed. The
  minified build itself is otherwise unchanged; exports were not renamed.
- `mp4-muxer.js`: unchanged (the build has no banner; the license file is
  authoritative).

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

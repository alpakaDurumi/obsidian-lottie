# Lottie

An Obsidian plugin that renders Lottie animations in notes. Embed one the same
way an image is embedded:

```
![[spinner.json]]
```

Rendering is done by [ThorVG](https://github.com/thorvg/thorvg) through
[`@thorvg/webcanvas`](https://www.npmjs.com/package/@thorvg/webcanvas) 1.1.1.
The backend (software / WebGL / WebGPU) is chosen in the plugin settings.

## Build

```
npm install
npm run build
```

`npm run build` bundles `main.js` and also copies the three release files into
`test-vault/.obsidian/plugins/lottie/` — a local scratch vault (not committed)
that can be opened in Obsidian to try the plugin. `npm run dev` produces an
unminified build with an inline source map; `npm run check` type-checks
without building.

## The WebAssembly binary

Obsidian's community installer only downloads `main.js`, `manifest.json` and
`styles.css` from a release, so `thorvg.wasm` cannot ship as its own file. It is
embedded in `main.js` instead: esbuild's `binary` loader base64-encodes it at
build time and decodes it back to a `Uint8Array` at runtime, which is handed to
ThorVG as a blob URL. Without that, `@thorvg/webcanvas` falls back to fetching
the binary from unpkg at runtime, which would break offline use.

## License

MIT — see [LICENSE](LICENSE).

`main.js` embeds a WebAssembly build of ThorVG, which statically links
RapidJSON (MIT), JerryScript (Apache-2.0) and libwebp (BSD-3-Clause).
Compilation strips their notices from the binary, so they are reproduced in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md), and a short legal header at
the top of `main.js` names them and points there.

When the `@thorvg/webcanvas` version changes, check out `thorvg.web` at the
matching `webcanvas@<version>` tag (with its submodule) and run
`node scripts/collect-licenses.mjs <path to checkout>`; the script refuses a
checkout that does not match the installed version.

## Notes

- Animations start when they scroll into view and pause when they leave it.
- Only plain Lottie JSON is handled. `.lottie` (dotLottie) archives are not.
- The plugin claims `.json` embeds, but a `.json` that is not a Lottie document
  (no `layers`/`fr`/`op`) is handed back to Obsidian and shows its usual file
  card. Files are classified in the background and re-checked when they change.

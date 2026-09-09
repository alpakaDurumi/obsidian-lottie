# Lottie

An Obsidian plugin that plays Lottie animations inside your notes.

## Features

- **Embed like an image** — an animation plays where you put it in a note.
- **Size and alignment** — the same syntax images take.
- **Open on a tab** — clicking a file in the explorer plays it full pane.
- **Live updates** — editing an animation in another program updates it in
  Obsidian straight away.
- **Select rendering backends** — CPU, WebGL or WebGPU, switchable in settings.

## Usage

Embed a `.json` animation the way you would embed an image:

```
![[spinner.json]]
```

### Size and alignment

```md
![[spinner.json|300]]        300 wide; the height follows the animation's proportions
![[spinner.json|300x100]]    exactly 300 by 100, proportions ignored
![[spinner.json|center]]     left, center or right
![[spinner.json|center|300]] both, with the size last
```

A size always comes last. If you write several alignments the last one is used,
and anything that is not one of the three words is ignored.

### Opening a file on its own

Clicking a `.json` in the file explorer opens the animation on a tab, scaled to
fill the pane.

Obsidian hides file types it does not know, so `.json` files will not appear in
the explorer until you turn on **Settings → Files and links → Detect all file
extensions**. Embedding them in a note works either way.

### Settings

**Renderer** picks what draws the animations:

- **Software** — draws on the CPU. Works everywhere, with no limit on how many
  animations a note can hold. The default.
- **WebGL** and **WebGPU** — draw on the graphics card. Far faster for a
  demanding animation, but each one holds a graphics context and the browser
  keeps only about sixteen at a time; past that, animations stop rendering and
  do not come back. Worth switching to for a few heavy animations, not for a
  note full of them.

Changing it redraws everything on screen.

## Development

```
npm install
npm run build
```

`npm run build` produces `main.js` and copies the three release files into
`test-vault/`, a scratch vault (not committed) you can open in Obsidian to try
the plugin. `npm run dev` builds unminified with an inline source map, and
`npm run check` type-checks without building.

Rendering is done by [ThorVG](https://github.com/thorvg/thorvg) through
[`@thorvg/webcanvas`](https://www.npmjs.com/package/@thorvg/webcanvas) 1.1.1.
Obsidian only installs `main.js`, `manifest.json` and `styles.css` from a
release, so `thorvg.wasm` cannot ship beside them: esbuild base64-encodes it
into the bundle and it is handed to ThorVG as a blob URL at runtime. Without
that, `@thorvg/webcanvas` would fetch the binary from a CDN and the plugin
would stop working offline.

## License

MIT — see [LICENSE](LICENSE).

The bundled ThorVG binary statically links RapidJSON (MIT), JerryScript
(Apache-2.0) and libwebp (BSD-3-Clause). Compilation strips their notices, so
they are reproduced in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) and
summarised in a header at the top of `main.js`.

`scripts/collect-licenses.mjs` regenerates that file from a checkout of
thorvg.web at the tag matching the installed `@thorvg/webcanvas`.

# Lottie

An Obsidian plugin that plays Lottie animations inside your notes.

## Usage

Embed a `.json` animation the way you would embed an image:

```
![[spinner.json]]
```

### Size

```md
![[spinner.json|300]]       300 wide; the height follows the animation's proportions
![[spinner.json|300x100]]   exactly 300 by 100, proportions ignored
![[spinner.json]]           the animation's own size
```

### Alignment

Add `left`, `center` or `right`:

```md
![[spinner.json|center]]
![[spinner.json|center|300]]
```

A size always comes last. If you write several alignments the last one is used,
and anything that is not one of the three words is ignored.

### Settings

**Renderer** picks what draws the animations:

- **Software** — works everywhere. The default.
- **WebGL** and **WebGPU** — draw on the graphics card. Faster for demanding
  animations, but each animation holds a graphics context and there is a limit
  to how many a page can keep, so a note packed with animations may not render
  properly. Switch back to Software if that happens.

Changing it redraws every open note.

## Good to know

- Only `.json` Lottie files. `.lottie` archives are not supported yet.
- A `.json` that is not an animation is left alone and shows the usual file
  card, so the plugin will not interfere with data files in your vault.

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

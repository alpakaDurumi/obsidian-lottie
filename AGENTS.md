# obsidian-lottie

Obsidian plugin that renders Lottie animations with ThorVG. The source is
`src/main.ts` and `styles.css`.

## Commands

- `npm run check` — `tsc --noEmit`.
- `npm run lint` — ESLint, including `eslint-plugin-obsidianmd`, which encodes the
  community-plugin review rules.
- `npm run dev` — one unminified build with an inline sourcemap, then copies the
  release files into `test-vault/`. Not a watcher: run it again after each change.
- `npm run build` — the minified release build, then the same copy.

CI runs `check` and `lint` on every push. Run both before handing work back.
There is no test suite. Behaviour is verified by hand in `test-vault/`.

## Generated, not sources

- `main.js` is the build output and is gitignored. Releases attach it from CI
  (`.github/workflows/release.yml`), so it is never committed.
- `test-vault/` is written by `scripts/install.mjs`. Edits there are overwritten
  by the next build.
- `manifest.json`'s `version` and `versions.json` are written by `npm version`
  (`scripts/version-bump.mjs`). Don't edit them by hand. `versions.json` keeps
  one row per `minAppVersion`, naming the newest release that needs it. A release
  on the same floor replaces that row, and one that raises the floor adds a row.

## Pitfalls

- `thorvg.wasm` is inlined into `main.js` by esbuild's `binary` loader, because
  Obsidian's installer downloads only `main.js`, `manifest.json` and
  `styles.css`. A separate `.wasm` asset would never reach a user.
- Three Obsidian APIs used here are undocumented: `app.embedRegistry`,
  `leaf.rebuildView()` and `app.openWithDefaultApp()`. They exist at runtime but
  are missing from the `obsidian` package's type declarations, so each call site
  states the extra shape it needs on the spot, above a comment saying why. Add
  the next one the same way. Don't extend the `obsidian` module's declarations,
  which would make an undocumented call look like a supported one.
- `minAppVersion` is `1.13.0`. Raise it in the same commit that starts using a
  newer API.
- `isDesktopOnly` is `false`, so a change to rendering, layout or input is not
  done until it has run on a phone. The software, WebGL and WebGPU renderers are
  all confirmed working on a Galaxy S10 5G (Android) and an iPhone 13 mini (iOS).
  Only the maintainer can test on a device: hand over the steps to try and wait
  for the result rather than assuming the desktop outcome carries over.

## Conventions

- Comments explain why the code is as it is, in full sentences. Match the
  density of the surrounding code rather than annotating each line.
- Commit subjects name the change in the code's own language, such as
  `fix: reserve --view-bottom-spacing under the frame controls`.
- No formatter is configured. Follow the files: two-space indent, 100-column
  lines, double quotes.

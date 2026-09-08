// Regenerates THIRD-PARTY-LICENSES.md from the ThorVG sources the bundled
// wasm was built from. Run it whenever the @thorvg/webcanvas version changes:
//
//   node scripts/collect-licenses.mjs [path to thorvg.web checkout]
//
// The checkout must be at the tag matching the installed @thorvg/webcanvas
// (e.g. webcanvas@1.1.1, with the thorvg submodule initialised); the script
// refuses to run against anything else so the notices cannot drift from the
// binary they describe.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const web = path.resolve(root, process.argv[2] ?? "../thorvg.web");
const core = path.join(web, "thorvg");

const read = (file) => {
  if (!fs.existsSync(file)) throw new Error(`missing file: ${file}`);
  return fs.readFileSync(file, "utf8");
};

// Pull a version out of C preprocessor defines like `#define FOO_MAJOR 1`.
const defines = (file, names) =>
  names
    .map((n) => read(file).match(new RegExp(`#define\\s+${n}\\s+(\\d+)`))?.[1] ?? "?")
    .join(".");

// --- guard: checkout must match what is installed -------------------------

const installed = (() => {
  const req = createRequire(path.join(root, "package.json"));
  const dist = path.dirname(req.resolve("@thorvg/webcanvas"));
  return JSON.parse(read(path.join(dist, "..", "package.json"))).version;
})();
const checkout = JSON.parse(read(path.join(web, "packages/webcanvas/package.json"))).version;
if (installed !== checkout) {
  throw new Error(
    `installed @thorvg/webcanvas is ${installed} but the checkout at ${web} is ${checkout}; ` +
      `check out tag webcanvas@${installed} first`,
  );
}

// --- components ----------------------------------------------------------

const thorvgVersion = read(path.join(core, "meson.build")).match(/version\s*:\s*'([^']+)'/)?.[1] ?? "?";

const components = [
  {
    name: "ThorVG",
    version: thorvgVersion,
    spdx: "MIT",
    url: "https://github.com/thorvg/thorvg",
    why: "The rendering engine itself. Its PNG and JPEG decoders are ThorVG's own code and fall under this licence.",
    file: path.join(core, "LICENSE"),
  },
  {
    name: "ThorVG.Web (@thorvg/webcanvas)",
    version: checkout,
    spdx: "MIT",
    url: "https://github.com/thorvg/thorvg.web",
    why: "The WebAssembly bindings and TypeScript API.",
    file: path.join(web, "LICENSE"),
  },
  {
    name: "RapidJSON",
    version: defines(path.join(core, "src/loaders/lottie/rapidjson/rapidjson.h"), [
      "RAPIDJSON_MAJOR_VERSION",
      "RAPIDJSON_MINOR_VERSION",
      "RAPIDJSON_PATCH_VERSION",
    ]),
    spdx: "MIT",
    url: "https://github.com/Tencent/rapidjson",
    why: 'Parses Lottie JSON. Linked in by -Dloaders="lottie".',
    file: path.join(core, "src/loaders/lottie/rapidjson/LICENSE"),
  },
  {
    name: "JerryScript",
    version: defines(path.join(core, "src/loaders/lottie/jerryscript/jerry-core/include/jerryscript.h"), [
      "JERRY_API_MAJOR_VERSION",
      "JERRY_API_MINOR_VERSION",
      "JERRY_API_PATCH_VERSION",
    ]),
    spdx: "Apache-2.0",
    url: "https://github.com/jerryscript-project/jerryscript",
    why: 'Evaluates Lottie expressions. Linked in by -Dextra="lottie_exp".',
    file: path.join(core, "src/loaders/lottie/jerryscript/jerry-core/LICENSE"),
  },
  {
    name: "libwebp (decoder)",
    version: defines(path.join(core, "src/loaders/webp/dec/vp8i.h"), [
      "DEC_MAJ_VERSION",
      "DEC_MIN_VERSION",
      "DEC_REV_VERSION",
    ]),
    spdx: "BSD-3-Clause",
    url: "https://chromium.googlesource.com/webm/libwebp",
    why: 'Decodes WebP assets embedded in a Lottie file. Linked in by -Dloaders="webp".',
    file: path.join(core, "src/loaders/webp/LICENSE"),
  },
];

// --- output --------------------------------------------------------------

const summary = components
  .map((c) => `| ${c.name} | ${c.version} | ${c.spdx} | <${c.url}> |`)
  .join("\n");

const header = `# Third-party notices

\`main.js\` embeds a WebAssembly build of ThorVG, which statically links the
components below. Compilation strips every notice from the binary, so they are
reproduced here. All are permissive licences; the obligation they carry is that
these notices accompany the distribution.

| Component | Version | Licence | Source |
|---|---|---|---|
${summary}

Generated from \`thorvg.web\` at tag \`webcanvas@${checkout}\` by
\`scripts/collect-licenses.mjs\`.
`;

const sections = components.map(
  ({ name, version, spdx, url, why, file }) =>
    `\n---\n\n## ${name} ${version}\n\n${why}\n\nLicence: ${spdx} — ${url}\n\n\`\`\`\n${read(file).trim()}\n\`\`\`\n`,
);

const out = header + sections.join("");
fs.writeFileSync(path.join(root, "THIRD-PARTY-LICENSES.md"), out);
console.log(`THIRD-PARTY-LICENSES.md written (${out.length} bytes)`);
for (const c of components) console.log(`  ${c.name.padEnd(34)} ${c.version.padEnd(8)} ${c.spdx}`);

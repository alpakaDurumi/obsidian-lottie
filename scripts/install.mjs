// Copies the three release files into the bundled test vault so the plugin can
// be tried without touching a real vault.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { id } = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
const target = path.join(root, "test-vault", ".obsidian", "plugins", id);

await fs.mkdir(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await fs.copyFile(path.join(root, file), path.join(target, file));
}

console.log(`installed to ${target}`);

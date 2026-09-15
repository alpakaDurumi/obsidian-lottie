// Run by `npm version`: copies the new version into manifest.json and notes
// which Obsidian version it needs, so a user on an older app can still be
// offered the newest release that works for them.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = process.env.npm_package_version;
if (!version) {
  throw new Error("npm_package_version is unset; this runs through `npm version`");
}

const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
manifest.version = version;
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const versionsPath = path.join(root, "versions.json");
const versions = JSON.parse(await fs.readFile(versionsPath, "utf8"));
versions[version] = manifest.minAppVersion;
await fs.writeFile(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);

console.log(`${version} requires Obsidian ${manifest.minAppVersion}`);

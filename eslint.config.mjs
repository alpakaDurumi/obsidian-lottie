import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Build output and the Node-side build tooling. The community directory's
  // scanner skips test-vault, scripts and esbuild.config.mjs as well.
  globalIgnores(["main.js", "test-vault/", "scripts/", "esbuild.config.mjs"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
  },
]);

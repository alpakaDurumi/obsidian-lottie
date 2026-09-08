// Resolved by the `thorvg-wasm` esbuild plugin in esbuild.config.mjs: the
// binary is read from @thorvg/webcanvas and embedded in main.js through
// esbuild's `binary` loader, which decodes it back to a Uint8Array at runtime.
declare module "thorvg-wasm" {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}

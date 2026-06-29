// Bundle the CLI into a single self-contained file. The memory-storage core is
// inlined; only the native / heavy runtime deps stay external (they ship their
// own platform binaries and must be installed, not bundled). The result needs
// no workspace resolution, so it can be published and installed standalone.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["better-sqlite3", "sqlite-vec", "@huggingface/transformers"],
  // The shebang from src/cli.ts is hoisted to the top of the bundle by esbuild;
  // adding a banner shebang too would leave a second, invalid one on line 2.
});

console.log("bundled → dist/cli.js");

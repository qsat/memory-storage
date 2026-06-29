// Assemble a standalone, installable CLI package from the bundled CLI.
//
// The output directory is a self-contained npm package: a single bundled
// cli.js, a package.json whose only dependencies are the native/heavy runtime
// libraries, and a bin named `memory-storage`. It has no workspaces and no
// build step, so it can be installed directly from a git ref:
//
//   npm i -g github:qsat/memory-storage#release
//
// The GitHub Action runs this and publishes the result to the `release` branch.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const corePkg = read("packages/core/package.json");
const cliPkg = read("packages/cli/package.json");

// The bundle externalizes exactly these; pin them to the versions core uses.
const RUNTIME_DEPS = ["better-sqlite3", "sqlite-vec", "@huggingface/transformers"];
const dependencies = Object.fromEntries(
  RUNTIME_DEPS.map((name) => {
    const range = corePkg.dependencies?.[name];
    if (!range) throw new Error(`missing runtime dependency in core: ${name}`);
    return [name, range];
  })
);

const bundle = path.join(root, "packages/cli/dist/cli.js");
if (!fs.existsSync(bundle)) {
  throw new Error("bundle not found — run the CLI build first (npm run build)");
}

const outDir = path.join(root, "release");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const pkg = {
  name: "memory-storage",
  version: cliPkg.version,
  description: "Local hybrid-search / RAG memory CLI (prebuilt)",
  type: "module",
  bin: { "memory-storage": "cli.js" },
  dependencies,
  engines: cliPkg.engines ?? { node: ">=20.0.0" },
};

fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(pkg, null, 2) + "\n"
);
fs.copyFileSync(bundle, path.join(outDir, "cli.js"));

const readmeSrc = path.join(root, "README.md");
if (fs.existsSync(readmeSrc)) {
  fs.copyFileSync(readmeSrc, path.join(outDir, "README.md"));
}

console.log(`assembled release package → ${outDir}`);
console.log(`  name: ${pkg.name}@${pkg.version}`);
console.log(`  bin:  memory-storage → cli.js`);
console.log(`  deps: ${Object.keys(dependencies).join(", ")}`);

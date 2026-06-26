#!/usr/bin/env node
/**
 * Build the MCPB staging directory at build/mcpb.
 *
 * The Crossbeam MCP server (src/mcp.ts) plus all of its dependencies are bundled
 * into a single self-contained ESM file so the resulting .mcpb does not need to
 * ship node_modules. After this runs, `mcpb pack build/mcpb crossbeam.mcpb`
 * produces the importable bundle.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "mcpb");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "server"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "mcp.ts")],
  outfile: join(out, "server", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // Node ESM needs require() shimmed when a bundled dep reaches for it.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "const require = __cr(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

for (const file of ["manifest.json", "README.md", "LICENSE", "NOTICE", "ATTRIBUTION.md"]) {
  cpSync(join(root, file), join(out, file));
}

console.log(`\nStaged MCPB bundle at ${out}`);

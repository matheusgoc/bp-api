// Bundles each Lambda handler into dist/<name>/index.js with esbuild.
// Usage: node scripts/build.mjs [--watch]
import { build, context } from "esbuild";
import { rmSync } from "fs";

// One entry per Lambda function. Keys must match the names used in
// lib/bp-api-stack.ts (Code.fromAsset('dist/<name>')).
const entries = {
  health: "src/handlers/health.ts",
  "categories-add": "src/handlers/categories/add.ts",
  "categories-update": "src/handlers/categories/update.ts",
  "categories-list": "src/handlers/categories/list.ts",
  "categories-preview": "src/handlers/categories/preview.ts",
  "categories-enable": "src/handlers/categories/enable.ts",
  "categories-disable": "src/handlers/categories/disable.ts",
  "categories-reorder": "src/handlers/categories/reorder.ts",
  "places-add": "src/handlers/places/add.ts",
  "places-update": "src/handlers/places/update.ts",
  "places-publish": "src/handlers/places/publish.ts",
  "places-review": "src/handlers/places/review.ts",
  "places-unpublish": "src/handlers/places/unpublish.ts",
  "places-list": "src/handlers/places/list.ts",
  "places-preview": "src/handlers/places/preview.ts",
};

const watch = process.argv.includes("--watch");

if (!watch) {
  rmSync("dist", { recursive: true, force: true });
}

/** @type {import('esbuild').BuildOptions[]} */
const configs = Object.entries(entries).map(([name, entry]) => ({
  entryPoints: [entry],
  outfile: `dist/${name}/index.js`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  minify: false,
  // AWS SDK v3 ships with the Node.js Lambda runtime — no need to bundle it
  external: ["@aws-sdk/*"],
  logLevel: "info",
}));

if (watch) {
  for (const config of configs) {
    const ctx = await context(config);
    await ctx.watch();
  }
  console.log("👀 Watching handlers for changes... (Ctrl+C to stop)");
} else {
  await Promise.all(configs.map(build));
  console.log(`✅ Built ${configs.length} handlers into dist/`);
}

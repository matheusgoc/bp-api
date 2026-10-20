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
  "places-upload-image": "src/handlers/places/uploadImage.ts",
  "places-approve-image": "src/handlers/places/approveImage.ts",
  "locations-add": "src/handlers/locations/add.ts",
  "locations-update": "src/handlers/locations/update.ts",
  "locations-remove": "src/handlers/locations/remove.ts",
  "locations-preview": "src/handlers/locations/preview.ts",
  "offers-add": "src/handlers/offers/add.ts",
  "offers-update": "src/handlers/offers/update.ts",
  "offers-cancel": "src/handlers/offers/cancel.ts",
  "offers-preview": "src/handlers/offers/preview.ts",
  "offers-list": "src/handlers/offers/list.ts",
  "profile-signup": "src/handlers/profile/signup.ts",
  "profile-preview": "src/handlers/profile/preview.ts",
  "profile-update": "src/handlers/profile/update.ts",
  "profile-convert": "src/handlers/profile/convert.ts",
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
  // Only the DynamoDB-family SDK packages are confirmed present in the Node.js 22
  // managed Lambda runtime — name those explicitly rather than a blanket
  // "@aws-sdk/*" wildcard, so other @aws-sdk/* packages (e.g. client-s3,
  // s3-request-presigner) get bundled in instead of failing at runtime.
  external: ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"],
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

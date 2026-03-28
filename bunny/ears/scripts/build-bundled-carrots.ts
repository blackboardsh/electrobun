/**
 * Pre-builds the Dash carrot so it can be embedded in the Bunny Ears app bundle
 * as a ready-to-install artifact (no source build needed at runtime).
 *
 * Usage: bun scripts/build-bundled-carrots.ts
 * Called automatically by the electrobun build via postBuild or manually.
 */

import { resolve, join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { buildCarrotSource } from "../src/bun/carrotBuilder";

const earsRoot = resolve(import.meta.dirname, "..");
const dashSource = resolve(earsRoot, "..", "dash");
const outputDir = resolve(earsRoot, "build-bundled-carrots", "bunny-dash");

async function main() {
  console.log("[build-bundled-carrots] Building Dash carrot...");
  console.log(`  Source: ${dashSource}`);
  console.log(`  Output: ${outputDir}`);

  if (!existsSync(dashSource)) {
    console.error(`Dash source not found at ${dashSource}`);
    process.exit(1);
  }

  // Ensure dash dependencies are installed
  const dashNodeModules = join(dashSource, "node_modules");
  if (!existsSync(dashNodeModules)) {
    console.log("  Installing dash dependencies...");
    const { execSync } = await import("node:child_process");
    execSync("bun install", { cwd: dashSource, stdio: "inherit" });
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  try {
    await buildCarrotSource(dashSource, outputDir);
    console.log("[build-bundled-carrots] Dash carrot built successfully.");
  } catch (err) {
    console.error("[build-bundled-carrots] Build failed:", err);
    process.exit(1);
  }
}

main();

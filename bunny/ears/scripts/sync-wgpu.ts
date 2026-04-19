import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const sourceRoot = join(root, "node_modules", "electrobun", "vendors", "wgpu");
const cacheRoot = join(root, "node_modules", ".electrobun-cache", "wgpu");
const versionFile = join(sourceRoot, ".wgpu-version");

if (!existsSync(sourceRoot)) {
  console.error(`[sync-wgpu] missing source root: ${sourceRoot}`);
  process.exit(1);
}

mkdirSync(cacheRoot, { recursive: true });

const normalizedVersion = existsSync(versionFile)
  ? (() => {
      const version = readFileSync(versionFile, "utf8").trim();
      return version.startsWith("v") ? version : `v${version}`;
    })()
  : null;

for (const target of ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64", "win-x64", "win-arm64"]) {
  const sourceDir = join(sourceRoot, target);
  if (!existsSync(sourceDir)) continue;
  const destDir = join(cacheRoot, target);
  cpSync(sourceDir, destDir, { recursive: true, force: true });
  if (normalizedVersion) {
    writeFileSync(join(destDir, ".wgpu-version"), normalizedVersion);
  }
  console.log(`[sync-wgpu] cached ${target}`);
}

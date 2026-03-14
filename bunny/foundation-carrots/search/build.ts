import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const FD_BINARY_NAME = process.platform === "win32" ? "fd.exe" : "fd";
const RG_BINARY_NAME = process.platform === "win32" ? "rg.exe" : "rg";

type BuildContext = {
  sourceDir: string;
  outDir: string;
  manifest: any;
  defaultBuild: () => Promise<void>;
};

function walk(dir: string, onEntry: (entryPath: string) => boolean | void) {
  if (!existsSync(dir)) {
    return false;
  }

  for (const entry of readdirSync(dir)) {
    const entryPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }

    if (onEntry(entryPath)) {
      return true;
    }

    if (stat.isDirectory() && walk(entryPath, onEntry)) {
      return true;
    }
  }

  return false;
}

function findColabVendorBinary(sourceDir: string, binaryName: string) {
  const buildRoot = resolve(sourceDir, "..", "..", "..", "..", "colab", "build");
  let foundPath: string | null = null;

  walk(buildRoot, (entryPath) => {
    if (!entryPath.endsWith(`/vendor/${binaryName}`) && !entryPath.endsWith(`\\vendor\\${binaryName}`)) {
      return false;
    }

    foundPath = entryPath;
    return true;
  });

  return foundPath;
}

function copyVendorBinary(
  sourceDir: string,
  outDir: string,
  binaryName: string,
  envOverride: string | undefined,
  required: boolean,
) {
  const sourcePath =
    (envOverride && existsSync(envOverride) ? envOverride : null) ||
    findColabVendorBinary(sourceDir, binaryName);

  if (!sourcePath) {
    if (required) {
      throw new Error(`Missing required search binary ${binaryName}. Set an override env var or build Colab locally first.`);
    }
    return;
  }

  cpSync(sourcePath, join(resolve(outDir), binaryName), { force: true });
}

export async function buildCarrot({ sourceDir, outDir, defaultBuild }: BuildContext) {
  await defaultBuild();

  copyVendorBinary(
    sourceDir,
    outDir,
    RG_BINARY_NAME,
    process.env.BUNNY_SEARCH_RG_BIN,
    true,
  );
  copyVendorBinary(
    sourceDir,
    outDir,
    FD_BINARY_NAME,
    process.env.BUNNY_SEARCH_FD_BIN,
    false,
  );
}

export default buildCarrot;

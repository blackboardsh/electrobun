import { cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const FD_BINARY_NAME = process.platform === "win32" ? "fd.exe" : "fd";
const RG_BINARY_NAME = process.platform === "win32" ? "rg.exe" : "rg";

type BuildContext = {
  sourceDir: string;
  outDir: string;
  manifest: any;
  defaultBuild: () => Promise<void>;
};

function resolveVendorBinary(sourceDir: string, binaryName: string) {
  const localVendorPath = resolve(sourceDir, "vendor", binaryName);
  if (existsSync(localVendorPath)) {
    return localVendorPath;
  }

  return null;
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
    resolveVendorBinary(sourceDir, binaryName);

  if (!sourcePath) {
    if (required) {
      throw new Error(
        `Missing required search binary ${binaryName}. Add it under ${resolve(sourceDir, "vendor")} or set an override env var.`,
      );
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

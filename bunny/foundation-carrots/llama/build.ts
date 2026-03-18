import { execFileSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const LLAMA_BINARY_NAME = process.platform === "win32" ? "llama-cli.exe" : "llama-cli";

type BuildContext = {
  sourceDir: string;
  outDir: string;
  defaultBuild: () => Promise<void>;
};

function resolveOverrideBinary() {
  const explicitPath = process.env.BUNNY_LLAMA_CLI_BIN;
  if (explicitPath && existsSync(explicitPath)) {
    return resolve(explicitPath);
  }
  return null;
}

function buildBundledLlamaCli(sourceDir: string) {
  const llamaCliSourceDir = join(sourceDir, "llama-cli");
  const zigBinary = join(
    sourceDir,
    "..",
    "..",
    "..",
    "package",
    "vendors",
    "zig",
    process.platform === "win32" ? "zig.exe" : "zig",
  );

  if (!existsSync(zigBinary)) {
    throw new Error(`Missing Zig binary at ${zigBinary}`);
  }

  if (!existsSync(join(llamaCliSourceDir, "build.zig"))) {
    throw new Error(`Missing local llama-cli source at ${llamaCliSourceDir}`);
  }

  execFileSync(zigBinary, ["build"], {
    cwd: llamaCliSourceDir,
    stdio: "pipe",
  });

  const builtBinary = join(llamaCliSourceDir, "zig-out", "bin", LLAMA_BINARY_NAME);
  if (!existsSync(builtBinary)) {
    throw new Error(`Failed to build llama-cli at ${builtBinary}`);
  }

  return builtBinary;
}

export async function buildCarrot({ sourceDir, outDir, defaultBuild }: BuildContext) {
  await defaultBuild();

  const binaryPath = resolveOverrideBinary() || buildBundledLlamaCli(sourceDir);
  cpSync(binaryPath, join(outDir, LLAMA_BINARY_NAME), {
    force: true,
  });
}

export default buildCarrot;

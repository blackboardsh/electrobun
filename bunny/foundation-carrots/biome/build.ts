import { cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

type BuildContext = {
  sourceDir: string;
  outDir: string;
  defaultBuild: () => Promise<void>;
};

function decodeOutput(bytes: Uint8Array<ArrayBufferLike> | undefined) {
  return new TextDecoder().decode(bytes || new Uint8Array());
}

function resolveBiomePackageDir(sourceDir: string) {
  return resolve(sourceDir, "node_modules", "@biomejs");
}

function ensureBiomeDependency(sourceDir: string) {
  const packageJsonPath = join(sourceDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Missing bunny.biome package.json at ${packageJsonPath}`);
  }

  const packageDir = resolveBiomePackageDir(sourceDir);
  if (existsSync(join(packageDir, "biome", "package.json"))) {
    return packageDir;
  }

  const lockPath = join(sourceDir, "bun.lock");
  const installArgs = existsSync(lockPath)
    ? [process.execPath, "install", "--frozen-lockfile"]
    : [process.execPath, "install"];
  const result = Bun.spawnSync(installArgs, {
    cwd: sourceDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to install bunny.biome dependencies:\n${decodeOutput(result.stderr) || decodeOutput(result.stdout)}`,
    );
  }

  if (!existsSync(join(packageDir, "biome", "package.json"))) {
    throw new Error(`@biomejs namespace was not installed at ${packageDir}`);
  }

  return packageDir;
}

export async function buildCarrot({ sourceDir, outDir, defaultBuild }: BuildContext) {
  await defaultBuild();

  const biomeNamespaceDir = ensureBiomeDependency(sourceDir);
  cpSync(biomeNamespaceDir, join(outDir, "@biomejs"), {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}

export default buildCarrot;

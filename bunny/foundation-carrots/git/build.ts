import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";

type BuildContext = {
  sourceDir: string;
  outDir: string;
  manifest: any;
  sdkViewModule: string;
  sdkBunModule: string;
};

function assertBuildSuccess(label: string, result: Awaited<ReturnType<typeof Bun.build>>) {
  if (result.success) {
    return;
  }

  const details = result.logs
    .map((log) => log.message || log.name || JSON.stringify(log))
    .join("\n");

  throw new Error(`Failed to build ${label}${details ? `\n${details}` : ""}`);
}

function sdkViewAliasPlugin(sdkViewModule: string) {
  return {
    name: "bunny-git-sdk-view-alias",
    setup(build: any) {
      build.onResolve({ filter: /^bunny-ears\/view$/ }, () => ({ path: sdkViewModule }));
    },
  };
}

function sdkBunAliasPlugin(sdkBunModule: string) {
  return {
    name: "bunny-git-sdk-bun-alias",
    setup(build: any) {
      build.onResolve({ filter: /^electrobun(?:\/bun)?$/ }, () => ({ path: sdkBunModule }));
    },
  };
}

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

function decodeOutput(bytes: Uint8Array<ArrayBufferLike> | undefined) {
  return new TextDecoder().decode(bytes || new Uint8Array());
}

function resolveSimpleGitEntry(sourceDir: string) {
  return resolve(sourceDir, "node_modules", "simple-git", "dist", "esm", "index.js");
}

function findVendoredGitDir(sourceDir: string) {
  const explicitDir = process.env.BUNNY_GIT_VENDOR_DIR;
  if (explicitDir && existsSync(explicitDir)) {
    return resolve(explicitDir);
  }

  const sourceVendorDir = resolve(sourceDir, "..", "..", "..", "..", "colab", "vendor");
  if (existsSync(join(sourceVendorDir, process.platform === "win32" ? "git.exe" : "git"))) {
    return sourceVendorDir;
  }

  const buildRoot = resolve(sourceDir, "..", "..", "..", "..", "colab", "build");
  let foundPath: string | null = null;

  walk(buildRoot, (entryPath) => {
    if (
      entryPath.endsWith(`/vendor/${process.platform === "win32" ? "git.exe" : "git"}`) ||
      entryPath.endsWith(`\\vendor\\${process.platform === "win32" ? "git.exe" : "git"}`)
    ) {
      foundPath = resolve(entryPath, "..");
      return true;
    }

    return false;
  });

  if (foundPath) {
    return foundPath;
  }

  throw new Error(
    "Missing vendored git assets for bunny.git. Set BUNNY_GIT_VENDOR_DIR or ensure colab/vendor exists.",
  );
}

function ensureSimpleGitDependency(sourceDir: string) {
  const packageJsonPath = join(sourceDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Missing bunny.git package.json at ${packageJsonPath}`);
  }

  const simpleGitEntry = resolveSimpleGitEntry(sourceDir);
  if (existsSync(simpleGitEntry)) {
    return simpleGitEntry;
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
      `Failed to install bunny.git dependencies:\n${decodeOutput(result.stderr) || decodeOutput(result.stdout)}`,
    );
  }

  if (!existsSync(simpleGitEntry)) {
    throw new Error(`simple-git was not installed at ${simpleGitEntry}`);
  }

  return simpleGitEntry;
}

function simpleGitAliasPlugin(sourceDir: string) {
  const simpleGitEntry = ensureSimpleGitDependency(sourceDir);

  return {
    name: "bunny-git-simple-git-alias",
    setup(build: any) {
      build.onResolve({ filter: /^simple-git$/ }, () => ({ path: simpleGitEntry }));
    },
  };
}

export async function buildCarrot({ sourceDir, outDir, manifest, sdkViewModule, sdkBunModule }: BuildContext) {
  const webDir = join(sourceDir, "web");
  const viewEntry = join(webDir, "index.ts");
  const viewHtml = join(webDir, "index.html");
  const viewCss = join(webDir, "index.css");
  const webAssets = join(webDir, "assets");
  const workerEntry = join(sourceDir, "worker.ts");
  const viewsOutDir = join(outDir, "views");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(viewsOutDir, { recursive: true });

  cpSync(viewHtml, join(viewsOutDir, "index.html"));
  if (existsSync(viewCss)) {
    cpSync(viewCss, join(viewsOutDir, "index.css"));
  }
  if (existsSync(webAssets)) {
    cpSync(webAssets, join(viewsOutDir, "assets"), { recursive: true, force: true });
  }

  const viewBuild = await Bun.build({
    entrypoints: [viewEntry],
    outdir: viewsOutDir,
    target: "browser",
    plugins: [sdkViewAliasPlugin(sdkViewModule)],
  });
  assertBuildSuccess(`${manifest.name} view`, viewBuild);

  const workerBuild = await Bun.build({
    entrypoints: [workerEntry],
    outdir: outDir,
    target: "bun",
    external: builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
    plugins: [sdkBunAliasPlugin(sdkBunModule), simpleGitAliasPlugin(sourceDir)],
  });
  assertBuildSuccess(`${manifest.name} worker`, workerBuild);

  cpSync(findVendoredGitDir(sourceDir), join(outDir, "vendor"), {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });

  writeFileSync(
    join(outDir, "carrot.json"),
    JSON.stringify(
      {
        ...manifest,
        view: {
          ...manifest.view,
          relativePath: "views/index.html",
        },
        worker: {
          ...manifest.worker,
          relativePath: "worker.js",
        },
      },
      null,
      2,
    ),
  );
}

export default buildCarrot;

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function simpleGitAliasPlugin(sourceDir: string) {
  const simpleGitEntry = resolve(
    sourceDir,
    "..",
    "..",
    "dash",
    "node_modules",
    "simple-git",
    "dist",
    "esm",
    "index.js",
  );

  if (!existsSync(simpleGitEntry)) {
    throw new Error(`Missing simple-git dependency at ${simpleGitEntry}. Run 'bun install' in bunny/dash.`);
  }

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

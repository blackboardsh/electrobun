import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CarrotManifest } from "../carrot-runtime/types";
import { normalizeCarrotPermissions } from "../carrot-runtime/types";

function getSdkViewModule() {
  const override = process.env.BUNNY_EARS_SDK_VIEW_MODULE;
  if (override) {
    return isAbsolute(override) ? override : resolve(override);
  }

  const appRoot = resolve("../Resources/app");
  return join(appRoot, "views", "carrot-sdk-view", "view.js");
}

function getSdkBunModule() {
  const override = process.env.BUNNY_EARS_SDK_BUN_MODULE;
  if (override) {
    return isAbsolute(override) ? override : resolve(override);
  }

  const appRoot = resolve("../Resources/app");
  return join(appRoot, "carrot-runtime", "bun.ts");
}

type CustomBuildContext = {
  sourceDir: string;
  outDir: string;
  manifest: CarrotManifest;
  sdkViewModule: string;
  sdkBunModule: string;
  defaultBuild: () => Promise<void>;
};

type CustomBuildModule = {
  default?: (context: CustomBuildContext) => Promise<void> | void;
  buildCarrot?: (context: CustomBuildContext) => Promise<void> | void;
};

function readManifest(sourceDir: string) {
  const manifestPath = join(sourceDir, "carrot.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing carrot.json in ${sourceDir}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CarrotManifest & {
    permissions?: CarrotManifest["permissions"] | string[];
  };

  return {
    ...manifest,
    permissions: normalizeCarrotPermissions(manifest.permissions),
  } satisfies CarrotManifest;
}

function assertBuildSuccess(
  label: string,
  result: Awaited<ReturnType<typeof Bun.build>>,
) {
  if (result.success) {
    return;
  }

  const details = result.logs
    .map((log) => log.message || log.name || JSON.stringify(log))
    .join("\n");

  throw new Error(`Failed to build ${label}${details ? `\n${details}` : ""}`);
}

function sdkAliasPlugin() {
  return {
    name: "bunny-ears-sdk-alias",
    setup(build: any) {
      build.onResolve({ filter: /^bunny-ears\/view$/ }, () => ({
        path: getSdkViewModule(),
      }));
    },
  };
}

function bunRuntimeAliasPlugin() {
  return {
    name: "bunny-ears-bun-runtime-alias",
    setup(build: any) {
      build.onResolve({ filter: /^electrobun(?:\/bun)?$/ }, () => ({
        path: getSdkBunModule(),
      }));
    },
  };
}

async function runDefaultBuild(sourceDir: string, outDir: string, manifest: CarrotManifest) {
  const webDir = join(sourceDir, "web");
  const viewEntry = join(webDir, "index.ts");
  const viewHtml = join(webDir, "index.html");
  const viewCss = join(webDir, "index.css");
  const webAssets = join(webDir, "assets");
  const workerEntry = existsSync(join(sourceDir, "worker.ts"))
    ? join(sourceDir, "worker.ts")
    : join(sourceDir, "worker.js");
  const viewsOutDir = join(outDir, "views");

  const sdkViewModule = getSdkViewModule();
  const sdkBunModule = getSdkBunModule();

  if (!existsSync(sdkViewModule)) {
    throw new Error(`Missing Bunny Ears SDK bundle: ${sdkViewModule}`);
  }

  if (!existsSync(sdkBunModule)) {
    throw new Error(`Missing Bunny Ears Bun runtime bundle: ${sdkBunModule}`);
  }

  if (!existsSync(viewEntry)) {
    throw new Error(`Missing view entry: ${viewEntry}`);
  }

  if (!existsSync(viewHtml)) {
    throw new Error(`Missing view html: ${viewHtml}`);
  }

  if (!existsSync(workerEntry)) {
    throw new Error(`Missing worker entry: ${workerEntry}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(viewsOutDir, { recursive: true });

  cpSync(viewHtml, join(viewsOutDir, "index.html"));
  if (existsSync(viewCss)) {
    cpSync(viewCss, join(viewsOutDir, "index.css"));
  }
  if (existsSync(webAssets)) {
    cpSync(webAssets, join(viewsOutDir, "assets"), {
      recursive: true,
      force: true,
    });
  }

  const viewBuild = await Bun.build({
    entrypoints: [viewEntry],
    outdir: viewsOutDir,
    target: "browser",
    plugins: [sdkAliasPlugin()],
  });
  assertBuildSuccess(`${manifest.name} view`, viewBuild);

  const workerBuild = await Bun.build({
    entrypoints: [workerEntry],
    outdir: outDir,
    target: "bun",
    plugins: [bunRuntimeAliasPlugin()],
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
      } satisfies CarrotManifest,
      null,
      2,
    ),
  );
}

async function runCustomBuild(sourceDir: string, outDir: string, manifest: CarrotManifest) {
  const buildScriptPath = join(sourceDir, "build.ts");
  if (!existsSync(buildScriptPath)) {
    await runDefaultBuild(sourceDir, outDir, manifest);
    return;
  }

  const module = (await import(
    `${pathToFileURL(buildScriptPath).href}?t=${Date.now()}`
  )) as CustomBuildModule;
  const buildCarrot = module.buildCarrot ?? module.default;

  if (typeof buildCarrot !== "function") {
    throw new Error(
      `Custom carrot build script must export default or buildCarrot(): ${buildScriptPath}`,
    );
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  await buildCarrot({
    sourceDir,
    outDir,
    manifest,
    sdkViewModule: getSdkViewModule(),
    sdkBunModule: getSdkBunModule(),
    defaultBuild: () => runDefaultBuild(sourceDir, outDir, manifest),
  });
}

export async function buildCarrotSource(sourceDir: string, outDir: string) {
  const normalizedSourceDir = resolve(sourceDir);
  const manifest = readManifest(normalizedSourceDir);

  await runCustomBuild(normalizedSourceDir, outDir, manifest);

  const builtManifestPath = join(outDir, "carrot.json");
  if (existsSync(builtManifestPath)) {
    const builtManifest = JSON.parse(readFileSync(builtManifestPath, "utf8")) as CarrotManifest;
    return {
      ...builtManifest,
      permissions: normalizeCarrotPermissions(builtManifest.permissions),
    } satisfies CarrotManifest;
  }

  return manifest;
}

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type BuildContext = {
  sourceDir: string;
  outDir: string;
  manifest: any;
  sdkViewModule: string;
  defaultBuild: () => Promise<void>;
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

async function importModule(modulePath: string) {
  return import(pathToFileURL(modulePath).href);
}

export async function buildCarrot({ sourceDir, outDir, manifest, sdkViewModule }: BuildContext) {
  const resolvedOutDir = resolve(outDir);
  const viewsOutDir = join(resolvedOutDir, "views");
  const workerEntry = existsSync(join(sourceDir, "worker.ts"))
    ? join(sourceDir, "worker.ts")
    : join(sourceDir, "worker.js");
  const colabNodeModules = resolve(sourceDir, "../../../colab/node_modules");
  const esbuildModulePath = join(colabNodeModules, "esbuild", "lib", "main.js");
  const solidPluginModulePath = join(
    colabNodeModules,
    "esbuild-plugin-solid",
    "dist",
    "cjs",
    "plugin.cjs",
  );

  if (!existsSync(esbuildModulePath) || !existsSync(solidPluginModulePath)) {
    throw new Error(
      `Missing local Solid build toolchain. Expected Colab dependencies under ${colabNodeModules}`,
    );
  }

  rmSync(resolvedOutDir, { recursive: true, force: true });
  mkdirSync(viewsOutDir, { recursive: true });

  cpSync(join(sourceDir, "web", "index.html"), join(viewsOutDir, "index.html"));

  const esbuild = await importModule(esbuildModulePath);
  const solidPluginModule = await importModule(solidPluginModulePath);
  const solidPlugin = solidPluginModule.solidPlugin ?? solidPluginModule.default?.solidPlugin;

  if (typeof solidPlugin !== "function") {
    throw new Error("Failed to load esbuild-plugin-solid from Colab dependencies");
  }

  await esbuild.build({
    absWorkingDir: sourceDir,
    entryPoints: [join(sourceDir, "web", "main.tsx")],
    outfile: join(viewsOutDir, "index.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    sourcemap: "inline",
    nodePaths: [colabNodeModules],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    plugins: [
      solidPlugin(),
      {
        name: "bunny-ears-sdk-alias",
        setup(build: any) {
          build.onResolve({ filter: /^bunny-ears\/view$/ }, () => ({
            path: sdkViewModule,
          }));
        },
      },
    ],
  });

  const workerBuild = await Bun.build({
    entrypoints: [workerEntry],
    outdir: resolvedOutDir,
    target: "bun",
  });
  assertBuildSuccess(`${manifest.name} worker`, workerBuild);

  writeFileSync(
    join(resolvedOutDir, "carrot.json"),
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

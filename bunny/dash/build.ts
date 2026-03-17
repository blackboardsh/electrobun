import { execFileSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

type BuildContext = {
  sourceDir: string;
  outDir: string;
  manifest: any;
  sdkViewModule: string;
  sdkBunModule: string;
  defaultBuild: () => Promise<void>;
};

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

function makeDashWindowCss() {
  return `html,
body {
  background: #1e1e1e;
  overflow: hidden;
}

body,
#app {
  min-height: 100vh;
  background: #1e1e1e;
}

#app {
  position: relative;
  overflow: hidden;
}

#app > div:first-child {
  min-height: 100vh;
  background: #1e1e1e;
  border-radius: 14px;
  overflow: hidden;
}

#workbench-container {
  background: #1e1e1e;
}`;
}

function makeElectrobunViewAliasPlugin(sourceDir: string) {
  const adapterPath = join(sourceDir, "colab", "electrobun-view.ts");

  return {
    name: "bunny-dash-electrobun-view-alias",
    setup(build: any) {
      build.onResolve({ filter: /^electrobun\/view$/ }, () => ({
        path: adapterPath,
      }));
    },
  };
}

function makeElectrobunBunAliasPlugin(sdkBunModule: string) {
  return {
    name: "bunny-dash-electrobun-bun-alias",
    setup(build: any) {
      build.onResolve({ filter: /^electrobun(?:\/bun)?$/ }, () => ({
        path: sdkBunModule,
      }));
    },
  };
}

async function buildLens(sourceDir: string, lensOutDir: string) {
  const require = createRequire(import.meta.url);
  const esbuild = require("esbuild");
  const MonacoEsbuildPlugin = require("esbuild-monaco-editor-plugin");
  const { solidPlugin } = require("esbuild-plugin-solid");

  const entry = join(sourceDir, "renderers", "lens", "index.tsx");
  const externalDeps = [
    "vscode",
    "typescript",
    "vs",
    "window-wrapper",
    ...builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
  ];

  await esbuild.build({
    absWorkingDir: sourceDir,
    entryPoints: [entry],
    outfile: join(lensOutDir, "index.js"),
    bundle: true,
    plugins: [
      makeElectrobunViewAliasPlugin(sourceDir),
      MonacoEsbuildPlugin({
        destDir: lensOutDir,
        pathPrefix: "/",
        minify: false,
        languages: ["typescript", "javascript", "html", "css", "json", "markdown"],
      }),
      solidPlugin(),
    ],
    jsxFactory: "Solid.createElement",
    jsxFragment: "Solid.Fragment",
    platform: "browser",
    format: "esm",
    external: externalDeps,
    loader: {
      ".tts": "file",
      ".ttf": "file",
      ".node": "file",
    },
  });
}

async function buildBunny(sourceDir: string, bunnyOutDir: string) {
  const require = createRequire(import.meta.url);
  const esbuild = require("esbuild");

  await esbuild.build({
    absWorkingDir: sourceDir,
    entryPoints: [join(sourceDir, "renderers", "bunny", "index.ts")],
    outfile: join(bunnyOutDir, "index.js"),
    bundle: true,
    plugins: [makeElectrobunViewAliasPlugin(sourceDir)],
    platform: "browser",
    format: "esm",
    loader: {
      ".png": "file",
    },
  });
}

function buildTailwind(sourceDir: string, lensOutDir: string) {
  const tailwindBinary = join(
    sourceDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tailwindcss.cmd" : "tailwindcss",
  );

  if (!existsSync(tailwindBinary)) {
    throw new Error(`Missing tailwindcss binary at ${tailwindBinary}. Run 'bun install' in bunny/dash.`);
  }

  execFileSync(
    tailwindBinary,
    [
      "--content",
      join(sourceDir, "renderers", "lens", "**", "*.tsx"),
      "-c",
      join(sourceDir, "renderers", "tailwind.config.js"),
      "-i",
      join(sourceDir, "renderers", "lens", "index.css"),
      "-o",
      join(lensOutDir, "tailwind.css"),
    ],
    {
      cwd: sourceDir,
      stdio: "pipe",
    },
  );
}

function prepareHtmlAndAssets(sourceDir: string, resolvedOutDir: string) {
  const lensOutDir = join(resolvedOutDir, "lens");
  const bunnyOutDir = join(resolvedOutDir, "bunny");
  const assetsOutDir = join(resolvedOutDir, "assets");

  mkdirSync(lensOutDir, { recursive: true });
  mkdirSync(bunnyOutDir, { recursive: true });
  mkdirSync(assetsOutDir, { recursive: true });

  cpSync(join(sourceDir, "renderers", "lens", "index.html"), join(lensOutDir, "index.html"));
  cpSync(join(sourceDir, "renderers", "lens", "styles"), join(lensOutDir, "styles"), {
    recursive: true,
  });
  cpSync(join(sourceDir, "renderers", "bunny", "index.html"), join(bunnyOutDir, "index.html"));
  cpSync(join(sourceDir, "renderers", "bunny", "index.css"), join(bunnyOutDir, "index.css"));
  cpSync(join(sourceDir, "assets"), assetsOutDir, {
    recursive: true,
  });
  cpSync(join(sourceDir, "assets", "bunny.png"), join(bunnyOutDir, "assets", "bunny.png"), {
    force: true,
  });
  cpSync(
    join(sourceDir, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
    join(lensOutDir, "xterm.css"),
    {
      force: true,
    },
  );
  cpSync(
    join(sourceDir, "assets", "custom.editor.worker.js"),
    join(lensOutDir, "custom.editor.worker.js"),
    {
      force: true,
    },
  );

  const lensHtmlPath = join(lensOutDir, "index.html");
  const lensHtml = readFileSync(lensHtmlPath, "utf8");
  const dashWindowCssHref = "views://lens/bunny-dash-window.css";
  let patchedLensHtml = lensHtml;
  if (!patchedLensHtml.includes(dashWindowCssHref)) {
    patchedLensHtml = patchedLensHtml.replace(
      '<link rel="stylesheet" href="views://lens/index.css" />',
      '<link rel="stylesheet" href="views://lens/index.css" />\n    <link rel="stylesheet" href="views://lens/bunny-dash-window.css" />',
    );
  }
  writeFileSync(lensHtmlPath, patchedLensHtml);
  writeFileSync(join(lensOutDir, "bunny-dash-window.css"), makeDashWindowCss());
}

export async function buildCarrot({ sourceDir, outDir, manifest, sdkBunModule }: BuildContext) {
  const resolvedOutDir = resolve(outDir);
  const workerEntry = existsSync(join(sourceDir, "worker.ts"))
    ? join(sourceDir, "worker.ts")
    : join(sourceDir, "worker.js");

  rmSync(resolvedOutDir, { recursive: true, force: true });
  mkdirSync(resolvedOutDir, { recursive: true });

  const originalCwd = process.cwd();
  process.chdir(sourceDir);
  try {
    prepareHtmlAndAssets(sourceDir, resolvedOutDir);
    buildTailwind(sourceDir, join(resolvedOutDir, "lens"));
    await buildLens(sourceDir, join(resolvedOutDir, "lens"));
    await buildBunny(sourceDir, join(resolvedOutDir, "bunny"));
  } finally {
    process.chdir(originalCwd);
  }

  const workerBuild = await Bun.build({
    entrypoints: [workerEntry],
    outdir: resolvedOutDir,
    target: "bun",
    format: "esm",
    splitting: false,
    sourcemap: "inline",
    packages: "bundle",
    external: [],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    plugins: [makeElectrobunBunAliasPlugin(sdkBunModule)],
    naming: {
      entry: "worker.js",
    },
  });
  assertBuildSuccess(`${manifest.name} worker`, workerBuild);

  writeFileSync(
    join(resolvedOutDir, "carrot.json"),
    JSON.stringify(
      {
        ...manifest,
        view: {
          ...manifest.view,
          relativePath: "lens/index.html",
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

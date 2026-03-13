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

async function buildIvde(sourceDir: string, ivdeOutDir: string) {
  const require = createRequire(import.meta.url);
  const esbuild = require("esbuild");
  const MonacoEsbuildPlugin = require("esbuild-monaco-editor-plugin");
  const { solidPlugin } = require("esbuild-plugin-solid");

  const entry = join(sourceDir, "renderers", "ivde", "index.tsx");
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
    outfile: join(ivdeOutDir, "index.js"),
    bundle: true,
    plugins: [
      makeElectrobunViewAliasPlugin(sourceDir),
      MonacoEsbuildPlugin({
        destDir: ivdeOutDir,
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

function buildTailwind(sourceDir: string, ivdeOutDir: string) {
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
      join(sourceDir, "renderers", "ivde", "**", "*.tsx"),
      "-c",
      join(sourceDir, "renderers", "tailwind.config.js"),
      "-i",
      join(sourceDir, "renderers", "ivde", "index.css"),
      "-o",
      join(ivdeOutDir, "tailwind.css"),
    ],
    {
      cwd: sourceDir,
      stdio: "pipe",
    },
  );
}

function prepareHtmlAndAssets(sourceDir: string, resolvedOutDir: string) {
  const ivdeOutDir = join(resolvedOutDir, "ivde");
  const bunnyOutDir = join(resolvedOutDir, "bunny");
  const assetsOutDir = join(resolvedOutDir, "assets");

  mkdirSync(ivdeOutDir, { recursive: true });
  mkdirSync(bunnyOutDir, { recursive: true });
  mkdirSync(assetsOutDir, { recursive: true });

  cpSync(join(sourceDir, "renderers", "ivde", "index.html"), join(ivdeOutDir, "index.html"));
  cpSync(join(sourceDir, "renderers", "ivde", "styles"), join(ivdeOutDir, "styles"), {
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
    join(ivdeOutDir, "xterm.css"),
    {
      force: true,
    },
  );
  cpSync(
    join(sourceDir, "assets", "custom.editor.worker.js"),
    join(ivdeOutDir, "custom.editor.worker.js"),
    {
      force: true,
    },
  );

  const ivdeHtmlPath = join(ivdeOutDir, "index.html");
  const ivdeHtml = readFileSync(ivdeHtmlPath, "utf8");
  const dashWindowCssHref = "views://ivde/bunny-dash-window.css";
  let patchedIvdeHtml = ivdeHtml;
  if (!patchedIvdeHtml.includes(dashWindowCssHref)) {
    patchedIvdeHtml = patchedIvdeHtml.replace(
      '<link rel="stylesheet" href="views://ivde/index.css" />',
      '<link rel="stylesheet" href="views://ivde/index.css" />\n    <link rel="stylesheet" href="views://ivde/bunny-dash-window.css" />',
    );
  }
  writeFileSync(ivdeHtmlPath, patchedIvdeHtml);
  writeFileSync(join(ivdeOutDir, "bunny-dash-window.css"), makeDashWindowCss());
}

function buildPtyBinary(sourceDir: string, resolvedOutDir: string) {
  const zigBinary = join(
    sourceDir,
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

  execFileSync(zigBinary, ["build"], {
    cwd: join(sourceDir, "pty"),
    stdio: "pipe",
  });

  const builtPtyBinary = join(
    sourceDir,
    "pty",
    "zig-out",
    "bin",
    process.platform === "win32" ? "colab-pty.exe" : "colab-pty",
  );

  if (!existsSync(builtPtyBinary)) {
    throw new Error(`Failed to build colab-pty at ${builtPtyBinary}`);
  }

  cpSync(
    builtPtyBinary,
    join(resolvedOutDir, process.platform === "win32" ? "colab-pty.exe" : "colab-pty"),
    { force: true },
  );
}

export async function buildCarrot({ sourceDir, outDir, manifest }: BuildContext) {
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
    buildTailwind(sourceDir, join(resolvedOutDir, "ivde"));
    await buildIvde(sourceDir, join(resolvedOutDir, "ivde"));
    await buildBunny(sourceDir, join(resolvedOutDir, "bunny"));
    buildPtyBinary(sourceDir, resolvedOutDir);
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
          relativePath: "ivde/index.html",
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

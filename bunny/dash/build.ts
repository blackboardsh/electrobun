import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type BuildContext = {
  sourceDir: string;
  outDir: string;
  manifest: any;
  sdkViewModule: string;
  defaultBuild: () => Promise<void>;
};

function resolveBuiltColabViews(sourceDir: string) {
  const colabBuildRoot = resolve(sourceDir, "../../../colab/build");
  if (!existsSync(colabBuildRoot)) {
    throw new Error(`Missing Colab build output at ${colabBuildRoot}`);
  }

  const buildTargets = readdirSync(colabBuildRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(colabBuildRoot, entry.name))
    .sort()
    .reverse();

  for (const buildTarget of buildTargets) {
    const appCandidates = readdirSync(buildTarget, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
      .map((entry) => {
        const appContentsDir = join(buildTarget, entry.name, "Contents");
        return {
          appContentsDir,
          viewsDir: join(appContentsDir, "Resources", "app", "views"),
          macosDir: join(appContentsDir, "MacOS"),
        };
      });

    for (const candidate of appCandidates) {
      const { appContentsDir, viewsDir, macosDir } = candidate;
      const ivdeDir = join(viewsDir, "ivde");
      const bunnyDir = join(viewsDir, "bunny");
      const assetsDir = join(viewsDir, "assets");
      const ptyBinaryPath = join(macosDir, process.platform === "win32" ? "colab-pty.exe" : "colab-pty");
      if (existsSync(join(ivdeDir, "index.js")) && existsSync(join(bunnyDir, "index.js")) && existsSync(assetsDir)) {
        return { appContentsDir, viewsDir, ivdeDir, bunnyDir, assetsDir, ptyBinaryPath };
      }
    }
  }

  throw new Error(
    `No built Colab app views were found under ${colabBuildRoot}. Run 'bun build:dev' in /Users/yoav/.colab-canary/projects/code/colab first.`,
  );
}

export async function buildCarrot({ sourceDir, outDir, manifest }: BuildContext) {
  const resolvedOutDir = resolve(outDir);
  const { ivdeDir, bunnyDir, assetsDir, ptyBinaryPath } = resolveBuiltColabViews(sourceDir);
  const workerEntry = existsSync(join(sourceDir, "worker.ts"))
    ? join(sourceDir, "worker.ts")
    : join(sourceDir, "worker.js");

  rmSync(resolvedOutDir, { recursive: true, force: true });
  mkdirSync(resolvedOutDir, { recursive: true });

  cpSync(ivdeDir, join(resolvedOutDir, "ivde"), { recursive: true });
  cpSync(bunnyDir, join(resolvedOutDir, "bunny"), { recursive: true });
  cpSync(assetsDir, join(resolvedOutDir, "assets"), { recursive: true });

  const copiedIvdeDir = join(resolvedOutDir, "ivde");
  const ivdeHtmlPath = join(copiedIvdeDir, "index.html");
  const dashWindowCssPath = join(copiedIvdeDir, "bunny-dash-window.css");
  const ivdeHtml = readFileSync(ivdeHtmlPath, "utf8");
  const dashWindowCssHref = "views://ivde/bunny-dash-window.css";
  const patchedIvdeHtml = ivdeHtml.includes(dashWindowCssHref)
    ? ivdeHtml
    : ivdeHtml.replace(
        '<link rel="stylesheet" href="views://ivde/index.css" />',
        '<link rel="stylesheet" href="views://ivde/index.css" />\n    <link rel="stylesheet" href="views://ivde/bunny-dash-window.css" />',
      );
  writeFileSync(ivdeHtmlPath, patchedIvdeHtml);
  writeFileSync(
    dashWindowCssPath,
    `html,
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
}
`,
  );

  if (existsSync(ptyBinaryPath)) {
    cpSync(ptyBinaryPath, join(resolvedOutDir, process.platform === "win32" ? "colab-pty.exe" : "colab-pty"));
  }

  const buildResult = await Bun.build({
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

  if (!buildResult.success) {
    const details = buildResult.logs
      .map((log) => log.message || log.name || JSON.stringify(log))
      .join("\n");
    throw new Error(`Failed to build Bunny Dash worker${details ? `\n${details}` : ""}`);
  }

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

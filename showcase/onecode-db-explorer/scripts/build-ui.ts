import { cpSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { plugin } from "bun";
import solidTransformPlugin from "./solid-plugin";

const args = new Set(process.argv.slice(2));
const minify = args.has("--minify");
const textDecoder = new TextDecoder();

const projectRoot = process.cwd();
const distDir = join(projectRoot, "dist");

plugin(solidTransformPlugin);
const solidCompilerLabel = "babel (temporary)";

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

cpSync(join(projectRoot, "src/mainview/index.html"), join(distDir, "index.html"));
cpSync(join(projectRoot, "src/mainview/index.css"), join(distDir, "index.css"));

const tailwindProc = Bun.spawnSync(
  [
    "bunx",
    "tailwindcss",
    "-c",
    join(projectRoot, "tailwind.config.js"),
    "-i",
    join(projectRoot, "src/mainview/tailwind.css"),
    "-o",
    join(distDir, "tailwind.css"),
    ...(minify ? ["--minify"] : []),
  ],
  {
    stdout: "pipe",
    stderr: "pipe",
  }
);

if (tailwindProc.exitCode !== 0) {
  console.error("Tailwind build failed:");
  const stderr = textDecoder.decode(tailwindProc.stderr).trim();
  const stdout = textDecoder.decode(tailwindProc.stdout).trim();
  if (stderr) console.error(stderr);
  if (stdout) console.error(stdout);
  process.exit(tailwindProc.exitCode);
}

function copyFirstExisting(candidates: string[], destination: string) {
  let lastError: unknown = undefined;
  for (const candidate of candidates) {
    try {
      cpSync(candidate, destination);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Failed to copy required asset to ${destination}. Tried:\n${candidates
      .map((c) => `- ${c}`)
      .join("\n")}\n\nLast error: ${String(lastError)}`
  );
}

// Copy AG Grid styles into dist/ so index.html can link them directly.
// Keep this resilient across AG Grid theme/file changes by trying a few candidates.
copyFirstExisting([join(projectRoot, "node_modules/ag-grid-community/styles/ag-grid.css")], join(distDir, "ag-grid.css"));
copyFirstExisting(
  [
    join(projectRoot, "node_modules/ag-grid-community/styles/ag-theme-quartz.css"),
    join(projectRoot, "node_modules/ag-grid-community/styles/ag-theme-quartz-dark.css"),
    join(projectRoot, "node_modules/ag-grid-community/styles/ag-theme-alpine-dark.css"),
    join(projectRoot, "node_modules/ag-grid-community/styles/ag-theme-balham-dark.css"),
    join(projectRoot, "node_modules/ag-grid-community/styles/ag-theme-alpine.css"),
    join(projectRoot, "node_modules/ag-grid-community/styles/ag-theme-balham.css"),
  ],
  join(distDir, "ag-theme.css")
);

const buildResult = await Bun.build({
  entrypoints: [join(projectRoot, "src/mainview/main.tsx")],
  outdir: distDir,
  target: "browser",
  splitting: false,
  minify,
  sourcemap: "external",
  tsconfig: "./tsconfig.ui.json",
  plugins: [solidTransformPlugin],
  define: {
    __SOLID_COMPILER__: JSON.stringify(solidCompilerLabel),
  },
});

if (!buildResult.success) {
  console.error("UI build failed:");
  for (const log of buildResult.logs) console.error(log);
  process.exit(1);
}

console.log(`UI build complete: ${distDir}`);

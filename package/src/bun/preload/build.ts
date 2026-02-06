// Standalone build script for the preload.
// Normally this is run as part of "bun build.ts", but you can run this directly:
//   bun src/bun/preload/build.ts

import { join, dirname } from "path";
import { writeFileSync, mkdirSync } from "fs";

async function buildPreload() {
	const preloadDir = dirname(import.meta.path);
	const outputDir = join(preloadDir, ".generated");
	const outputPath = join(outputDir, "compiled.ts");

	mkdirSync(outputDir, { recursive: true });

	// Build full preload (trusted webviews)
	const fullPreloadEntry = join(preloadDir, "index.ts");
	const fullResult = await Bun.build({
		entrypoints: [fullPreloadEntry],
		target: "browser",
		format: "iife", // IIFE format for script injection (no export statements)
		minify: false,
	});

	if (!fullResult.success) {
		console.error("Full preload build failed:", fullResult.logs);
		throw new Error("Failed to build full preload script");
	}

	// Build sandboxed preload (untrusted webviews)
	const sandboxedPreloadEntry = join(preloadDir, "index-sandboxed.ts");
	const sandboxedResult = await Bun.build({
		entrypoints: [sandboxedPreloadEntry],
		target: "browser",
		format: "iife",
		minify: false,
	});

	if (!sandboxedResult.success) {
		console.error("Sandboxed preload build failed:", sandboxedResult.logs);
		throw new Error("Failed to build sandboxed preload script");
	}

	const fullPreloadJs = await fullResult.outputs[0]!.text();
	const sandboxedPreloadJs = await sandboxedResult.outputs[0]!.text();

	const outputContent = `// Auto-generated file. Do not edit directly.
// Run "bun build.ts" or "bun build:dev" from the package folder to regenerate.

// Full preload for trusted webviews (RPC, encryption, drag regions, webview tags)
export const preloadScript = ${JSON.stringify(fullPreloadJs)};

// Minimal preload for sandboxed/untrusted webviews (lifecycle events only, no RPC)
export const preloadScriptSandboxed = ${JSON.stringify(sandboxedPreloadJs)};
`;

	writeFileSync(outputPath, outputContent);
	console.log(`Preload scripts compiled to ${outputPath} (full + sandboxed)`);
}

buildPreload().catch((err) => {
	console.error("Failed to build preload:", err);
	process.exit(1);
});

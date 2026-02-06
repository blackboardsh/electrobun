// Standalone build script for the preload.
// Normally this is run as part of "bun build.ts", but you can run this directly:
//   bun src/bun/preload/build.ts

import { join, dirname } from "path";
import { writeFileSync, mkdirSync } from "fs";

async function buildPreload() {
	const preloadEntry = join(dirname(import.meta.path), "index.ts");
	const outputDir = join(dirname(import.meta.path), ".generated");
	const outputPath = join(outputDir, "compiled.ts");

	mkdirSync(outputDir, { recursive: true });

	const result = await Bun.build({
		entrypoints: [preloadEntry],
		target: "browser",
		format: "iife", // IIFE format for script injection (no export statements)
		minify: false,
	});

	if (!result.success) {
		console.error("Preload build failed:", result.logs);
		throw new Error("Failed to build preload script");
	}

	const compiledJs = await result.outputs[0].text();

	const outputContent = `// Auto-generated file. Do not edit directly.
// Run "bun build.ts" or "bun build:dev" from the package folder to regenerate.

export const preloadScript = ${JSON.stringify(compiledJs)};
`;

	writeFileSync(outputPath, outputContent);
	console.log(`Preload script compiled to ${outputPath}`);
}

buildPreload().catch((err) => {
	console.error("Failed to build preload:", err);
	process.exit(1);
});

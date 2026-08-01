import { describe, expect, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

type PackageManifest = {
	exports: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
	readFileSync(join(packageDir, "package.json"), "utf8"),
) as PackageManifest;

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
	return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
		getCanonicalFileName: (fileName) => fileName,
		getCurrentDirectory: () => packageDir,
		getNewLine: () => "\n",
	});
}

describe("published package dependency contract", () => {
	test("ships Three.js declarations as a production dependency", () => {
		expect(manifest.dependencies?.["three"]).toBe("^0.165.0");
		expect(manifest.dependencies?.["@types/three"]).toBe("^0.165.0");
		expect(manifest.devDependencies?.["@types/three"]).toBeUndefined();
	});

	test("a strict consumer can resolve the published Three.js export", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "electrobun-package-contract-"));

		try {
			const installedPackage = join(tempDir, "node_modules", "electrobun");
			const publishedApi = join(installedPackage, "dist", "api");
			mkdirSync(publishedApi, { recursive: true });
			writeFileSync(
				join(installedPackage, "package.json"),
				JSON.stringify(manifest),
			);

			for (const directory of ["browser", "config", "preload", "shared"]) {
				cpSync(join(packageDir, "src", directory), join(publishedApi, directory), {
					recursive: true,
				});
			}
			const generatedPreloadDir = join(publishedApi, "preload", ".generated");
			mkdirSync(generatedPreloadDir, { recursive: true });
			writeFileSync(
				join(generatedPreloadDir, "compiled.ts"),
				'export const preloadScript = "";\nexport const preloadScriptSandboxed = "";\n',
			);
			cpSync(
				join(packageDir, "src", "sdks", "bun"),
				join(publishedApi, "sdks", "bun"),
				{ recursive: true },
			);

			// npm may hoist these packages, but resolving them from Electrobun's own
			// node_modules is also valid and keeps this regression test offline.
			symlinkSync(
				join(packageDir, "node_modules"),
				join(installedPackage, "node_modules"),
				process.platform === "win32" ? "junction" : "dir",
			);

			const consumerPath = join(tempDir, "consumer.ts");
			writeFileSync(
				consumerPath,
				[
					'import { three } from "electrobun";',
					"const scene: three.Scene = new three.Scene();",
					"scene.add(new three.Object3D());",
				].join("\n"),
			);

			const program = ts.createProgram([consumerPath], {
				allowImportingTsExtensions: true,
				allowJs: true,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				noEmit: true,
				resolveJsonModule: true,
				// Electrobun ships TypeScript, so missing declarations in its source
				// remain visible even when consumers skip dependency declaration checks.
				skipLibCheck: true,
				strict: true,
				target: ts.ScriptTarget.ESNext,
			});
			const diagnostics = ts.getPreEmitDiagnostics(program);

			expect(formatDiagnostics(diagnostics)).toBe("");
			expect(manifest.exports["."]).toBe("./dist/api/sdks/bun/index.ts");
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});
});

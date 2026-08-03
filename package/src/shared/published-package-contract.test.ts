import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

type PackageManifest = {
	exports: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
	readFileSync(join(packageDir, "package.json"), "utf8"),
) as PackageManifest;

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
				join(packageDir, "src", "sdks", "main"),
				join(publishedApi, "sdks", "main"),
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
					'import { three, type ElectrobunConfig } from "electrobun";',
					'import type { BrowserWindow as MainBrowserWindow } from "electrobun/main";',
					'import type { BrowserWindow as LegacyBrowserWindow } from "electrobun/bun";',
					"declare const mainWindow: MainBrowserWindow;",
					"const legacyWindow: LegacyBrowserWindow = mainWindow;",
					"void legacyWindow;",
					"const scene: three.Scene = new three.Scene();",
					"scene.add(new three.Object3D());",
					"const config = {",
					'  app: { name: "Flatpak app", identifier: "dev.electrobun.flatpak", version: "1.0.0" },',
					"  build: { linux: { flatpak: {",
					"    enabled: true,",
					'    outputPath: "flatpak",',
					'    runtime: "org.freedesktop.Platform",',
					'    runtimeVersion: "25.08",',
					'    sdk: "org.freedesktop.Sdk",',
					'    finishArgs: ["--share=network"],',
					"  } } },",
					"} satisfies ElectrobunConfig;",
					"void config;",
				].join("\n"),
			);

			// Run the same compiler that consumers invoke, in a separate Node process.
			// Keeping the compiler outside the test runtime also avoids coupling this
			// package-contract check to a particular main-process JavaScript engine.
			const result = spawnSync(
				"node",
				[
					join(packageDir, "node_modules", "typescript", "bin", "tsc"),
					"--allowImportingTsExtensions",
					"--allowJs",
					"--module",
					"ESNext",
					"--moduleResolution",
					"Bundler",
					"--noEmit",
					"--resolveJsonModule",
					// Electrobun ships TypeScript, so missing declarations in its source
					// remain visible even when consumers skip dependency declaration checks.
					"--skipLibCheck",
					"--strict",
					"--target",
					"ESNext",
					"--types",
					"bun",
					consumerPath,
				],
				{ cwd: packageDir, encoding: "utf8" },
			);

			if (result.error) throw result.error;
			expect([result.status, result.stdout, result.stderr]).toEqual([0, "", ""]);
			expect(manifest.exports["."]).toBe("./dist/api/sdks/main/index.ts");
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});
});

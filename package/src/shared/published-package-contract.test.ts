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
	private: boolean;
	bin?: unknown;
	exports: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(
	readFileSync(join(packageDir, "package.json"), "utf8"),
) as PackageManifest;
const lockfile = JSON.parse(
	readFileSync(join(packageDir, "package-lock.json"), "utf8"),
) as {
	packages: Record<
		string,
		{
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		}
	>;
};
const hutchConfigSource = readFileSync(
	join(packageDir, "hutch.config.ts"),
	"utf8",
);

function linkPackage(source: string, destination: string) {
	mkdirSync(dirname(destination), { recursive: true });
	symlinkSync(
		source,
		destination,
		process.platform === "win32" ? "junction" : "dir",
	);
}

describe("published package SDK contract", () => {
	test("keeps project installation explicit and the product package toolchain-only", () => {
		expect(hutchConfigSource).toMatch(
		/\binstall:\s*\[\s*"npm"\s*,\s*"ci"\s*\]/,
		);
		expect(manifest.private).toBe(true);
		expect(manifest.bin).toBeUndefined();
		expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
			"@types/bun",
			"png-to-ico",
			"proxy-agent",
			"rcedit",
		]);
		expect(Object.keys(manifest.devDependencies ?? {})).toEqual(["typescript"]);

		const lockRoot = lockfile.packages[""];
		expect(lockRoot?.dependencies).toEqual(manifest.dependencies);
		expect(lockRoot?.devDependencies).toEqual(manifest.devDependencies);
		for (const packageName of ["@babylonjs/core", "@types/three", "three"]) {
			expect(manifest.dependencies?.[packageName]).toBeUndefined();
			expect(lockfile.packages[`node_modules/${packageName}`]).toBeUndefined();
		}
	});

	test("a strict consumer cannot import graphics libraries through Electrobun", () => {
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

			// Electrobun's published TypeScript references Bun's declarations. Stage
			// only those declarations so an accidental graphics import cannot resolve.
			linkPackage(
				join(packageDir, "node_modules", "@types", "bun"),
				join(tempDir, "node_modules", "@types", "bun"),
			);

			const consumerPath = join(tempDir, "consumer.ts");
			writeFileSync(
				consumerPath,
				[
					'import Electrobun, { type ElectrobunConfig } from "electrobun";',
					'// @ts-expect-error Three.js is not part of the Electrobun SDK.',
					'import { three as electrobunThree } from "electrobun";',
					'// @ts-expect-error Babylon.js is not part of the Electrobun SDK.',
					'import { babylon as electrobunBabylon } from "electrobun";',
					'void electrobunThree;',
					'void electrobunBabylon;',
					'// @ts-expect-error Three.js is not part of the default SDK object.',
					'void Electrobun.three;',
					'// @ts-expect-error Babylon.js is not part of the default SDK object.',
					'void Electrobun.babylon;',
					'import type { BrowserWindow as MainBrowserWindow } from "electrobun/main";',
					'import type { BrowserWindow as LegacyBrowserWindow } from "electrobun/bun";',
					"declare const mainWindow: MainBrowserWindow;",
					"const legacyWindow: LegacyBrowserWindow = mainWindow;",
					"void legacyWindow;",
					"const config = {",
					'  electrobun: { version: "2.0.0-beta.1" },',
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

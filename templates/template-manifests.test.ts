import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type TemplateManifest = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	scripts?: unknown;
};

type PackageLock = {
	lockfileVersion?: number;
	packages?: Record<
		string,
		{
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		}
	>;
};

const templatesRoot = import.meta.dirname;
const odinWgpuTemplates = [
	"odin-alchemy-wgpu",
	"odin-fluid-wgpu",
	"odin-jelly-bunny-wgpu",
	"odin-particles-wgpu",
	"odin-tree-wgpu",
] as const;
const packageFreeNativeTemplates = [
	"go-maze-wgpu",
	...odinWgpuTemplates,
	"rust-flock-wgpu",
	"zig-wgpu",
] as const;
const templateNames = readdirSync(templatesRoot, { withFileTypes: true })
	.filter(
		(entry) =>
			entry.isDirectory() &&
			existsSync(join(templatesRoot, entry.name, "electrobun.config.ts")),
	)
	.map((entry) => entry.name)
	.sort();

function readManifest(templateName: string): TemplateManifest | undefined {
	const path = join(templatesRoot, templateName, "package.json");
	if (!existsSync(path)) return undefined;
	return JSON.parse(
		readFileSync(path, "utf8"),
	) as TemplateManifest;
}

function pragmaPins(source: string): string {
	return source.match(/^\/\/\s*@hutch\s+([^\r\n]+)$/m)?.[1] ?? "";
}

function collectTemplateTextFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (["build", "dist", "node_modules", "vendors"].includes(entry.name)) {
			continue;
		}
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectTemplateTextFiles(path));
		} else if (/\.(?:[cm]?[jt]sx?|md|txt)$/.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

describe("Electrobun template package boundaries", () => {
	test("npm manifests and locks contain only application dependencies", () => {
		const invalidManifests: string[] = [];
		const packageFreeTemplates: string[] = [];

		for (const templateName of templateNames) {
			const templateRoot = join(templatesRoot, templateName);
			const manifest = readManifest(templateName);
			const lockPath = join(templateRoot, "package-lock.json");
			for (const obsoleteLock of [
				"bun.lock",
				"bun.lockb",
				"pnpm-lock.yaml",
				"yarn.lock",
			]) {
				if (existsSync(join(templateRoot, obsoleteLock))) {
					invalidManifests.push(`${templateName}: contains ${obsoleteLock}`);
				}
			}
			if (!manifest) {
				packageFreeTemplates.push(templateName);
				if (existsSync(lockPath)) {
					invalidManifests.push(
						`${templateName}: package-free template contains package-lock.json`,
					);
				}
				continue;
			}
			if (manifest.scripts !== undefined) {
				invalidManifests.push(`${templateName}: package.json contains scripts`);
			}
			for (const field of [
				"dependencies",
				"devDependencies",
				"optionalDependencies",
			] as const) {
				if (manifest[field]?.electrobun !== undefined) {
					invalidManifests.push(
						`${templateName}: package.json ${field} contains electrobun`,
					);
				}
			}

			if (!existsSync(lockPath)) {
				invalidManifests.push(`${templateName}: missing package-lock.json`);
				continue;
			}
			const lock = JSON.parse(readFileSync(lockPath, "utf8")) as PackageLock;
			if (lock.lockfileVersion !== 3) {
				invalidManifests.push(
					`${templateName}: expected package-lock v3, received ${lock.lockfileVersion}`,
				);
			}
			const lockRoot = lock.packages?.[""];
			for (const field of [
				"dependencies",
				"devDependencies",
				"optionalDependencies",
			] as const) {
				if (JSON.stringify(lockRoot?.[field] ?? {}) !== JSON.stringify(manifest[field] ?? {})) {
					invalidManifests.push(
						`${templateName}: package-lock ${field} does not match package.json`,
					);
				}
			}

		}

		expect(invalidManifests).toEqual([]);
		expect(packageFreeTemplates).toEqual([...packageFreeNativeTemplates].sort());
	});

	test("Hutch owns template tasks and release metadata", () => {
		const invalidConfigs: string[] = [];
		const packageVersion = (
			JSON.parse(
				readFileSync(join(templatesRoot, "..", "package", "package.json"), "utf8"),
			) as { version: string }
		).version;
		const packagePins = pragmaPins(
			readFileSync(join(templatesRoot, "..", "package", "hutch.config.ts"), "utf8"),
		);

		for (const templateName of templateNames) {
			const templateRoot = join(templatesRoot, templateName);
			const hasManifest = existsSync(join(templateRoot, "package.json"));
			const hutchPath = join(templateRoot, "hutch.config.ts");
			const electrobunPath = join(templateRoot, "electrobun.config.ts");
			const tsconfigPath = join(templateRoot, "tsconfig.json");
			const gitignorePath = join(templateRoot, ".gitignore");
			if (!existsSync(hutchPath)) {
				invalidConfigs.push(`${templateName}: missing hutch.config.ts`);
				continue;
			}
			const hutch = readFileSync(hutchPath, "utf8");
			if (pragmaPins(hutch) !== packagePins) {
				invalidConfigs.push(`${templateName}: Hutch pins do not match package pins`);
			}
			const hasNpmInstall = /\binstall:\s*\["npm", "ci"\]/.test(hutch);
			if (hasNpmInstall !== hasManifest) {
				invalidConfigs.push(
					hasManifest
						? `${templateName}: install does not run npm ci`
						: `${templateName}: package-free template contains an install task`,
				);
			}

			const electrobun = readFileSync(electrobunPath, "utf8");
			const versions = [
				...electrobun.matchAll(
					/\belectrobun\s*:\s*\{\s*version\s*:\s*["']([^"']+)["']/g,
				),
			];
			if (versions.length !== 1 || versions[0]?.[1] !== packageVersion) {
				invalidConfigs.push(
					`${templateName}: electrobun.version must equal ${packageVersion}`,
				);
			}

			if (!existsSync(tsconfigPath)) {
				invalidConfigs.push(`${templateName}: missing tsconfig.json`);
			} else {
				const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
					extends?: string;
				};
				if (tsconfig.extends !== "./.hutch/devkit/tsconfig.json") {
					invalidConfigs.push(`${templateName}: tsconfig does not extend the devkit`);
				}
			}

			if (
				!existsSync(gitignorePath) ||
				!readFileSync(gitignorePath, "utf8").split(/\r?\n/).includes(".hutch/")
			) {
				invalidConfigs.push(`${templateName}: .hutch is not ignored`);
			}
		}

		expect(invalidConfigs).toEqual([]);
	});

	test("every template exposes a production build through hutch run build", () => {
		const invalidScripts: string[] = [];

		for (const templateName of templateNames) {
			const manifest = readManifest(templateName) ?? {};
			const hutch = readFileSync(
				join(templatesRoot, templateName, "hutch.config.ts"),
				"utf8",
			);
			const usesVite = Boolean(
				manifest.dependencies?.vite ?? manifest.devDependencies?.vite,
			);
			const expected = usesVite
				? 'build: "npm exec -- vite build && hutch electrobun build --env=production"'
				: 'build: ["hutch", "electrobun", "build", "--env=production"]';

			if (!hutch.includes(expected)) {
				invalidScripts.push(
					`${templateName}: hutch.config.ts is missing ${JSON.stringify(expected)}`,
				);
			}
		}

		expect(invalidScripts).toEqual([]);
	});

	test("template READMEs do not bypass the production build script", () => {
		const invalidDocs: string[] = [];

		for (const templateName of templateNames) {
			const readmePath = join(templatesRoot, templateName, "README.md");
			if (!existsSync(readmePath)) continue;

			const readme = readFileSync(readmePath, "utf8");
			if (readme.includes("bun run build")) {
				invalidDocs.push(`${templateName}: uses bun run build`);
			}
			if (/\bbun (?:install|start)\b/.test(readme)) {
				invalidDocs.push(`${templateName}: invokes Bun as a package manager`);
			}
			if (readme.includes("hutch install")) {
				invalidDocs.push(`${templateName}: bypasses the explicit install script`);
			}
			if (readme.includes("installs dependencies on the first run")) {
				invalidDocs.push(`${templateName}: promises implicit dependency installation`);
			}
			if (readme.includes("hutch electrobun build --env=stable")) {
				invalidDocs.push(`${templateName}: uses the non-canonical stable alias`);
			}
		}

		expect(invalidDocs).toEqual([]);
	});

	test("TypeScript templates use the runtime-neutral main SDK namespace", () => {
		const legacyImports: string[] = [];

		for (const templateName of templateNames) {
			const templateRoot = join(templatesRoot, templateName);
			for (const file of collectTemplateTextFiles(templateRoot)) {
				if (readFileSync(file, "utf8").includes("electrobun/bun")) {
					legacyImports.push(file.slice(templatesRoot.length + 1));
				}
			}
		}

		expect(legacyImports).toEqual([]);
	});

	test("graphics showcases own their third-party JavaScript libraries", () => {
		const babylonManifest = readManifest("wgpu-babylon");
		const threeManifest = readManifest("wgpu-threejs");
		const babylonSource = readFileSync(
			join(templatesRoot, "wgpu-babylon", "src", "bun", "index.ts"),
			"utf8",
		);
		const threeSource = readFileSync(
			join(templatesRoot, "wgpu-threejs", "src", "bun", "index.ts"),
			"utf8",
		);

		expect(babylonManifest?.dependencies?.["@babylonjs/core"]).toBe(
			"^7.45.0",
		);
		expect(babylonSource).toContain(
			'import * as babylon from "@babylonjs/core";',
		);
		expect(threeManifest?.dependencies?.three).toBe("^0.165.0");
		expect(threeManifest?.devDependencies?.["@types/three"]).toBe(
			"^0.165.0",
		);
		expect(threeSource).toContain('import * as three from "three";');
	});

	test("Odin WGPU showcases keep the native cross-platform template contract", () => {
		const invalidTemplates: string[] = [];

		for (const templateName of odinWgpuTemplates) {
			const templateRoot = join(templatesRoot, templateName);
			const configPath = join(templateRoot, "electrobun.config.ts");
			const requiredFiles = [
				"README.md",
				"hutch.config.ts",
				"src/mainview/index.css",
				"src/mainview/index.html",
				"src/mainview/index.ts",
				"src/odin/main.odin",
				"tsconfig.json",
			];

			for (const file of requiredFiles) {
				if (!existsSync(join(templateRoot, file))) {
					invalidTemplates.push(`${templateName}: missing ${file}`);
				}
			}
			if (!existsSync(configPath)) continue;

			const config = readFileSync(configPath, "utf8");
			if (!/mainProcess:\s*["']odin["']/.test(config)) {
				invalidTemplates.push(`${templateName}: mainProcess is not odin`);
			}
			if ((config.match(/bundleWGPU:\s*true/g) ?? []).length !== 3) {
				invalidTemplates.push(
					`${templateName}: WGPU must be bundled for macOS, Linux, and Windows`,
				);
			}
			if ((config.match(/bundleCEF:\s*false/g) ?? []).length !== 3) {
				invalidTemplates.push(
					`${templateName}: system webviews must be used on every platform`,
				);
			}

			const tsconfig = JSON.parse(
				readFileSync(join(templateRoot, "tsconfig.json"), "utf8"),
			) as { compilerOptions?: { target?: string } };
			if (tsconfig.compilerOptions?.target !== "ES2021") {
				invalidTemplates.push(
					`${templateName}: TypeScript target must be ES2021`,
				);
			}
		}

		expect(invalidTemplates).toEqual([]);
	});

	test("interactive Odin surfaces pass pointer input through native WGPU views", () => {
		const expectedMasks = new Map([
			[
				"odin-alchemy-wgpu",
				[".topbar", ".material-dock", ".settings", ".stats"],
			],
			["odin-fluid-wgpu", [".topbar", ".control-dock"]],
		]);
		const invalidTemplates: string[] = [];

		for (const [templateName, masks] of expectedMasks) {
			const html = readFileSync(
				join(templatesRoot, templateName, "src", "mainview", "index.html"),
				"utf8",
			);
			const surface = html.match(/<electrobun-wgpu\b[^>]*>/s)?.[0] ?? "";
			if (!/\bpassthrough\b/.test(surface)) {
				invalidTemplates.push(`${templateName}: missing WGPU pointer passthrough`);
			}
			for (const mask of masks) {
				if (!surface.includes(mask)) {
					invalidTemplates.push(`${templateName}: missing native mask ${mask}`);
				}
			}
		}

		expect(invalidTemplates).toEqual([]);
	});
});

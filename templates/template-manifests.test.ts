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

type BuiltInPackageManager = "npm" | "bun" | "pnpm" | "yarn";

const packageManagerLockfiles: Record<
	BuiltInPackageManager,
	readonly string[]
> = {
	npm: ["package-lock.json"],
	bun: ["bun.lock", "bun.lockb"],
	pnpm: ["pnpm-lock.yaml"],
	yarn: ["yarn.lock"],
};
const knownPackageManagerLockfiles = [
	...new Set(Object.values(packageManagerLockfiles).flat()),
];

const templatesRoot = import.meta.dirname;
const odinWgpuTemplates = [
	"odin-alchemy-wgpu",
	"odin-fluid-wgpu",
	"odin-jelly-bunny-wgpu",
	"odin-particles-wgpu",
	"odin-tree-wgpu",
] as const;
const expectedPackageFreeTemplates = [
	"all",
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

function configuredPackageManager(source: string): string | undefined {
	const selection = source.match(
		/\bpackageManager\s*:\s*(?:["']([^"']+)["']|\{[\s\S]*?\bname\s*:\s*["']([^"']+)["'])/,
	);
	return selection?.[1] ?? selection?.[2];
}

function isBuiltInPackageManager(
	name: string,
): name is BuiltInPackageManager {
	return Object.hasOwn(packageManagerLockfiles, name);
}

function lockfileSelectionIssues(
	manager: BuiltInPackageManager,
	existingLockfiles: readonly string[],
): string[] {
	const ownedLockfiles = packageManagerLockfiles[manager];
	const selectedLockfiles = existingLockfiles.filter((lockfile) =>
		ownedLockfiles.includes(lockfile),
	);
	const issues = existingLockfiles
		.filter((lockfile) => !ownedLockfiles.includes(lockfile))
		.map((lockfile) => `${lockfile} belongs to a different package manager`);

	if (selectedLockfiles.length === 0) {
		issues.push(`missing ${ownedLockfiles.join(" or ")}`);
	} else if (selectedLockfiles.length > 1) {
		issues.push(`contains multiple ${manager} lockfiles`);
	}
	return issues;
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
	test("package manifests and selected lockfiles contain only application dependencies", () => {
		const invalidManifests: string[] = [];
		const packageFreeTemplates: string[] = [];

		for (const templateName of templateNames) {
			const templateRoot = join(templatesRoot, templateName);
			const manifest = readManifest(templateName);
			const hutchPath = join(templateRoot, "hutch.config.ts");
			const hutch = existsSync(hutchPath) ? readFileSync(hutchPath, "utf8") : "";
			const selectedManager = configuredPackageManager(hutch);
			const existingLockfiles = knownPackageManagerLockfiles.filter((lockfile) =>
				existsSync(join(templateRoot, lockfile)),
			);
			if (!manifest) {
				packageFreeTemplates.push(templateName);
				if (selectedManager !== undefined) {
					invalidManifests.push(
						`${templateName}: package-free template selects ${selectedManager}`,
					);
				}
				for (const lockfile of existingLockfiles) {
					invalidManifests.push(
						`${templateName}: package-free template contains ${lockfile}`,
					);
				}
				continue;
			}
			if (selectedManager === undefined) {
				invalidManifests.push(
					`${templateName}: package-backed template does not select a package manager`,
				);
				continue;
			}
			if (!isBuiltInPackageManager(selectedManager)) {
				invalidManifests.push(
					`${templateName}: release template uses unsupported package manager ${selectedManager}`,
				);
				continue;
			}
			for (const issue of lockfileSelectionIssues(
				selectedManager,
				existingLockfiles,
			)) {
				invalidManifests.push(`${templateName}: ${issue}`);
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

			if (selectedManager !== "npm") {
				continue;
			}
			const lockPath = join(templateRoot, "package-lock.json");
			if (!existsSync(lockPath)) continue;
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
		expect(packageFreeTemplates).toEqual([...expectedPackageFreeTemplates].sort());
	});

	test("Bun is a first-class package-manager and lockfile selection", () => {
		expect(
			configuredPackageManager('export default { packageManager: "bun" };'),
		).toBe("bun");
		expect(lockfileSelectionIssues("bun", ["bun.lock"])).toEqual([]);
		expect(lockfileSelectionIssues("bun", ["bun.lockb"])).toEqual([]);
		expect(lockfileSelectionIssues("bun", ["package-lock.json"])).toEqual([
			"package-lock.json belongs to a different package manager",
			"missing bun.lock or bun.lockb",
		]);
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
			const selectedManager = configuredPackageManager(hutch);
			const hasInstallTask = /\binstall\s*:/.test(hutch);
			const hasDelegatedCi = /\binstall\s*:\s*\["hutch", "pm", "ci"\]/.test(
				hutch,
			);
			const hardcodedPackageManagerCommand =
				/\[\s*["'](?:npm|bun|pnpm|yarn)["']\s*,/.test(hutch) ||
				/:\s*["'](?:npm|bun|pnpm|yarn)\s+(?:ci|install|exec|x|run)\b/.test(
					hutch,
				);
			if (hasManifest) {
				if (selectedManager === undefined) {
					invalidConfigs.push(
						`${templateName}: package-backed template does not select a package manager`,
					);
				}
				if (!hasDelegatedCi) {
					invalidConfigs.push(
						`${templateName}: install does not delegate a frozen install through hutch pm ci`,
					);
				}
				if (hardcodedPackageManagerCommand) {
					invalidConfigs.push(
						`${templateName}: task hardcodes a package-manager executable`,
					);
				}
			} else {
				if (selectedManager !== undefined) {
					invalidConfigs.push(
						`${templateName}: package-free template selects ${selectedManager}`,
					);
				}
				if (hasInstallTask) {
					invalidConfigs.push(
						`${templateName}: package-free template contains an install task`,
					);
				}
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
				? 'build: "hutch pm exec -- vite build && hutch electrobun build --env=production"'
				: 'build: ["hutch", "electrobun", "build", "--env=production"]';

			if (!hutch.includes(expected)) {
				invalidScripts.push(
					`${templateName}: hutch.config.ts is missing ${JSON.stringify(expected)}`,
				);
			}
		}

		expect(invalidScripts).toEqual([]);
	});

	test("the Rust template owns its Cargo build and release profiles", () => {
		const cargo = readFileSync(
			join(templatesRoot, "rust-flock-wgpu", "Cargo.toml"),
			"utf8",
		);
		const config = readFileSync(
			join(templatesRoot, "rust-flock-wgpu", "electrobun.config.ts"),
			"utf8",
		);

		expect(cargo).toContain('[dependencies]\nelectrobun = { path = ".hutch/devkit/rust-sdk" }');
		expect(cargo).toContain("[profile.dev]\nopt-level = 2\ndebug = 0");
		expect(cargo).toContain('[profile.release]\nopt-level = "z"\nstrip = "symbols"');
		expect(config).toContain('manifest: "Cargo.toml"');
		expect(config).toContain('binary: "main"');
		const rustConfig = config.match(/\brust:\s*\{[\s\S]*?\n\t\t\},/)?.[0];
		expect(rustConfig).toBeDefined();
		expect(rustConfig).not.toContain("entrypoint:");
	});

	test("template READMEs do not bypass the production build script", () => {
		const invalidDocs: string[] = [];

		for (const templateName of templateNames) {
			const readmePath = join(templatesRoot, templateName, "README.md");
			if (!existsSync(readmePath)) continue;

			const readme = readFileSync(readmePath, "utf8");
			if (/\b(?:npm|bun|pnpm|yarn)\s+run\s+build\b/.test(readme)) {
				invalidDocs.push(`${templateName}: bypasses hutch run build`);
			}
			if (/\b(?:npm|bun|pnpm|yarn)\s+(?:ci|install|start)\b/.test(readme)) {
				invalidDocs.push(
					`${templateName}: bypasses the Hutch package-manager boundary`,
				);
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

	test("Zig WGPU owns its Zig 0.16 build graph", () => {
		const templateRoot = join(templatesRoot, "zig-wgpu");
		const buildPath = join(templateRoot, "build.zig");
		expect(existsSync(buildPath)).toBe(true);
		const build = readFileSync(buildPath, "utf8");
		for (const contract of [
			'"electrobun-sdk"',
			"standardTargetOptions",
			"standardOptimizeOption",
			'.name = "main"',
			"installArtifact",
		]) {
			expect(build).toContain(contract);
		}

		const config = readFileSync(
			join(templateRoot, "electrobun.config.ts"),
			"utf8",
		);
		expect(config).toMatch(/\bzig:\s*\{[\s\S]*?version:\s*"0\.16\.0"/);
		expect(config).not.toContain('entrypoint: "src/zig/main.zig"');
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

	test("Bunny keeps its native transparent webview onscreen on macOS", () => {
		const bunnyMain = readFileSync(
			join(templatesRoot, "bunny", "src", "bun", "index.ts"),
			"utf8",
		);

		expect(bunnyMain).toMatch(/\btransparent:\s*true\b/);
		expect(bunnyMain).not.toMatch(/\bpassthrough:\s*true\b/);
	});
});

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type TemplateManifest = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
};

const templatesRoot = import.meta.dirname;
const odinWgpuTemplates = [
	"odin-alchemy-wgpu",
	"odin-fluid-wgpu",
	"odin-jelly-bunny-wgpu",
	"odin-particles-wgpu",
	"odin-tree-wgpu",
] as const;
const templateNames = readdirSync(templatesRoot, { withFileTypes: true })
	.filter(
		(entry) =>
			entry.isDirectory() &&
			existsSync(join(templatesRoot, entry.name, "package.json")),
	)
	.map((entry) => entry.name)
	.sort();

function readManifest(templateName: string): TemplateManifest {
	return JSON.parse(
		readFileSync(join(templatesRoot, templateName, "package.json"), "utf8"),
	) as TemplateManifest;
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

describe("Electrobun template build scripts", () => {
	test("every template exposes a production build through hutch run build", () => {
		const invalidScripts: string[] = [];

		for (const templateName of templateNames) {
			const manifest = readManifest(templateName);
			const usesVite = Boolean(
				manifest.dependencies?.vite ?? manifest.devDependencies?.vite,
			);
			const expected = usesVite
				? "vite build && hutch electrobun build --env=production"
				: "hutch electrobun build --env=production";

			if (manifest.scripts?.build !== expected) {
				invalidScripts.push(
					`${templateName}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(manifest.scripts?.build)}`,
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

	test("Odin WGPU showcases keep the native cross-platform template contract", () => {
		const invalidTemplates: string[] = [];

		for (const templateName of odinWgpuTemplates) {
			const templateRoot = join(templatesRoot, templateName);
			const configPath = join(templateRoot, "electrobun.config.ts");
			const requiredFiles = [
				"README.md",
				"package.json",
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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

type PackageManifest = {
	exports: Record<string, string>;
};

type BundleGraph = {
	bytes: number;
	inputs: string[];
	modules: number;
};

const packageRoot = resolve(import.meta.dir, "../..");
const manifest = JSON.parse(
	readFileSync(join(packageRoot, "package.json"), "utf8"),
) as PackageManifest;
const tempRoot = mkdtempSync(join(tmpdir(), "electrobun-package-exports-"));
const consumerRoot = join(tempRoot, "consumer");
const stagedPackageRoot = join(consumerRoot, "node_modules", "electrobun");

const focusedImports = {
	"electrobun/bun/app-menu": "setApplicationMenu",
	"electrobun/bun/browser-view": "BrowserView",
	"electrobun/bun/browser-window": "BrowserWindow",
	"electrobun/bun/build-config": "BuildConfig",
	"electrobun/bun/context-menu": "showContextMenu",
	"electrobun/bun/events": "electrobunEventEmitter",
	"electrobun/bun/gpu-window": "GpuWindow",
	"electrobun/bun/native": "Screen",
	"electrobun/bun/paths": "RESOURCES_FOLDER",
	"electrobun/bun/rpc": "createRPC",
	"electrobun/bun/socket": "sendMessageToWebviewViaSocket",
	"electrobun/bun/tray": "Tray",
	"electrobun/bun/updater": "Updater",
	"electrobun/bun/utils": "openExternal",
	"electrobun/bun/webgpu": "webgpu",
	"electrobun/bun/wgpu-view": "WGPUView",
	"electrobun/rpc": "defineElectrobunRPC",
} as const;

function copyApiDirectory(sourcePath: string, destinationPath: string) {
	cpSync(join(packageRoot, "src", sourcePath), destinationPath, {
		force: true,
		recursive: true,
	});
}

beforeAll(() => {
	mkdirSync(join(stagedPackageRoot, "dist", "api"), { recursive: true });
	writeFileSync(
		join(stagedPackageRoot, "package.json"),
		JSON.stringify({
			name: "electrobun",
			type: "module",
			exports: manifest.exports,
		}),
	);

	copyApiDirectory("sdks/bun", join(stagedPackageRoot, "dist/api/sdks/bun"));
	copyApiDirectory("browser", join(stagedPackageRoot, "dist/api/browser"));
	copyApiDirectory("shared", join(stagedPackageRoot, "dist/api/shared"));
	copyApiDirectory("config", join(stagedPackageRoot, "dist/api/config"));
	copyApiDirectory("preload", join(stagedPackageRoot, "dist/api/preload"));

	const generatedPreload = join(
		stagedPackageRoot,
		"dist/api/preload/.generated/compiled.ts",
	);
	mkdirSync(dirname(generatedPreload), { recursive: true });
	writeFileSync(
		generatedPreload,
		'export const preloadScript = "";\nexport const preloadScriptSandboxed = "";\n',
	);
});

afterAll(() => {
	rmSync(tempRoot, { force: true, recursive: true });
});

async function bundleImport(
	name: string,
	specifier: string,
	exportName: string,
): Promise<BundleGraph> {
	const entrypoint = join(consumerRoot, `${name}.ts`);
	writeFileSync(
		entrypoint,
		`import { ${exportName} as selected } from ${JSON.stringify(specifier)};\nconsole.log(selected);\n`,
	);

	const result = await Bun.build({
		entrypoints: [entrypoint],
		external: ["three", "@babylonjs/core"],
		metafile: true,
		minify: true,
		target: "bun",
	});
	if (!result.success || !result.metafile) {
		throw new Error(result.logs.map((log) => log.message).join("\n"));
	}

	const inputs = Object.keys(result.metafile.inputs).map((input) =>
		relative(stagedPackageRoot, resolve(consumerRoot, input)).replaceAll("\\", "/"),
	);
	return {
		bytes: result.outputs.reduce((total, output) => total + output.size, 0),
		inputs,
		modules: inputs.length,
	};
}

function reportComparison(
	label: string,
	legacyRoot: BundleGraph,
	focused: BundleGraph,
) {
	if (process.env.ELECTROBUN_REPORT_PACKAGE_EXPORT_METRICS !== "1") return;
	console.info(
		`${label}: root ${legacyRoot.modules} modules/${legacyRoot.bytes} bytes; ` +
			`focused ${focused.modules} modules/${focused.bytes} bytes`,
	);
}

describe("published package exports", () => {
	test("preserves the existing root, bun, and view entry points", () => {
		expect(manifest.exports["."]).toBe("./dist/api/sdks/bun/index.ts");
		expect(manifest.exports["./bun"]).toBe("./dist/api/sdks/bun/index.ts");
		expect(manifest.exports["./view"]).toBe("./dist/api/browser/index.ts");
	});

	test("maps every focused entry to a published, re-export-only module", () => {
		for (const specifier of Object.keys(focusedImports)) {
			const exportKey = `.${specifier.slice("electrobun".length)}`;
			const target = manifest.exports[exportKey];
			expect(target).toMatch(/^\.\/dist\/api\/sdks\/bun\/entries\/.+\.ts$/);

			const sourcePath = join(
				packageRoot,
				target.replace("./dist/api/sdks/bun", "src/sdks/bun"),
			);
			const source = readFileSync(sourcePath, "utf8");
			expect(source).not.toMatch(/^\s*import\s/m);
			expect(source).not.toMatch(/^\s*(?:const|let|var|class|function)\s/m);
		}
	});

	test("all focused package imports resolve and bundle independently", async () => {
		for (const [index, [specifier, exportName]] of Object.entries(
			focusedImports,
		).entries()) {
			const graph = await bundleImport(`focused-${index}`, specifier, exportName);
			expect(graph.modules).toBeGreaterThan(1);
			expect(graph.inputs).not.toContain("dist/api/sdks/bun/index.ts");
		}
	});

	test("pure RPC entry excludes the native and main-process graph", async () => {
		const root = await bundleImport("root-rpc", "electrobun", "createRPC");
		const rpc = await bundleImport(
			"focused-rpc",
			"electrobun/bun/rpc",
			"createRPC",
		);

		expect(rpc.inputs).not.toContain("dist/api/sdks/bun/proc/native.ts");
		expect(rpc.inputs.some((input) => input.includes("/core/"))).toBe(false);
		expect(rpc.modules).toBeLessThan(root.modules);
		expect(rpc.bytes).toBeLessThan(root.bytes);
		reportComparison("createRPC", root, rpc);
	});

	test("focused main-process entries omit unrelated heavy API families", async () => {
		const root = await bundleImport("root-window", "electrobun", "BrowserWindow");
		const browserWindow = await bundleImport(
			"focused-window",
			"electrobun/bun/browser-window",
			"BrowserWindow",
		);
		const appMenu = await bundleImport(
			"focused-menu",
			"electrobun/bun/app-menu",
			"setApplicationMenu",
		);

		for (const graph of [browserWindow, appMenu]) {
			expect(graph.inputs).not.toContain("dist/api/sdks/bun/core/Updater.ts");
			expect(graph.inputs).not.toContain("dist/api/sdks/bun/webGPU.ts");
			expect(graph.inputs).not.toContain("dist/api/sdks/bun/webgpuAdapter.ts");
			expect(graph.modules).toBeLessThan(root.modules);
			expect(graph.bytes).toBeLessThan(root.bytes);
		}
		reportComparison("BrowserWindow", root, browserWindow);
		reportComparison("setApplicationMenu", root, appMenu);
	});
});

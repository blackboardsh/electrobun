import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

type DevkitFacadeManifest = {
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
) as DevkitFacadeManifest;
const tempRoot = realpathSync(
	mkdtempSync(join(tmpdir(), "electrobun-devkit-exports-")),
);
const consumerRoot = join(tempRoot, "consumer");
const stagedFacadeRoot = join(consumerRoot, "node_modules", "electrobun");

const focusedImports = {
	"electrobun/main/app-menu": "setApplicationMenu",
	"electrobun/main/browser-view": "BrowserView",
	"electrobun/main/browser-window": "BrowserWindow",
	"electrobun/main/build-config": "BuildConfig",
	"electrobun/main/context-menu": "showContextMenu",
	"electrobun/main/events": "electrobunEventEmitter",
	"electrobun/main/gpu-window": "GpuWindow",
	"electrobun/main/native": "Screen",
	"electrobun/main/paths": "RESOURCES_FOLDER",
	"electrobun/main/rpc": "createRPC",
	"electrobun/main/socket": "sendMessageToWebviewViaSocket",
	"electrobun/main/tray": "Tray",
	"electrobun/main/updater": "Updater",
	"electrobun/main/utils": "openExternal",
	"electrobun/main/webgpu": "webgpu",
	"electrobun/main/wgpu-view": "WGPUView",
	"electrobun/rpc": "defineElectrobunRPC",
} as const;

function copyApiDirectory(sourcePath: string, destinationPath: string) {
	cpSync(join(packageRoot, "src", sourcePath), destinationPath, {
		force: true,
		recursive: true,
	});
}

function resolveBundleInput(input: string) {
	for (const base of [packageRoot, consumerRoot]) {
		const candidate = resolve(base, input);
		if (existsSync(candidate)) return realpathSync(candidate);
	}
	throw new Error(`Could not resolve bundle input ${input}`);
}

beforeAll(() => {
	mkdirSync(join(stagedFacadeRoot, "dist", "api"), { recursive: true });
	writeFileSync(
		join(stagedFacadeRoot, "package.json"),
		JSON.stringify({
			name: "electrobun",
			type: "module",
			exports: manifest.exports,
		}),
	);

	copyApiDirectory("sdks/main", join(stagedFacadeRoot, "dist/api/sdks/main"));
	copyApiDirectory("browser", join(stagedFacadeRoot, "dist/api/browser"));
	copyApiDirectory("shared", join(stagedFacadeRoot, "dist/api/shared"));
	copyApiDirectory("config", join(stagedFacadeRoot, "dist/api/config"));
	copyApiDirectory("preload", join(stagedFacadeRoot, "dist/api/preload"));

	const generatedPreload = join(
		stagedFacadeRoot,
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
		metafile: true,
		minify: true,
		target: "bun",
	});
	if (!result.success || !result.metafile) {
		throw new Error(result.logs.map((log) => log.message).join("\n"));
	}

	const inputs = Object.keys(result.metafile.inputs).map((input) =>
		relative(stagedFacadeRoot, resolveBundleInput(input)).replaceAll("\\", "/"),
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
	if (process.env["ELECTROBUN_REPORT_DEVKIT_EXPORT_METRICS"] !== "1") return;
	console.info(
		`${label}: root ${legacyRoot.modules} modules/${legacyRoot.bytes} bytes; ` +
			`focused ${focused.modules} modules/${focused.bytes} bytes`,
	);
}

describe("private devkit SDK exports", () => {
	test("exposes the canonical main SDK and preserves legacy entry points", () => {
		expect(manifest.exports["."]).toBe("./dist/api/sdks/main/index.ts");
		expect(manifest.exports["./main"]).toBe("./dist/api/sdks/main/index.ts");
		expect(manifest.exports["./bun"]).toBe("./dist/api/sdks/main/index.ts");
		expect(manifest.exports["./view"]).toBe("./dist/api/browser/index.ts");
	});

	test("maps every deprecated bun subpath to its canonical main target", () => {
		for (const exportKey of Object.keys(manifest.exports)) {
			if (!exportKey.startsWith("./main/")) continue;
			const legacyKey = exportKey.replace("./main/", "./bun/");
			expect(manifest.exports[legacyKey]).toBe(manifest.exports[exportKey]);
		}
	});

	test("maps every focused entry to a devkit re-export-only module", () => {
		for (const specifier of Object.keys(focusedImports)) {
			const exportKey = `.${specifier.slice("electrobun".length)}`;
			const target = manifest.exports[exportKey];
			if (!target) throw new Error(`Missing devkit facade export ${exportKey}`);
			expect(target).toMatch(/^\.\/dist\/api\/sdks\/main\/entries\/.+\.ts$/);

			const sourcePath = join(
				packageRoot,
				target.replace("./dist/api/sdks/main", "src/sdks/main"),
			);
			const source = readFileSync(sourcePath, "utf8");
			expect(source).not.toMatch(/^\s*import\s/m);
			expect(source).not.toMatch(/^\s*(?:const|let|var|class|function)\s/m);
		}
	});

	test("all focused facade imports resolve and bundle independently", async () => {
		for (const [index, [specifier, exportName]] of Object.entries(
			focusedImports,
		).entries()) {
			const graph = await bundleImport(`focused-${index}`, specifier, exportName);
			expect(graph.modules).toBeGreaterThan(1);
			expect(graph.inputs).not.toContain("dist/api/sdks/main/index.ts");
		}
	});

	test("deprecated bun imports resolve through the canonical SDK", async () => {
		const root = await bundleImport(
			"legacy-bun-root",
			"electrobun/bun",
			"BrowserWindow",
		);
		const rpc = await bundleImport(
			"legacy-bun-rpc",
			"electrobun/bun/rpc",
			"createRPC",
		);

		expect(root.inputs).toContain("dist/api/sdks/main/index.ts");
		expect(rpc.inputs).not.toContain("dist/api/sdks/main/index.ts");
	});

	test("pure RPC entry excludes the native and main-process graph", async () => {
		const root = await bundleImport("root-rpc", "electrobun", "createRPC");
		const rpc = await bundleImport(
			"focused-rpc",
			"electrobun/main/rpc",
			"createRPC",
		);

		expect(rpc.inputs).not.toContain("dist/api/sdks/main/proc/native.ts");
		expect(rpc.inputs.some((input) => input.includes("/core/"))).toBe(false);
		expect(rpc.modules).toBeLessThan(root.modules);
		expect(rpc.bytes).toBeLessThan(root.bytes);
		reportComparison("createRPC", root, rpc);
	});

	test("focused main-process entries omit unrelated heavy API families", async () => {
		const root = await bundleImport("root-window", "electrobun", "BrowserWindow");
		const browserWindow = await bundleImport(
			"focused-window",
			"electrobun/main/browser-window",
			"BrowserWindow",
		);
		const appMenu = await bundleImport(
			"focused-menu",
			"electrobun/main/app-menu",
			"setApplicationMenu",
		);

		for (const graph of [browserWindow, appMenu]) {
			expect(graph.inputs).not.toContain("dist/api/sdks/main/core/Updater.ts");
			expect(graph.inputs).not.toContain("dist/api/sdks/main/webGPU.ts");
			expect(graph.inputs).not.toContain("dist/api/sdks/main/webgpuAdapter.ts");
			expect(graph.modules).toBeLessThan(root.modules);
			expect(graph.bytes).toBeLessThan(root.bytes);
		}
		reportComparison("BrowserWindow", root, browserWindow);
		reportComparison("setApplicationMenu", root, appMenu);
	});
});

import { GO_VERSION } from "./go-version";
import { ODIN_VERSION } from "./odin-version";
import { RUST_VERSION } from "./rust-version";
import { ZIG_VERSION } from "./build-dependencies";
import { BUN_VERSION } from "./bun-version";
import {
	assertExactOdinRelease,
	assertStrictSemVer,
} from "./strict-semver.js";

export const NATIVE_DEVKIT_MANIFEST_FILENAME = "native-devkit.json";
export const NATIVE_DEVKIT_SCHEMA_VERSION = 1 as const;
export const ELECTROBUN_GO_SDK_MODULE = "electrobun" as const;

/**
 * These identities version the two compatibility boundaries independently of
 * the Electrobun release number. Increment one when a devkit can no longer use
 * a core or SDK built for the previous ABI.
 */
export const ELECTROBUN_CORE_ABI = {
	name: "electrobun-core",
	version: 1,
} as const;

export const ELECTROBUN_SDK_ABI = {
	name: "electrobun-sdk",
	version: 1,
} as const;

export type NativeDevkitTargetOS = "macos" | "linux" | "win";
export type NativeDevkitTargetArch = "arm64" | "x64";
export type NativeDevkitTarget =
	| { os: "win"; arch: "x64" }
	| { os: Exclude<NativeDevkitTargetOS, "win">; arch: NativeDevkitTargetArch };

/**
 * The JS SDK export table lives in the devkit, not in Hutch or Cottontail.
 * Every value is a POSIX path relative to the extracted core root.
 */
export const ELECTROBUN_JAVASCRIPT_SDK_EXPORTS = {
	".": "api/sdks/main/index.ts",
	"./main": "api/sdks/main/index.ts",
	"./main/app-menu": "api/sdks/main/entries/app-menu.ts",
	"./main/browser-view": "api/sdks/main/entries/browser-view.ts",
	"./main/browser-window": "api/sdks/main/entries/browser-window.ts",
	"./main/build-config": "api/sdks/main/entries/build-config.ts",
	"./main/context-menu": "api/sdks/main/entries/context-menu.ts",
	"./main/events": "api/sdks/main/entries/events.ts",
	"./main/gpu-window": "api/sdks/main/entries/gpu-window.ts",
	"./main/native": "api/sdks/main/entries/native.ts",
	"./main/paths": "api/sdks/main/entries/paths.ts",
	"./main/rpc": "api/sdks/main/entries/rpc.ts",
	"./main/socket": "api/sdks/main/entries/socket.ts",
	"./main/tray": "api/sdks/main/entries/tray.ts",
	"./main/ui": "api/sdks/main/entries/ui.ts",
	"./main/ui/jsx-runtime": "api/sdks/main/ui/jsx-runtime.ts",
	"./main/ui/jsx-dev-runtime": "api/sdks/main/ui/jsx-dev-runtime.ts",
	"./main/updater": "api/sdks/main/entries/updater.ts",
	"./main/utils": "api/sdks/main/entries/utils.ts",
	"./main/webgpu": "api/sdks/main/entries/webgpu.ts",
	"./main/wgpu-view": "api/sdks/main/entries/wgpu-view.ts",
	"./bun": "api/sdks/main/index.ts",
	"./bun/app-menu": "api/sdks/main/entries/app-menu.ts",
	"./bun/browser-view": "api/sdks/main/entries/browser-view.ts",
	"./bun/browser-window": "api/sdks/main/entries/browser-window.ts",
	"./bun/build-config": "api/sdks/main/entries/build-config.ts",
	"./bun/context-menu": "api/sdks/main/entries/context-menu.ts",
	"./bun/events": "api/sdks/main/entries/events.ts",
	"./bun/gpu-window": "api/sdks/main/entries/gpu-window.ts",
	"./bun/native": "api/sdks/main/entries/native.ts",
	"./bun/paths": "api/sdks/main/entries/paths.ts",
	"./bun/rpc": "api/sdks/main/entries/rpc.ts",
	"./bun/socket": "api/sdks/main/entries/socket.ts",
	"./bun/tray": "api/sdks/main/entries/tray.ts",
	"./bun/ui": "api/sdks/main/entries/ui.ts",
	"./bun/ui/jsx-runtime": "api/sdks/main/ui/jsx-runtime.ts",
	"./bun/ui/jsx-dev-runtime": "api/sdks/main/ui/jsx-dev-runtime.ts",
	"./bun/updater": "api/sdks/main/entries/updater.ts",
	"./bun/utils": "api/sdks/main/entries/utils.ts",
	"./bun/webgpu": "api/sdks/main/entries/webgpu.ts",
	"./bun/wgpu-view": "api/sdks/main/entries/wgpu-view.ts",
	"./rpc": "api/sdks/main/entries/rpc.ts",
	"./view": "api/browser/index.ts",
	"./browser/ui": "api/browser/ui/index.ts",
	"./browser/ui/jsx-runtime": "api/browser/ui/jsx-runtime.ts",
	"./browser/ui/jsx-dev-runtime": "api/browser/ui/jsx-dev-runtime.ts",
} as const;

export interface NativeDevkitManifest {
	schemaVersion: typeof NATIVE_DEVKIT_SCHEMA_VERSION;
	product: {
		name: "electrobun";
		version: string;
	};
	target: NativeDevkitTarget;
	abi: {
		core: typeof ELECTROBUN_CORE_ABI;
		sdk: typeof ELECTROBUN_SDK_ABI;
	};
	toolchains: {
		zig: { defaultVersion: string };
		rust: { defaultVersion: string };
		go: { defaultVersion: string };
		odin: { defaultVersion: string };
		bun: { defaultVersion: string };
	};
	layout: {
		runtime: {
			main: string;
			preloadFull: string;
			preloadSandboxed: string;
			launcher: string;
			extractor: string;
			coreLibrary: string;
			nativeWrapper: string;
			nativeWrapperCef: string;
			asarLibrary: string;
			wgpuLibrary: string;
			wgpuAuxiliaryLibraries: string[];
			processHelper: string;
			bsdiff: string;
			bspatch: string;
			zigAsar: string;
			zigZstd: string;
		};
		sdks: {
			javascript: {
				root: string;
				main: string;
				browser: string;
				config: string;
				preload: string;
				exports: Record<string, string>;
			};
			zig: { root: string; entrypoint: string };
			rust: { root: string; manifest: string };
			go: {
				root: string;
				manifest: string;
				module: typeof ELECTROBUN_GO_SDK_MODULE;
			};
			odin: {
				root: string;
				entrypoint: string;
				collection: string;
				collectionName: string;
			};
		};
	};
}

export function nativeDevkitTarget(
	os: NativeDevkitTargetOS,
	hostArch: NativeDevkitTargetArch,
): NativeDevkitTarget {
	return os === "win" ? { os, arch: "x64" } : { os, arch: hostArch };
}

function targetRuntimeLayout(
	target: NativeDevkitManifest["target"],
): NativeDevkitManifest["layout"]["runtime"] {
	const windows = target.os === "win";
	const extension = windows ? ".exe" : "";

	return {
		main: "main.js",
		preloadFull: "preload-full.js",
		preloadSandboxed: "preload-sandboxed.js",
		launcher: `launcher${extension}`,
		extractor: `extractor${extension}`,
		coreLibrary:
			target.os === "macos"
				? "libElectrobunCore.dylib"
				: windows
					? "ElectrobunCore.dll"
					: "libElectrobunCore.so",
		nativeWrapper:
			target.os === "macos"
				? "libNativeWrapper.dylib"
				: windows
					? "libNativeWrapper.dll"
					: "libNativeWrapper.so",
		nativeWrapperCef:
			target.os === "linux"
				? "libNativeWrapper_cef.so"
				: target.os === "macos"
					? "libNativeWrapper.dylib"
					: "libNativeWrapper.dll",
		asarLibrary:
			target.os === "macos"
				? "libasar.dylib"
				: windows
					? "libasar.dll"
					: "libasar.so",
		wgpuLibrary:
			target.os === "macos"
				? "libwebgpu_dawn.dylib"
				: windows
					? "webgpu_dawn.dll"
					: "libwebgpu_dawn.so",
		wgpuAuxiliaryLibraries: windows ? ["d3dcompiler_47.dll"] : [],
		processHelper: `process_helper${extension}`,
		bsdiff: `bsdiff${extension}`,
		bspatch: `bspatch${extension}`,
		zigAsar: windows ? "zig-asar/x64/zig-asar.exe" : "zig-asar",
		zigZstd: `zig-zstd${extension}`,
	};
}

export function createNativeDevkitManifest(options: {
	productVersion: string;
	target: NativeDevkitManifest["target"];
}): NativeDevkitManifest {
	const productVersion = assertStrictSemVer(
		options.productVersion,
		"Electrobun product version",
	);
	const zigVersion = assertStrictSemVer(ZIG_VERSION, "Zig default version");
	const rustVersion = assertStrictSemVer(RUST_VERSION, "Rust default version");
	const goVersion = assertStrictSemVer(GO_VERSION, "Go default version");
	const bunVersion = assertStrictSemVer(BUN_VERSION, "Bun default version");
	const odinVersion = assertExactOdinRelease(
		ODIN_VERSION,
		"Odin default version",
	);

	return {
		schemaVersion: NATIVE_DEVKIT_SCHEMA_VERSION,
		product: {
			name: "electrobun",
			version: productVersion,
		},
		target: options.target,
		abi: {
			core: ELECTROBUN_CORE_ABI,
			sdk: ELECTROBUN_SDK_ABI,
		},
		toolchains: {
			zig: { defaultVersion: zigVersion },
			rust: { defaultVersion: rustVersion },
			go: { defaultVersion: goVersion },
			odin: { defaultVersion: odinVersion },
			bun: { defaultVersion: bunVersion },
		},
		layout: {
			runtime: targetRuntimeLayout(options.target),
			sdks: {
				javascript: {
					root: "api",
					main: "api/sdks/main/index.ts",
					browser: "api/browser/index.ts",
					config: "api/config/ElectrobunConfig.ts",
					preload: "api/preload",
					exports: ELECTROBUN_JAVASCRIPT_SDK_EXPORTS,
				},
				zig: {
					root: "zig-sdk",
					entrypoint: "zig-sdk/electrobun.zig",
				},
				rust: {
					root: "rust-sdk",
					manifest: "rust-sdk/Cargo.toml",
				},
				go: {
					root: "go-sdk",
					manifest: "go-sdk/go.mod",
					module: ELECTROBUN_GO_SDK_MODULE,
				},
				odin: {
					root: "odin-sdk/electrobun",
					entrypoint: "odin-sdk/electrobun/electrobun.odin",
					collection: "odin-sdk",
					collectionName: "electrobun_sdk",
				},
			},
		},
	};
}

export function serializeNativeDevkitManifest(
	manifest: NativeDevkitManifest,
): string {
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}

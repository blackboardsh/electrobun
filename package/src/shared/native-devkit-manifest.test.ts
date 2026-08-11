import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
	ELECTROBUN_CORE_ABI,
	ELECTROBUN_JAVASCRIPT_SDK_EXPORTS,
	ELECTROBUN_SDK_ABI,
	NATIVE_DEVKIT_MANIFEST_FILENAME,
	createNativeDevkitManifest,
	nativeDevkitTarget,
	serializeNativeDevkitManifest,
	type NativeDevkitManifest,
} from "./native-devkit-manifest";
import { GO_VERSION } from "./go-version";
import { ODIN_VERSION } from "./odin-version";
import { RUST_VERSION } from "./rust-version";
import { ZIG_VERSION } from "./build-dependencies";

const targets: Array<{
	target: NativeDevkitManifest["target"];
	expected: Partial<NativeDevkitManifest["layout"]["runtime"]>;
}> = [
	{
		target: { os: "macos", arch: "arm64" },
		expected: {
			launcher: "launcher",
			coreLibrary: "libElectrobunCore.dylib",
			nativeWrapper: "libNativeWrapper.dylib",
			wgpuLibrary: "libwebgpu_dawn.dylib",
			bun: "bun",
		},
	},
	{
		target: { os: "linux", arch: "x64" },
		expected: {
			launcher: "launcher",
			coreLibrary: "libElectrobunCore.so",
			nativeWrapper: "libNativeWrapper.so",
			nativeWrapperCef: "libNativeWrapper_cef.so",
			wgpuLibrary: "libwebgpu_dawn.so",
		},
	},
	{
		target: { os: "win", arch: "x64" },
		expected: {
			launcher: "launcher.exe",
			extractor: "extractor.exe",
			coreLibrary: "ElectrobunCore.dll",
			nativeWrapper: "libNativeWrapper.dll",
			wgpuLibrary: "webgpu_dawn.dll",
			bun: "bun.exe",
			zigAsar: "zig-asar/x64/zig-asar.exe",
		},
	},
];

function manifestPaths(manifest: NativeDevkitManifest): string[] {
	const runtimePaths = Object.values(manifest.layout.runtime);
	const sdk = manifest.layout.sdks;
	return [
		...runtimePaths,
		sdk.javascript.root,
		sdk.javascript.main,
		sdk.javascript.browser,
		sdk.javascript.config,
		sdk.javascript.preload,
		...Object.values(sdk.javascript.exports),
		sdk.zig.root,
		sdk.zig.entrypoint,
		sdk.rust.root,
		sdk.rust.manifest,
		sdk.go.root,
		sdk.go.manifest,
		sdk.odin.root,
		sdk.odin.entrypoint,
		sdk.odin.collection,
	];
}

describe("native devkit manifest", () => {
	it("matches the cross-consumer contract fixture", () => {
		const fixture = JSON.parse(
			readFileSync(
				join(
					import.meta.dirname,
					"../../scripts/fixtures/native-devkit.macos-arm64.json",
				),
				"utf8",
			),
		);
		const manifest = createNativeDevkitManifest({
			productVersion: "2.0.0-beta.1",
			target: { os: "macos", arch: "arm64" },
		});

		expect(manifest).toEqual(fixture);
	});

	it("has a stable filename and explicit product/ABI identity", () => {
		const manifest = createNativeDevkitManifest({
			productVersion: "2.0.0-beta.1",
			target: { os: "macos", arch: "arm64" },
		});

		expect(NATIVE_DEVKIT_MANIFEST_FILENAME).toBe("native-devkit.json");
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.product).toEqual({
			name: "electrobun",
			version: "2.0.0-beta.1",
		});
		expect(manifest.abi).toEqual({
			core: ELECTROBUN_CORE_ABI,
			sdk: ELECTROBUN_SDK_ABI,
		});
	});

	it("records the native compiler defaults from their canonical pins", () => {
		const manifest = createNativeDevkitManifest({
			productVersion: "2.0.0",
			target: { os: "linux", arch: "x64" },
		});

		expect(manifest.toolchains).toEqual({
			zig: { defaultVersion: ZIG_VERSION },
			rust: { defaultVersion: RUST_VERSION },
			go: { defaultVersion: GO_VERSION },
			odin: { defaultVersion: ODIN_VERSION },
		});
		expect(Object.keys(manifest.toolchains)).toEqual([
			"zig",
			"rust",
			"go",
			"odin",
		]);
	});

	it("normalizes every Windows host to the shipped x64 runtime", () => {
		expect(nativeDevkitTarget("win", "arm64")).toEqual({
			os: "win",
			arch: "x64",
		});
		expect(nativeDevkitTarget("linux", "arm64")).toEqual({
			os: "linux",
			arch: "arm64",
		});
	});

	for (const { target, expected } of targets) {
		it(`declares exact ${target.os}-${target.arch} runtime paths`, () => {
			const manifest = createNativeDevkitManifest({
				productVersion: "2.0.0",
				target,
			});
			expect(manifest.target).toEqual(target);
			expect(manifest.layout.runtime).toMatchObject(expected);
		});
	}

	it("owns JS module exports and all native SDK build contracts", () => {
		const manifest = createNativeDevkitManifest({
			productVersion: "2.0.0",
			target: { os: "macos", arch: "x64" },
		});

		expect(manifest.layout.sdks.javascript.exports).toEqual(
			ELECTROBUN_JAVASCRIPT_SDK_EXPORTS,
		);
		expect(manifest.layout.sdks.javascript.exports["./main/browser-window"]).toBe(
			"api/sdks/main/entries/browser-window.ts",
		);
		expect(manifest.layout.sdks.zig.entrypoint).toBe(
			"zig-sdk/electrobun.zig",
		);
		expect(manifest.layout.sdks.rust.manifest).toBe(
			"rust-sdk/Cargo.toml",
		);
		expect(manifest.layout.sdks.go).toEqual({
			root: "go-sdk",
			manifest: "go-sdk/go.mod",
			module: "electrobun",
		});
		expect(manifest.layout.sdks.odin).toMatchObject({
			entrypoint: "odin-sdk/electrobun/electrobun.odin",
			collection: "odin-sdk",
			collectionName: "electrobun_sdk",
		});
	});

	it("uses only portable, core-root-relative paths", () => {
		const manifest = createNativeDevkitManifest({
			productVersion: "2.0.0",
			target: { os: "win", arch: "x64" },
		});

		for (const path of manifestPaths(manifest)) {
			expect(path).not.toStartWith("/");
			expect(path).not.toContain("\\");
			expect(path.split("/")).not.toContain("..");
		}
	});

	it("serializes deterministic, newline-terminated JSON", () => {
		const manifest = createNativeDevkitManifest({
			productVersion: "2.0.0",
			target: { os: "linux", arch: "arm64" },
		});
		const serialized = serializeNativeDevkitManifest(manifest);

		expect(serialized.endsWith("\n")).toBe(true);
		expect(JSON.parse(serialized)).toEqual(manifest);
		expect(serializeNativeDevkitManifest(manifest)).toBe(serialized);
	});
});

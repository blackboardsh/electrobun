import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { resolveInstalledRootNameForPaths } from "./Utils";

const baseInfo = {
	identifier: "com.example.application",
	channel: "production",
	version: "2.0.0",
	hash: "abc123",
	name: "ExampleApp",
	displayName: "Example App",
};

describe("app-scoped path migration", () => {
	test("keeps the physical v1 stable root on Windows and Linux", () => {
		expect(
			resolveInstalledRootNameForPaths(
				baseInfo,
				"win",
				"C:\\Users\\Test\\AppData\\Local\\com.example.application\\stable\\app\\bin\\cottontail.exe",
				"C:\\Users\\Test\\AppData\\Local",
			),
		).toBe("stable");
		expect(
			resolveInstalledRootNameForPaths(
				baseInfo,
				"linux",
				"/home/test/.local/share/com.example.application/stable/app/bin/cottontail",
				"/home/test/.local/share",
			),
		).toBe("stable");
	});

	test("keeps older physical name roots without escaping the identifier", () => {
		expect(
			resolveInstalledRootNameForPaths(
				baseInfo,
				"win",
				"C:\\Users\\Test\\AppData\\Local\\com.example.application\\ExampleApp-stable\\app\\bin\\cottontail.exe",
				"C:\\Users\\Test\\AppData\\Local",
			),
		).toBe("ExampleApp-stable");
		expect(
			resolveInstalledRootNameForPaths(
				baseInfo,
				"linux",
				"/tmp/outside/app/bin/cottontail",
				"/home/test/.local/share",
			),
		).toBe("production");
	});

	test("finds macOS stable and display-name roots from retained state", () => {
		const dataRoot = "/Users/test/Library/Application Support";
		const identifierRoot = posix.join(dataRoot, baseInfo.identifier);
		const stableTar = posix.join(
			identifierRoot,
			"stable",
			"self-extraction",
			`${baseInfo.hash}.tar`,
		);
		expect(
			resolveInstalledRootNameForPaths(
				baseInfo,
				"macos",
				"/Applications/Example App.app/Contents/MacOS/cottontail",
				dataRoot,
				(path) => path === stableTar,
			),
		).toBe("stable");

		const canaryInfo = { ...baseInfo, channel: "canary" };
		const displayRoot = `${canaryInfo.displayName}-${canaryInfo.channel}`;
		const displayManifest = posix.join(
			identifierRoot,
			displayRoot,
			".electrobun-uninstall.json",
		);
		expect(
			resolveInstalledRootNameForPaths(
				canaryInfo,
				"macos",
				"/Applications/Example App-canary.app/Contents/MacOS/cottontail",
				dataRoot,
				(path) => path === displayManifest,
			),
		).toBe(displayRoot);
	});

	test("uses host-independent path semantics", () => {
		expect(win32.basename("C:\\scope\\stable")).toBe("stable");
		expect(posix.basename("/scope/stable")).toBe("stable");
	});
});

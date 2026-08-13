import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMacUninstallerRefreshPlan,
	refreshMacUninstallerMetadata,
} from "./Updater";

describe("macOS updater uninstall manager refresh", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test("uses the app resource and a same-directory atomic staging path", () => {
		const plan = createMacUninstallerRefreshPlan(
			"/Users/Test/Library/Application Support/com.example.app/canary",
			"/Applications/Example-canary.app",
			"0123456789abcdef",
		);

		expect(plan).toEqual({
			packagedUninstallerPath:
				"/Applications/Example-canary.app/Contents/Resources/uninstall",
			installedUninstallerPath:
				"/Users/Test/Library/Application Support/com.example.app/canary/uninstall",
			stagedUninstallerPath:
				"/Users/Test/Library/Application Support/com.example.app/canary/.electrobun-uninstall-0123456789abcdef.tmp",
			refreshArguments: ["--refresh-metadata", "--quiet"],
		});
		expect(() =>
			createMacUninstallerRefreshPlan("/tmp/channel", "/tmp/App.app", "../bad"),
		).toThrow("Invalid macOS uninstaller staging nonce");
	});

	test("atomically installs an executable manager before refreshing metadata", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-mac-uninstaller-"));
		roots.push(root);
		const channelRoot = join(root, "data", "com.example.app", "production");
		const appBundle = join(root, "Example.app");
		const packaged = join(appBundle, "Contents", "Resources", "uninstall");
		mkdirSync(join(appBundle, "Contents", "Resources"), { recursive: true });
		mkdirSync(channelRoot, { recursive: true });
		writeFileSync(packaged, "new-manager\n");
		writeFileSync(join(channelRoot, "uninstall"), "old-manager\n");

		const calls: Array<{ executable: string; args: readonly string[] }> = [];
		const refreshed = refreshMacUninstallerMetadata(
			channelRoot,
			appBundle,
			(executable, args) => {
				calls.push({ executable, args });
				expect(readFileSync(executable, "utf8")).toBe("new-manager\n");
				expect(lstatSync(executable).mode & 0o777).toBe(0o755);
			},
			() => "0123456789abcdef",
		);

		expect(refreshed).toBe(true);
		expect(calls).toEqual([
			{
				executable: join(channelRoot, "uninstall"),
				args: ["--refresh-metadata", "--quiet"],
			},
		]);
		expect(
			existsSync(
				join(channelRoot, ".electrobun-uninstall-0123456789abcdef.tmp"),
			),
		).toBe(false);
	});

	test("does not install a symlinked bundle resource", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-mac-uninstaller-"));
		roots.push(root);
		const channelRoot = join(root, "data", "com.example.app", "production");
		const resources = join(root, "Example.app", "Contents", "Resources");
		const outside = join(root, "outside");
		mkdirSync(resources, { recursive: true });
		writeFileSync(outside, "not-managed\n");
		chmodSync(outside, 0o755);
		symlinkSync(outside, join(resources, "uninstall"));

		let executed = false;
		expect(
			refreshMacUninstallerMetadata(
				channelRoot,
				join(root, "Example.app"),
				() => {
					executed = true;
				},
				() => "0123456789abcdef",
			),
		).toBe(false);
		expect(executed).toBe(false);
		expect(existsSync(join(channelRoot, "uninstall"))).toBe(false);
	});

	test("does not follow a pre-created staging symlink", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-mac-uninstaller-"));
		roots.push(root);
		const channelRoot = join(root, "data", "com.example.app", "production");
		const resources = join(root, "Example.app", "Contents", "Resources");
		const packaged = join(resources, "uninstall");
		const outside = join(root, "outside");
		const staged = join(
			channelRoot,
			".electrobun-uninstall-0123456789abcdef.tmp",
		);
		mkdirSync(resources, { recursive: true });
		mkdirSync(channelRoot, { recursive: true });
		writeFileSync(packaged, "new-manager\n");
		writeFileSync(outside, "preserve-me\n");
		symlinkSync(outside, staged);

		expect(
			refreshMacUninstallerMetadata(
				channelRoot,
				join(root, "Example.app"),
				() => {
					throw new Error("must not execute");
				},
				() => "0123456789abcdef",
			),
		).toBe(false);
		expect(readFileSync(outside, "utf8")).toBe("preserve-me\n");
		expect(existsSync(staged)).toBe(false);
	});
});

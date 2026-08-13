import { afterEach, describe, expect, test } from "bun:test";
import {
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
	createLinuxUninstallerRefreshPlan,
	refreshLinuxUninstallerMetadata,
} from "./Updater";

describe("Linux updater uninstall manager refresh", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { force: true, recursive: true });
		}
	});

	test("uses the app resource and a same-directory staging path with spaces", () => {
		const plan = createLinuxUninstallerRefreshPlan(
			"/home/Test User/xdg data/com.example.app/canary channel",
			"/home/Test User/xdg data/com.example.app/canary channel/app",
			"0123456789abcdef",
		);

		expect(plan).toEqual({
			packagedUninstallerPath:
				"/home/Test User/xdg data/com.example.app/canary channel/app/Resources/uninstall",
			installedUninstallerPath:
				"/home/Test User/xdg data/com.example.app/canary channel/uninstall",
			stagedUninstallerPath:
				"/home/Test User/xdg data/com.example.app/canary channel/.electrobun-uninstall-0123456789abcdef.tmp",
			refreshArguments: ["--refresh-metadata", "--quiet"],
		});
		expect(() =>
			createLinuxUninstallerRefreshPlan("/tmp/channel", "/tmp/app", "../bad"),
		).toThrow("Invalid Linux uninstaller staging nonce");
	});

	test("atomically installs an executable manager before refreshing metadata", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-linux-uninstaller-"));
		roots.push(root);
		const channelRoot = join(root, "xdg data", "com.example.app", "production");
		const appBundle = join(channelRoot, "app");
		const packaged = join(appBundle, "Resources", "uninstall");
		const installed = join(channelRoot, "uninstall");
		mkdirSync(join(appBundle, "Resources"), { recursive: true });
		writeFileSync(packaged, "new-manager\n");
		writeFileSync(installed, "old-manager\n");
		writeFileSync(join(channelRoot, ".electrobun-uninstall.json"), "{}\n");

		const calls: Array<{ executable: string; args: readonly string[] }> = [];
		const refreshed = refreshLinuxUninstallerMetadata(
			channelRoot,
			appBundle,
			(executable, args) => {
				calls.push({ executable, args: [...args] });
				expect(readFileSync(executable, "utf8")).toBe("new-manager\n");
				expect(lstatSync(executable).mode & 0o777).toBe(0o755);
			},
			() => "0123456789abcdef",
		);

		expect(refreshed).toBe(true);
		expect(calls).toEqual([
			{
				executable: installed,
				args: ["--refresh-metadata", "--quiet"],
			},
		]);
		expect(
			existsSync(
				join(channelRoot, ".electrobun-uninstall-0123456789abcdef.tmp"),
			),
		).toBe(false);
	});

	test("leaves the existing manager untouched when an older bundle lacks the resource", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-linux-uninstaller-"));
		roots.push(root);
		const channelRoot = join(root, "data", "com.example.app", "production");
		const appBundle = join(channelRoot, "app");
		const installed = join(channelRoot, "uninstall");
		mkdirSync(appBundle, { recursive: true });
		writeFileSync(installed, "old-manager\n");
		writeFileSync(join(channelRoot, ".electrobun-uninstall.json"), "{}\n");
		let executed = false;

		expect(
			refreshLinuxUninstallerMetadata(
				channelRoot,
				appBundle,
				() => {
					executed = true;
				},
				() => "0123456789abcdef",
			),
		).toBe(false);
		expect(executed).toBe(false);
		expect(readFileSync(installed, "utf8")).toBe("old-manager\n");
	});

	test("does not create a manager for a package-managed install", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-linux-uninstaller-"));
		roots.push(root);
		const channelRoot = join(root, "data", "com.example.app", "production");
		const appBundle = join(channelRoot, "app");
		const resources = join(appBundle, "Resources");
		mkdirSync(resources, { recursive: true });
		writeFileSync(join(resources, "uninstall"), "bundled-manager\n");

		expect(
			refreshLinuxUninstallerMetadata(
				channelRoot,
				appBundle,
				() => {
					throw new Error("must not execute");
				},
				() => "0123456789abcdef",
			),
		).toBe(false);
		expect(existsSync(join(channelRoot, "uninstall"))).toBe(false);
		expect(
			existsSync(join(channelRoot, ".electrobun-uninstall-0123456789abcdef.tmp")),
		).toBe(false);
	});

	test("does not install a symlinked app resource", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-linux-uninstaller-"));
		roots.push(root);
		const channelRoot = join(root, "data", "com.example.app", "production");
		const resources = join(channelRoot, "app", "Resources");
		const outside = join(root, "outside-manager");
		const installed = join(channelRoot, "uninstall");
		mkdirSync(resources, { recursive: true });
		writeFileSync(outside, "outside\n");
		writeFileSync(installed, "old-manager\n");
		writeFileSync(join(channelRoot, ".electrobun-uninstall.json"), "{}\n");
		symlinkSync(outside, join(resources, "uninstall"));

		expect(
			refreshLinuxUninstallerMetadata(
				channelRoot,
				join(channelRoot, "app"),
				() => {
					throw new Error("must not execute");
				},
				() => "0123456789abcdef",
			),
		).toBe(false);
		expect(readFileSync(installed, "utf8")).toBe("old-manager\n");
		expect(readFileSync(outside, "utf8")).toBe("outside\n");
	});

	test("does not follow a symlinked Resources directory", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-linux-uninstaller-"));
		roots.push(root);
		const channelRoot = join(root, "data", "com.example.app", "production");
		const appBundle = join(channelRoot, "app");
		const outsideResources = join(root, "outside-resources");
		const installed = join(channelRoot, "uninstall");
		mkdirSync(appBundle, { recursive: true });
		mkdirSync(outsideResources);
		writeFileSync(join(outsideResources, "uninstall"), "outside-manager\n");
		writeFileSync(installed, "old-manager\n");
		writeFileSync(join(channelRoot, ".electrobun-uninstall.json"), "{}\n");
		symlinkSync(outsideResources, join(appBundle, "Resources"));

		expect(
			refreshLinuxUninstallerMetadata(
				channelRoot,
				appBundle,
				() => {
					throw new Error("must not execute");
				},
				() => "0123456789abcdef",
			),
		).toBe(false);
		expect(readFileSync(installed, "utf8")).toBe("old-manager\n");
	});

	test("rejects a symlinked channel-root intermediate", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-linux-uninstaller-"));
		roots.push(root);
		const physicalData = join(root, "physical-data");
		const linkedData = join(root, "linked-data");
		const physicalChannel = join(
			physicalData,
			"com.example.app",
			"production",
		);
		const linkedChannel = join(linkedData, "com.example.app", "production");
		const resources = join(physicalChannel, "app", "Resources");
		mkdirSync(resources, { recursive: true });
		writeFileSync(join(resources, "uninstall"), "new-manager\n");
		writeFileSync(join(physicalChannel, "uninstall"), "old-manager\n");
		writeFileSync(
			join(physicalChannel, ".electrobun-uninstall.json"),
			"{}\n",
		);
		symlinkSync(physicalData, linkedData);

		expect(
			refreshLinuxUninstallerMetadata(
				linkedChannel,
				join(linkedChannel, "app"),
				() => {
					throw new Error("must not execute");
				},
				() => "0123456789abcdef",
			),
		).toBe(false);
		expect(readFileSync(join(physicalChannel, "uninstall"), "utf8")).toBe(
			"old-manager\n",
		);
	});

	test("does not follow a pre-created staging symlink", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-linux-uninstaller-"));
		roots.push(root);
		const channelRoot = join(root, "data", "com.example.app", "production");
		const appBundle = join(channelRoot, "app");
		const resources = join(appBundle, "Resources");
		const outside = join(root, "outside");
		const staged = join(
			channelRoot,
			".electrobun-uninstall-0123456789abcdef.tmp",
		);
		mkdirSync(resources, { recursive: true });
		writeFileSync(join(resources, "uninstall"), "new-manager\n");
		writeFileSync(join(channelRoot, "uninstall"), "old-manager\n");
		writeFileSync(join(channelRoot, ".electrobun-uninstall.json"), "{}\n");
		writeFileSync(outside, "preserve-me\n");
		symlinkSync(outside, staged);

		expect(
			refreshLinuxUninstallerMetadata(
				channelRoot,
				appBundle,
				() => {
					throw new Error("must not execute");
				},
				() => "0123456789abcdef",
			),
		).toBe(false);
		expect(readFileSync(outside, "utf8")).toBe("preserve-me\n");
		expect(existsSync(staged)).toBe(false);
	});

	test("cleans staging state when metadata refresh fails", () => {
		const root = mkdtempSync(join(tmpdir(), "electrobun-linux-uninstaller-"));
		roots.push(root);
		const channelRoot = join(root, "data", "com.example.app", "production");
		const appBundle = join(channelRoot, "app");
		const resources = join(appBundle, "Resources");
		const installed = join(channelRoot, "uninstall");
		const staged = join(
			channelRoot,
			".electrobun-uninstall-0123456789abcdef.tmp",
		);
		mkdirSync(resources, { recursive: true });
		writeFileSync(join(resources, "uninstall"), "new-manager\n");
		writeFileSync(installed, "old-manager\n");
		writeFileSync(join(channelRoot, ".electrobun-uninstall.json"), "{}\n");

		expect(
			refreshLinuxUninstallerMetadata(
				channelRoot,
				appBundle,
				() => {
					throw new Error("refresh failed");
				},
				() => "0123456789abcdef",
			),
		).toBe(false);
		expect(existsSync(staged)).toBe(false);
		expect(readFileSync(installed, "utf8")).toBe("new-manager\n");
		expect(lstatSync(installed).mode & 0o777).toBe(0o755);
	});
});

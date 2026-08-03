import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

type PackageManifest = {
	bin?: string | Record<string, string>;
	files?: string[];
	scripts?: Record<string, string>;
};

type Bootstrap = {
	channelForVersion(
		version: string,
		environment: Record<string, string | undefined>,
	): "production" | "canary";
	hutchBinaryPath(
		channel: "production" | "canary",
		environment: Record<string, string | undefined>,
		platform: string,
		userHome: string,
	): string;
	main(options: Record<string, unknown>): Promise<number>;
};

const packageRoot = join(import.meta.dirname, "..");
const manifest = JSON.parse(
	readFileSync(join(packageRoot, "package.json"), "utf8"),
) as PackageManifest;
const bootstrapPath = join(packageRoot, "bin", "electrobun.cjs");
const require = createRequire(import.meta.url);
const bootstrap = require(bootstrapPath) as Bootstrap;

describe("npm and bunx Hutch bootstrap", () => {
	test("publishes one lightweight Electrobun command without lifecycle hooks", () => {
		expect(existsSync(bootstrapPath)).toBe(true);
		expect(manifest.bin).toEqual({ electrobun: "./bin/electrobun.cjs" });

		for (const lifecycle of ["preinstall", "install", "postinstall"]) {
			expect(manifest.scripts?.[lifecycle]).toBeUndefined();
		}
	});

	test("publishes only the bootstrap from package/bin", () => {
		const npmIgnoreEntries = readFileSync(
			join(packageRoot, ".npmignore"),
			"utf8",
		)
			.split(/\r?\n/u)
			.map((entry) => entry.trim())
			.filter((entry) => entry && !entry.startsWith("#"));

		expect(npmIgnoreEntries).toContain("/bin/*");
		expect(npmIgnoreEntries).toContain("!/bin/electrobun.cjs");
		expect(
			(manifest.files ?? []).some(
				(entry) => entry === "bin" || entry.startsWith("bin/"),
			),
		).toBe(false);
	});

	test("selects the active Hutch channel, then the Electrobun release channel", () => {
		expect(bootstrap.channelForVersion("2.0.0", {})).toBe("production");
		expect(bootstrap.channelForVersion("2.0.0-beta.4", {})).toBe("canary");
		expect(
			bootstrap.channelForVersion("2.0.0", { HUTCH_ACTIVE_CHANNEL: "canary" }),
		).toBe("canary");
		expect(
			bootstrap.channelForVersion("2.0.0-beta.4", {
				ELECTROBUN_HUTCH_CHANNEL: "stable",
			}),
		).toBe("production");
	});

	test("delegates every argument to the canonical Hutch command", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const status = await bootstrap.main({
			args: ["init", "my-app"],
			environment: { DASH_HOME: "/home/dev/.dash" },
			existsSync: () => true,
			platform: "linux",
			runHutch: (call: Record<string, unknown>) => {
				calls.push(call);
				return 23;
			},
			userHome: "/home/dev",
			version: "2.0.0",
		});

		expect(status).toBe(23);
		expect(calls).toEqual([
			{
				args: ["init", "my-app"],
				binary: "/home/dev/.dash/bin/hutch",
				environment: { DASH_HOME: "/home/dev/.dash" },
			},
		]);
	});

	test("does not recreate the retired project CLI wrapper", async () => {
		await expect(
			bootstrap.main({
				args: ["dev"],
				environment: {},
				existsSync: () => true,
				platform: "linux",
				userHome: "/home/dev",
				version: "2.0.0",
			}),
		).rejects.toThrow("supports only `electrobun init`");
	});

	test("installs a missing channel once before delegation", async () => {
		let installed = false;
		const calls: string[] = [];
		const status = await bootstrap.main({
			args: ["init"],
			environment: {},
			existsSync: () => installed,
			installHutch: async ({ channel }: { channel: string }) => {
				calls.push(`install:${channel}`);
				installed = true;
			},
			platform: "linux",
			runHutch: ({ binary }: { binary: string }) => {
				calls.push(`run:${binary}`);
				return 0;
			},
			userHome: "/home/dev",
			version: "2.0.0-beta.4",
		});

		expect(status).toBe(0);
		expect(calls).toEqual([
			"install:canary",
			"run:/home/dev/.dash/bin/hutch-canary",
		]);
	});

	test("uses the canonical Windows installation path", () => {
		expect(
			bootstrap.hutchBinaryPath(
				"canary",
				{ DASH_HOME: "C:\\Users\\dev\\.dash" },
				"win32",
				"C:\\Users\\dev",
			),
		).toBe("C:\\Users\\dev\\.dash\\bin\\hutch-canary.exe");
	});

	test("keeps the retired embedded CLI and templates out of npm", () => {
		const npmIgnoreEntries = readFileSync(
			join(packageRoot, ".npmignore"),
			"utf8",
		)
			.split(/\r?\n/u)
			.map((entry) => entry.trim())
			.filter((entry) => entry && !entry.startsWith("#"));

		expect(npmIgnoreEntries).toContain("/src/cli/");
		expect(npmIgnoreEntries).not.toContain("!/src/cli/");
	});
});

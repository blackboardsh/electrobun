import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type PackageManifest = {
	bin?: string | Record<string, string>;
	files?: string[];
	scripts?: Record<string, string>;
};

const packageRoot = join(import.meta.dirname, "..");
const manifest = JSON.parse(
	readFileSync(join(packageRoot, "package.json"), "utf8"),
) as PackageManifest;

describe("retired npm CLI bootstrap", () => {
	test("does not expose the signal-swallowing Electrobun wrapper", () => {
		expect(existsSync(join(packageRoot, "bin", "electrobun.cjs"))).toBe(false);
		expect(manifest.bin).toBeUndefined();

		for (const lifecycle of ["preinstall", "install", "postinstall"]) {
			expect(manifest.scripts?.[lifecycle]).toBeUndefined();
		}

		expect(JSON.stringify(manifest)).not.toContain("electrobun.cjs");
	});

	test("keeps package/bin out of the published npm package", () => {
		const npmIgnoreEntries = readFileSync(
			join(packageRoot, ".npmignore"),
			"utf8",
		)
			.split(/\r?\n/u)
			.map((entry) => entry.trim())
			.filter((entry) => entry && !entry.startsWith("#"));

		expect(npmIgnoreEntries).toContain("/bin");
		expect(
			(manifest.files ?? []).some(
				(entry) => entry === "bin" || entry.startsWith("bin/"),
			),
		).toBe(false);
	});

	test("keeps the retired CLI and embedded templates out of npm", () => {
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

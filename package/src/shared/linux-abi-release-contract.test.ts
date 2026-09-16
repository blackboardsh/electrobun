import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const packageRoot = join(import.meta.dirname, "../..");
const releaseWorkflow = readFileSync(
	join(packageRoot, "../.github/workflows/release.yml"),
	"utf8",
).replaceAll("\r\n", "\n");
const releaseScript = readFileSync(
	join(packageRoot, "scripts/package-release.js"),
	"utf8",
);

describe("Linux release ABI baseline", () => {
	test("uses build hosts compatible with the pinned Cottontail runtime", () => {
		expect(releaseWorkflow).toContain("os: ubuntu-24.04\n");
		expect(releaseWorkflow).toContain("os: ubuntu-24.04-arm\n");
		expect(releaseWorkflow).not.toContain("os: ubuntu-22.04\n");
		expect(releaseWorkflow).not.toContain("os: ubuntu-22.04-arm\n");
	});

	test("independently verifies every staged ELF before creating release tarballs", () => {
		const verifier = releaseScript.indexOf("verify-linux-elf-abi.js");
		const tarball = releaseScript.indexOf("function createTarGz");
		expect(verifier).toBeGreaterThan(0);
		expect(verifier).toBeLessThan(tarball);
	});
});

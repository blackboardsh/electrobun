import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageBuild = readFileSync(
	join(import.meta.dirname, "../../build.ts"),
	"utf8",
);

function sourceBetween(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	if (startIndex < 0 || endIndex < 0) {
		throw new Error(`Could not find package build section: ${start} ... ${end}`);
	}
	return source.slice(startIndex, endIndex);
}

describe("Windows platform dist staging", () => {
	test("uses Cottontail's native bulk copy path", () => {
		const platformCopy = sourceBetween(
			packageBuild,
			"async function createPlatformDistFolder() {",
			"function getPlatform() {",
		);
		const windowsCopy = sourceBetween(
			platformCopy,
			'if (OS === "win") {',
			'} else if (OS === "macos") {',
		);

		expect(windowsCopy).toContain('cpSync("dist", platformDistDir');
		expect(windowsCopy).toContain("recursive: true");
		expect(windowsCopy).toContain("force: true");
		// preserveTimestamps selects Cottontail's JavaScript fallback. On Windows,
		// use its native tree copy instead; the staging directory does not require
		// source mtimes and native copying avoids false ELOOP reports from rounded
		// 64-bit NTFS file identities in older Cottontail releases.
		expect(windowsCopy).not.toContain("preserveTimestamps");
	});
});

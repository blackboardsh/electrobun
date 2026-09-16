import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nativeRoot = join(import.meta.dirname, "../native");
const sharedHeader = readFileSync(
	join(nativeRoot, "shared/partition_context.h"),
	"utf8",
);

describe("CEF partition request contexts", () => {
	test("selects the global profile only for persist:default", () => {
		const defaultSelection = sharedHeader.indexOf(
			'if (identifier == "persist:default")',
		);
		const namedPersistentSelection = sharedHeader.indexOf(
			"// Reuse cached context for persist:* partitions only.",
		);

		expect(defaultSelection).toBeGreaterThan(-1);
		expect(defaultSelection).toBeLessThan(namedPersistentSelection);
		expect(
			sharedHeader.slice(defaultSelection, namedPersistentSelection),
		).toContain("CefRequestContext::GetGlobalContext()");
	});

	test.each([
		["macos/nativeWrapper.mm"],
		["win/nativeWrapper.cpp"],
		["linux/nativeWrapper.cpp"],
	])("routes %s through the shared partition policy", (relativePath) => {
		const source = readFileSync(join(nativeRoot, relativePath), "utf8");
		expect(source).toContain('#include "../shared/partition_context.h"');
		expect(source).toContain(
			"electrobun::getOrCreateRequestContextForPartition(",
		);
	});
});

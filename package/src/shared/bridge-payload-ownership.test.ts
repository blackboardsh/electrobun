import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoot = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(sourceRoot, path), "utf8");

function between(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	expect(startIndex).toBeGreaterThanOrEqual(0);
	expect(endIndex).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
}

describe("bridge callback payload ownership", () => {
	it("copies asynchronous payloads in core and releases them explicitly", () => {
		const core = read("core/main.zig");
		const runtime = read("sdks/bun/proc/native.ts");

		expect(core).toContain("dispatchRuntimePostMessage");
		expect(core).toContain("releaseRuntimeCallbackPayload");
		expect(runtime).toContain("setRuntimeCallbacksAsync(true)");
		expect(runtime).toContain("releaseRuntimeCallbackPayload(");
	});

	it("does not use timed bridge-buffer cleanup in native wrappers", () => {
		const macosHandler = between(
			read("native/macos/nativeWrapper.mm"),
			"@implementation MyScriptMessageHandler\n",
			"@end\n",
		);
		const linuxHandlers = between(
			read("native/linux/nativeWrapper.cpp"),
			"static void onEventBridgeMessage(",
			"// Static debounce timestamp",
		);
		const windowsHandler = between(
			read("native/win/nativeWrapper.cpp"),
			"HRESULT PostMessage(BSTR message)",
			"};\n\n// Dispatch IDs",
		);

		for (const handler of [macosHandler, linuxHandlers, windowsHandler]) {
			expect(handler).not.toContain("sleep_for");
			expect(handler).not.toContain("dispatch_after");
			expect(handler).not.toContain("messageCopy");
		}
	});
});

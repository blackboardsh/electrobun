import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(packageRoot, path), "utf8");

describe("WGPU window close ordering", () => {
	test("notifies JS before native child views are removed", () => {
		const source = read("core/main.zig");
		const start = source.indexOf("fn windowCloseTrampoline(");
		const end = source.indexOf("\nfn windowMoveTrampoline(", start);
		const body = source.slice(start, end);
		const notify = body.indexOf("handler(window_id);");
		const removeWebviews = body.indexOf("collectWebviewIdsForWindow");
		const removeWgpuViews = body.indexOf("collectWgpuViewIdsForWindow");

		expect(notify).toBeGreaterThan(-1);
		expect(notify).toBeLessThan(removeWebviews);
		expect(notify).toBeLessThan(removeWgpuViews);
	});

	test("programmatic close waits for the common close callback", () => {
		const source = read("sdks/main/core/GpuWindow.ts");
		const start = source.indexOf("\n\tclose() {");
		const end = source.indexOf("\n\trequestClose()", start);
		const body = source.slice(start, end);

		expect(body).toContain("ffi.request.closeWindow");
		expect(body).not.toContain("releaseWebgpuContext");
	});

	test("the JS close callback emits mount-specific handlers first", () => {
		const source = read("sdks/main/proc/native.ts");
		const start = source.indexOf("const windowCloseCallback");
		const end = source.indexOf("\nconst windowMoveCallback", start);
		const body = source.slice(start, end);

		expect(body.indexOf("emitEvent(event, id)")).toBeLessThan(
			body.indexOf("emitEvent(event);"),
		);
	});
});

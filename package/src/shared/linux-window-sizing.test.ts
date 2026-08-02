import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nativeWrapper = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);

describe("Linux GTK window sizing source contract", () => {
	it("does not turn full-size child allocations into window minimums", () => {
		// gtk_widget_set_size_request() defines a minimum. Initial/full-size
		// allocations must remain unset so a window can shrink after it grows.
		expect(nativeWrapper).not.toContain(
			"gtk_widget_set_size_request(webview, (int)width, (int)height);",
		);
		expect(nativeWrapper).toContain(
			"gtk_widget_set_size_request(webview, -1, -1);",
		);
		expect(
			nativeWrapper.match(/autoResize \? -1 : \(int\)width/g)?.length,
		).toBe(2);
		expect(
			nativeWrapper.match(/autoResize \? -1 : \(int\)height/g)?.length,
		).toBe(2);
	});
});

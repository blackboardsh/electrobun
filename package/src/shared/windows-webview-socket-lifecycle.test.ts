import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const coreSource = readFileSync(
	join(import.meta.dirname, "..", "core", "main.zig"),
	"utf8",
);

const sourceBetween = (startMarker: string, endMarker: string) => {
	const start = coreSource.indexOf(startMarker);
	const end = coreSource.indexOf(endMarker, start);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return coreSource.slice(start, end);
};

describe("Windows webview socket ownership", () => {
	it("leaves the accepted socket with its connection thread during WebView2 removal", () => {
		const connectionHandler = sourceBetween(
			"fn handleHostTransportConnection",
			"fn hostTransportAcceptLoop",
		);
		const webviewRemove = sourceBetween(
			"export fn webviewRemove",
			"export fn setWebviewHTMLContent",
		);

		expect(connectionHandler).toContain("defer stream.close()");
		expect(webviewRemove).toContain("if (builtin.os.tag != .windows)");
		expect(webviewRemove).toContain("shutdownSocketHandle(handle)");
		expect(webviewRemove.indexOf("if (builtin.os.tag != .windows)")).toBeLessThan(
			webviewRemove.indexOf('lookupNativeSymbol(WebviewRemoveFn, "webviewRemove")'),
		);
	});
});

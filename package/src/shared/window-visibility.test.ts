import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(packageRoot, path), "utf8");

describe("native window visibility contract", () => {
	it("queries each platform's native window state", () => {
		const macos = read("native/macos/nativeWrapper.mm");
		const windows = read("native/win/nativeWrapper.cpp");
		const linux = read("native/linux/nativeWrapper.cpp");

		expect(macos).toContain('extern "C" bool isWindowVisible(NSWindow *window)');
		expect(macos).toContain("[window isVisible]");
		expect(windows).toContain("ELECTROBUN_EXPORT bool isWindowVisible(void *window)");
		expect(windows).toContain("IsWindowVisible(hwnd) != FALSE");
		expect(linux).toContain("ELECTROBUN_EXPORT bool isWindowVisible(void* window)");
		expect(linux).toContain("XGetWindowAttributes");
		expect(linux).toContain("attributes.map_state != IsUnmapped");
		expect(linux).toContain("gtk_widget_get_visible");
	});

	it("exports one core ABI symbol and loads it in every SDK", () => {
		const core = read("core/main.zig");
		const bunWindow = read("sdks/bun/core/BrowserWindow.ts");
		const bunNative = read("sdks/bun/proc/native.ts");
		const zig = read("sdks/zig/electrobun.zig");
		const rust = read("sdks/rust/electrobun.rs");
		const go = read("sdks/go/electrobun.go");
		const odin = read("sdks/odin/electrobun.odin");

		expect(core).toContain("export fn isWindowVisible(window_id: u32) bool");
		expect(core).toContain('lookupNativeSymbol(IsWindowVisibleFn, "isWindowVisible")');
		expect(bunWindow).toContain("isVisible(): boolean");
		expect(bunNative).toContain("core_.symbols.isWindowVisible(winId)");
		expect(zig).toContain('lib.lookup(IsWindowVisibleFn, "isWindowVisible")');
		expect(rust).toContain('is_window_visible: lib.symbol("isWindowVisible")?');
		expect(go).toContain('c.symbol("isWindowVisible")');
		expect(odin).toContain("isWindowVisible:                        WindowIdBoolFn");
	});
});

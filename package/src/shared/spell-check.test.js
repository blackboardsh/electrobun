import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(src, relativePath), "utf8");

test("macOS WebKit SPI is guarded and reapplied after navigation", () => {
	const helper = read("native/macos/spell_check.h");
	const wrapper = read("native/macos/nativeWrapper.mm");

	assert.match(helper, /_setContinuousSpellCheckingEnabledForTesting:/);
	assert.match(helper, /respondsToSelector/);
	assert.match(helper, /process-level TextChecker state/);
	assert.match(
		wrapper,
		/didFinishNavigation:[\s\S]*spellCheckConfigured[\s\S]*setContinuousSpellChecking/,
	);
	assert.match(wrapper, /extern "C" bool webviewSetSpellCheck/);
});

test("CEF and non-macOS native renderers report unsupported", () => {
	const mac = read("native/macos/nativeWrapper.mm");
	const windows = read("native/win/nativeWrapper.cpp");
	const linux = read("native/linux/nativeWrapper.cpp");

	assert.match(mac, /AbstractView[\s\S]*setSpellCheck:[\s\S]*return NO/);
	for (const wrapper of [windows, linux]) {
		assert.match(
			wrapper,
			/webviewSetSpellCheck\([\s\S]*?\{[\s\S]*?return false;[\s\S]*?\}/,
		);
	}
});

test("every main-process SDK exposes initial and runtime controls", () => {
	const files = [
		"sdks/bun/core/BrowserView.ts",
		"sdks/bun/core/BrowserWindow.ts",
		"sdks/zig/electrobun.zig",
		"sdks/rust/electrobun.rs",
		"sdks/go/electrobun.go",
		"sdks/odin/electrobun.odin",
	];

	for (const file of files) {
		const source = read(file).toLowerCase();
		assert.match(source, /spellcheck/);
		assert.match(source, /set_?webview_?spell_?check|setspellcheck/);
	}
});

test("webview tags route initialization and runtime requests through core", () => {
	const preload = read("preload/webviewTag.ts");
	const core = read("core/main.zig");

	assert.match(preload, /getAttribute\("spellcheck"\)/);
	assert.match(preload, /request\("webviewTagSetSpellCheck"/);
	assert.match(core, /params_object\.get\("spellCheck"\)/);
	assert.match(core, /std\.mem\.eql\(u8, method, "webviewTagSetSpellCheck"\)/);
	assert.match(core, /export fn webviewSetSpellCheck/);
});

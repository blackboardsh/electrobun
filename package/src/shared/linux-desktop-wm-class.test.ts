import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const source = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);

describe("Linux desktop WM class", () => {
	test.skipIf(process.platform === "win32")("qualifies raw names without duplicating packaged channel suffixes", () => {
		// Compile the actual helper without requiring GTK/CEF development headers.
		const start = source.indexOf("static std::string deriveLinuxWindowClass(");
		const end = source.indexOf("\n}\n", start) + 2;
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const directory = mkdtempSync(join(tmpdir(), "electrobun-wm-class-"));
		try {
			const input = join(directory, "test.cpp");
			const binary = join(directory, "test");
			writeFileSync(input, `#include <string>\n#include <cassert>\n${source.slice(start, end)}
int main() {
    assert(deriveLinuxWindowClass("Dash", "canary") == "Dash-canary");
    assert(deriveLinuxWindowClass("Dash-canary", "canary") == "Dash-canary");
    assert(deriveLinuxWindowClass("Dash-dev", "dev") == "Dash-dev");
    assert(deriveLinuxWindowClass("Dash", "stable") == "Dash");
    assert(deriveLinuxWindowClass("My App-canary", "canary") == "MyApp-canary");
    assert(deriveLinuxWindowClass("My App", "dev") == "MyApp-dev");
    assert(deriveLinuxWindowClass("Dash-canary-tools", "canary") == "Dash-canary-tools-canary");
    assert(deriveLinuxWindowClass("Dash-canary", "stable") == "Dash-canary");
    assert(deriveLinuxWindowClass("Dash", "") == "Dash");
    assert(deriveLinuxWindowClass("", "dev") == "Electrobun-dev");
}
`);
			const compile = spawnSync(process.env.CXX || "c++", ["-std=c++17", input, "-o", binary], { encoding: "utf8" });
			expect(compile.stderr).toBe("");
			expect(compile.status).toBe(0);
			expect(spawnSync(binary).status).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("derives the native class from app name and channel", () => {
		expect(source).toContain("deriveLinuxWindowClass(");
		expect(source).toContain("character != ' '");
		expect(source).toContain('channel != "stable"');
		expect(source).not.toContain('channel != "production"');
		expect(source).not.toContain("ElectrobunKitchenSink-dev");
	});

	test("uses the same class for X11/CEF and GTK/WebKit windows", () => {
		expect(
			source.match(/g_electrobunWindowClass\.c_str\(\)/g)?.length,
		).toBeGreaterThanOrEqual(4);
		expect(source).toContain("XSetClassHint");
		expect(source).toContain("gtk_window_set_wmclass");
	});
});

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const repoRoot = join(packageRoot, "..", "..");
const read = (path: string) => readFileSync(join(packageRoot, path), "utf8");
const readTemplate = (path: string) =>
	readFileSync(join(repoRoot, "templates", path), "utf8");

describe("exit on last window closed contract", () => {
	it("asks the quit-requested handler to quit when the last window closes", () => {
		const core = read("core/main.zig");

		expect(core).toContain("var exit_on_last_window_closed: bool = true;");
		expect(core).toContain("export fn setExitOnLastWindowClosed(enabled: bool) void");
		expect(core).toContain(
			"if (exit_on_last_window_closed and !hasOpenWindows()) {",
		);
	});

	it("documents the config field the SDKs read", () => {
		const config = read("config/ElectrobunConfig.ts");

		expect(config).toContain("exitOnLastWindowClosed?: boolean;");
		expect(config).toContain("@default true");
	});

	it("keeps the bun SDK default", () => {
		const bunWindow = read("sdks/main/core/BrowserWindow.ts");
		const bunGpuWindow = read("sdks/main/core/GpuWindow.ts");
		const bunNative = read("sdks/main/proc/native.ts");

		expect(bunWindow).toContain(
			"enabled: buildConfig.runtime?.exitOnLastWindowClosed ?? true,",
		);
		expect(bunGpuWindow).toContain(
			"enabled: buildConfig.runtime?.exitOnLastWindowClosed ?? true,",
		);
		expect(bunNative).toContain(
			"core_.symbols.setQuitRequestedHandler(quitRequestedCallback)",
		);
	});

	it("loads the core symbol in every language SDK", () => {
		expect(read("sdks/zig/electrobun.zig")).toContain(
			'lib.lookup(SetExitOnLastWindowClosedFn, "setExitOnLastWindowClosed")',
		);
		expect(read("sdks/rust/electrobun.rs")).toContain(
			'set_exit_on_last_window_closed: lib.symbol("setExitOnLastWindowClosed")?',
		);
		expect(read("sdks/go/electrobun.go")).toContain(
			'"setExitOnLastWindowClosed",',
		);
		expect(read("sdks/odin/electrobun.odin")).toContain(
			"setExitOnLastWindowClosed:              SetBoolFn,",
		);
	});

	it("exposes the toggle in every language SDK", () => {
		expect(read("sdks/zig/electrobun.zig")).toContain(
			"pub fn setExitOnLastWindowClosed(self: *Core, enabled: bool) !void",
		);
		expect(read("sdks/rust/electrobun.rs")).toContain(
			"pub fn set_exit_on_last_window_closed(&self, enabled: bool) -> Result<(), String>",
		);
		expect(read("sdks/go/electrobun.go")).toContain(
			"func (c *Core) SetExitOnLastWindowClosed(enabled bool) error",
		);
		expect(read("sdks/odin/electrobun.odin")).toContain(
			"setExitOnLastWindowClosed :: proc(self: ^Core, enabled: bool) -> Error",
		);
	});

	it("reads runtime.exitOnLastWindowClosed from the bundled build.json", () => {
		const zig = read("sdks/zig/electrobun.zig");
		expect(zig).toContain('&.{ bundle_paths.resources_dir, "build.json" }');
		expect(zig).toContain('runtime_value.object.get("exitOnLastWindowClosed")');
		expect(zig).toContain(
			"exitOnLastWindowClosedFromBuildConfig(allocator, &bundle_paths)",
		);

		const odin = read("sdks/odin/electrobun.odin");
		expect(odin).toContain('{bundle_paths.resources_dir, "build.json"}');
		expect(odin).toContain('runtime_object["exitOnLastWindowClosed"]');
		expect(odin).toContain(
			"exitOnLastWindowClosedFromBuildConfig(allocator, &bundle_paths)",
		);

		const go = read("sdks/go/electrobun.go");
		expect(go).toContain('filepath.Join(bundlePaths.ResourcesDir, "build.json")');
		expect(go).toContain(
			'ExitOnLastWindowClosed *bool `json:"exitOnLastWindowClosed"`',
		);
		expect(go).toContain("ExitOnLastWindowClosedFromBuildConfig(bundlePaths)");

		const rust = read("sdks/rust/electrobun.rs");
		expect(rust).toContain('bundle_paths.resources_dir.join("build.json")');
		expect(rust).toContain(
			'json_bool_field(runtime_object, "exitOnLastWindowClosed")',
		);
		expect(rust).toContain(
			"exit_on_last_window_closed_from_build_config(&bundle_paths)",
		);
	});

	it("falls back to quitting when the config says nothing", () => {
		expect(read("sdks/zig/electrobun.zig")).toContain(
			"pub fn exitOnLastWindowClosedFromJson(allocator: std.mem.Allocator, build_json: []const u8) bool",
		);
		expect(read("sdks/go/electrobun.go")).toContain(
			"if config.Runtime.ExitOnLastWindowClosed == nil {\n\t\treturn true\n\t}",
		);
		expect(read("sdks/rust/electrobun.rs")).toContain(
			'json_bool_field(runtime_object, "exitOnLastWindowClosed").unwrap_or(true)',
		);
	});

	it("installs a default quit-requested handler when the core is loaded", () => {
		const zig = read("sdks/zig/electrobun.zig");
		expect(zig).toContain("quit_requested_stop_event_loop = core.symbols.stop_event_loop;");
		expect(zig).toContain("core.symbols.set_quit_requested_handler(quitRequestedTrampoline);");

		const rust = read("sdks/rust/electrobun.rs");
		expect(rust).toContain("QUIT_REQUESTED_STOP_EVENT_LOOP.store(");
		expect(rust).toContain(
			"(symbols.set_quit_requested_handler)(Some(quit_requested_trampoline));",
		);

		const go = read("sdks/go/electrobun.go");
		expect(go).toContain("if err := core.SetQuitRequestedHandler(nil); err != nil {");
		expect(go).toContain("handler = func() { _ = c.StopEventLoop() }");

		const odin = read("sdks/odin/electrobun.odin");
		expect(odin).toContain("g_quit_requested_stop_event_loop = core.symbols.stopEventLoop");
		expect(odin).toContain(
			"core.symbols.setQuitRequestedHandler(quit_requested_trampoline)",
		);
	});

	it("keeps a user handler ahead of the default", () => {
		expect(read("sdks/zig/electrobun.zig")).toContain(
			"if (quit_requested_user_handler) |handler| {",
		);
		expect(read("sdks/rust/electrobun.rs")).toContain(
			"let user = QUIT_REQUESTED_USER_HANDLER.load(Ordering::Acquire);",
		);
		expect(read("sdks/odin/electrobun.odin")).toContain(
			"if g_quit_requested_user_handler != nil {",
		);
	});

	it("stops the render loop of every native wgpu template on window close", () => {
		const templates = [
			"zig-wgpu/src/zig/main.zig",
			"odin-alchemy-wgpu/src/odin/main.odin",
			"odin-fluid-wgpu/src/odin/main.odin",
			"odin-jelly-bunny-wgpu/src/odin/main.odin",
			"odin-particles-wgpu/src/odin/main.odin",
			"odin-tree-wgpu/src/odin/main.odin",
			"go-maze-wgpu/src/go/main.go",
			"rust-flock-wgpu/src/main.rs",
		];

		for (const template of templates) {
			const source = readTemplate(template);
			expect(source).toMatch(
				/close\s*[:=]\s*(Some\()?\s*main_?window_?closed/i,
			);
		}
	});
});

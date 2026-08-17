import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(packageRoot, path), "utf8");

describe("native SDK path parity", () => {
	it("uses the Windows local app-data root for application data", () => {
		const rust = read("sdks/rust/electrobun.rs");
		const go = read("sdks/go/electrobun.go");

		expect(rust).toContain('std::env::var("LOCALAPPDATA")');
		expect(rust).toContain('join_path(home, "AppData/Local")');
		expect(go).toContain('os.Getenv("LOCALAPPDATA")');
		expect(go).toContain('filepath.Join(home, "AppData", "Local")');
	});

	it("scopes every native SDK by the launcher-attested install root", () => {
		const zig = read("sdks/zig/electrobun.zig");
		const rust = read("sdks/rust/electrobun.rs");
		const go = read("sdks/go/electrobun.go");
		const goRoot = read("sdks/go/install_root_name.go");
		const odin = read("sdks/odin/electrobun.odin");

		for (const source of [zig, rust, goRoot, odin]) {
			expect(source).toContain("ELECTROBUN_INSTALL_ROOT_NAME");
		}
		expect(zig).toContain(
			"effectiveInstallRootNameOwned(allocator, app_info.channel)",
		);
		expect(rust).toContain(
			"effective_install_root_name(&app_info.channel)",
		);
		expect(go).toContain("effectiveInstallRootName(appInfo.Channel)");
		expect(odin).toContain(
			"effective_install_root_name(allocator, app_info.channel)",
		);
	});

	it("feeds the same validated root to native browser profiles", () => {
		const core = read("core/main.zig");
		const launcher = read("launcher/main.zig");

		expect(core).toContain("installRootNameOverride()");
		expect(core).toContain("native_wrapper_state.start_event_loop(");
		expect(launcher).toContain(
			"uninstall.install_root_name_environment_variable",
		);
		expect(launcher).toContain("COTTONTAIL_ELECTROBUN_CHANNEL");
		expect(launcher).toContain("env_map.createWindowsBlock(");
		expect(launcher).toContain("CREATE_UNICODE_ENVIRONMENT");
	});
});

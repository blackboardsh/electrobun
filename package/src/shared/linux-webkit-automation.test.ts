import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const launcher = readFileSync(
	join(packageRoot, "launcher/main.zig"),
	"utf8",
);
const launcherAutomation = readFileSync(
	join(packageRoot, "launcher/automation.zig"),
	"utf8",
);
const nativeWrapper = readFileSync(
	join(packageRoot, "native/linux/nativeWrapper.cpp"),
	"utf8",
);

describe("Linux WebKitGTK automation contract", () => {
	it("requires the exact launcher opt-in and keeps it out of app argv", () => {
		expect(launcherAutomation).toContain('launcher_flag = "--automation"');
		expect(launcherAutomation).toContain(
			'std.mem.eql(u8, arg, launcher_flag)',
		);
		expect(launcher).toContain("automation.requested(launcher_args)");
		expect(launcher).toContain(
			'try env_map.put(automation.environment_variable, "1")',
		);
		expect(launcher).toContain(
			"automation.private_inspector_server_environment_variable",
		);
		expect(launcher).toContain(
			"env_map.swapRemove(automation.inspector_server_environment_variable)",
		);
		expect(launcher).not.toContain("argv = launcher_args");
	});

	it("enables one selected context and returns a controlled target", () => {
		expect(nativeWrapper).toContain(
			'kWebKitAutomationEnvironment = "ELECTROBUN_WEBKIT_AUTOMATION"',
		);
		expect(nativeWrapper).toContain('strcmp(value, "1") == 0');
		expect(nativeWrapper).toContain(
			'setenv("WEBKIT_INSPECTOR_SERVER", server, 1)',
		);
		expect(nativeWrapper).toContain(
			"unsetenv(kWebKitAutomationInspectorServerEnvironment)",
		);
		expect(nativeWrapper).toContain(
			"if (!g_webKitAutomationContext)",
		);
		expect(nativeWrapper).toContain(
			"return context == g_webKitAutomationContext;",
		);
		expect(nativeWrapper).toContain(
			'"is-controlled-by-automation", isControlledByAutomation ? TRUE : FALSE',
		);
		expect(nativeWrapper).toContain('"automation-started"');
		expect(nativeWrapper).toContain('"create-web-view"');
		expect(nativeWrapper).toContain(
			"webkit_automation_session_set_application_info(session, info)",
		);
		expect(nativeWrapper).toContain(
			"webkit_web_view_is_controlled_by_automation(g_webKitAutomationTarget)",
		);
		expect(nativeWrapper).toContain(
			"webkit_web_context_set_automation_allowed(context, TRUE)",
		);
	});
});

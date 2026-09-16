import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const trayDocs = readFileSync(
	join(
		import.meta.dirname,
		"../../../docs/src/content/docs/electrobun/apis/tray.mdx",
	),
	"utf8",
);
const nativeWrapper = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);

describe("Linux tray interaction contract", () => {
	it("documents menu actions without promising raw AppIndicator activation", () => {
		expect(trayDocs).toContain(
			"Ayatana AppIndicator backend supports tray menus and their actions",
		);
		expect(trayDocs).toMatch(
			/does not\s+expose raw primary icon activation/,
		);
		expect(trayDocs).toMatch(
			/Linux apps should use `setMenu\(\)` and handle\s+menu actions/,
		);
		expect(trayDocs).not.toContain(
			"Fired when the system tray icon is clicked, or when a menu item is clicked",
		);
		expect(trayDocs).not.toContain(
			"listen for the `tray-clicked` event, then show the menu",
		);

		const initialMenu = trayDocs.indexOf("updateTrayMenu();");
		const clickHandler = trayDocs.indexOf('tray.on("tray-clicked"');
		expect(initialMenu).toBeGreaterThan(-1);
		expect(clickHandler).toBeGreaterThan(-1);
		expect(initialMenu < clickHandler).toBe(true);
	});

	it("matches the current menu-only Ayatana AppIndicator implementation", () => {
		expect(nativeWrapper).toContain("app_indicator_new");
		expect(nativeWrapper).toContain("app_indicator_set_menu");
		expect(nativeWrapper).toContain(
			"g_signal_connect(menuItem, \"activate\", G_CALLBACK(onMenuItemActivate)",
		);
		expect(
			/g_signal_connect(?:_data)?\s*\(\s*indicator\s*,\s*"activate"/.test(
				nativeWrapper,
			),
		).toBe(false);
	});
});

import { ffi, type ApplicationMenuItemConfig } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import { roleLabelMap } from "./menuRoles";

type NonDividerMenuItem = {
	type?: "normal";
	label?: string;
	tooltip?: string;
	action?: string;
	role?: string;
	data?: unknown;
	submenu?: Array<ApplicationMenuItemConfig>;
	enabled?: boolean;
	checked?: boolean;
	hidden?: boolean;
	accelerator?: string;
};

/**
 * Install (or replace) the menu shown when the user right-clicks / long-presses
 * the Dock icon on macOS. Pass an empty array to clear the menu.
 *
 * No-op on Linux and Windows (the native layer stubs the call there).
 *
 * Listen for clicks with `Dock.on("application-dock-menu-clicked", ...)`.
 *
 * @example
 * Dock.setMenu([
 *   { type: "normal", label: "Play",     action: "toggle" },
 *   { type: "normal", label: "Next",     action: "next" },
 *   { type: "normal", label: "Previous", action: "prev" },
 * ]);
 * Dock.on("application-dock-menu-clicked", (event) => {
 *   console.log(event.data.action);
 * });
 */
export const setMenu = (menu: Array<ApplicationMenuItemConfig>): void => {
	const menuWithDefaults = menuConfigWithDefaults(menu);
	ffi.request.setApplicationDockMenu({
		menuConfig: JSON.stringify(menuWithDefaults),
	});
};

/**
 * Set the badge text shown on the Dock icon (macOS). Pass `null` or an empty
 * string to clear the badge. Typical values: unread counts ("3"), small
 * status indicators ("♪"), short labels ("!").
 *
 * No-op on Linux and Windows.
 */
export const setBadge = (text: string | null | undefined): void => {
	ffi.request.setDockBadge({ text: text ?? "" });
};

/**
 * Show a progress bar overlaid on the Dock icon (macOS). `progress` in the
 * closed interval `[0, 1]` shows the bar; pass `null` or any negative value
 * to clear it and restore the stock icon.
 *
 * Intended for long-running work like downloads, builds, imports, or media
 * playback position.
 *
 * No-op on Linux and Windows.
 */
export const setProgress = (progress: number | null | undefined): void => {
	const value = progress == null ? -1 : progress;
	ffi.request.setDockProgress({ progress: value });
};

/**
 * Subscribe to dock-menu clicks. Fired when the user selects an item from the
 * menu installed by `setMenu`. The event's `data.action` matches the `action`
 * field on the selected menu item.
 */
export const on = (
	name: "application-dock-menu-clicked",
	handler: (event: unknown) => void,
): void => {
	electrobunEventEmitter.on(name, handler);
};

const menuConfigWithDefaults = (
	menu: Array<ApplicationMenuItemConfig>,
): Array<ApplicationMenuItemConfig> => {
	return menu.map((item) => {
		if (item.type === "divider" || item.type === "separator") {
			return { type: "divider" } as const;
		}
		const menuItem = item as NonDividerMenuItem;
		const actionWithDataId = ffi.internal.serializeMenuAction(
			menuItem.action || "",
			menuItem.data,
		);

		return {
			label:
				menuItem.label ||
				roleLabelMap[menuItem.role as keyof typeof roleLabelMap] ||
				"",
			type: menuItem.type || "normal",
			...(menuItem.role
				? { role: menuItem.role }
				: { action: actionWithDataId }),
			enabled: menuItem.enabled === false ? false : true,
			checked: Boolean(menuItem.checked),
			hidden: Boolean(menuItem.hidden),
			tooltip: menuItem.tooltip || undefined,
			accelerator: menuItem.accelerator || undefined,
			...(menuItem.submenu
				? { submenu: menuConfigWithDefaults(menuItem.submenu) }
				: {}),
		};
	});
};

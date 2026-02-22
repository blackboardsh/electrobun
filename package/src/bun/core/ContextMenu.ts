import { ffi, type ContextMenuItemConfig } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";

type NonDividerMenuItem = {
	type?: "normal";
	label?: string;
	tooltip?: string;
	action?: string;
	data?: unknown;
	submenu?: Array<ContextMenuItemConfig>;
	enabled?: boolean;
	checked?: boolean;
	hidden?: boolean;
	accelerator?: string;
};

export const showContextMenu = (menu: Array<ContextMenuItemConfig>) => {
	const menuWithDefaults = menuConfigWithDefaults(menu);
	ffi.request.showContextMenu({
		menuConfig: JSON.stringify(menuWithDefaults),
	});
};

export const on = (
	name: "context-menu-clicked",
	handler: (event: unknown) => void,
) => {
	const specificName = `${name}`;
	electrobunEventEmitter.on(specificName, handler);
};

const menuConfigWithDefaults = (
	menu: Array<ContextMenuItemConfig>,
): Array<ContextMenuItemConfig> => {
	return menu.map((item) => {
		if (item.type === "divider" || item.type === "separator") {
			return { type: "divider" } as const;
		} else {
			const menuItem = item as NonDividerMenuItem;
			// Use shared serialization method
			const actionWithDataId = ffi.internal.serializeMenuAction(
				menuItem.action || "",
				menuItem.data,
			);

			return {
				label: menuItem.label || "",
				type: menuItem.type || "normal",
				action: actionWithDataId,
				// default enabled to true unless explicitly set to false
				enabled: menuItem.enabled === false ? false : true,
				checked: Boolean(menuItem.checked),
				hidden: Boolean(menuItem.hidden),
				tooltip: menuItem.tooltip || undefined,
				...(menuItem.accelerator ? { accelerator: menuItem.accelerator } : {}),
				...(menuItem.submenu
					? { submenu: menuConfigWithDefaults(menuItem.submenu) }
					: {}),
			};
		}
	});
};

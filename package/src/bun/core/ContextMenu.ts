// TODO: have a context specific menu that excludes role
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

export const showContextMenu = (menu: Array<ApplicationMenuItemConfig>) => {
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
	menu: Array<ApplicationMenuItemConfig>,
): Array<ApplicationMenuItemConfig> => {
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
				label:
					menuItem.label ||
					roleLabelMap[menuItem.role as keyof typeof roleLabelMap] ||
					"",
				type: menuItem.type || "normal",
				// application menus can either have an action or a role. not both.
				...(menuItem.role
					? { role: menuItem.role }
					: { action: actionWithDataId }),
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

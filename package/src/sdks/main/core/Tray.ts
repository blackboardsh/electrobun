import { ffi, type MenuItemConfig, type Rectangle } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import { VIEWS_FOLDER } from "./Paths";
import { join } from "path";

type NonDividerMenuItem = Exclude<
	MenuItemConfig,
	{ type: "divider" | "separator" }
>;

const TrayMap: { [id: number]: Tray } = {};

export type TrayOptions = {
	title?: string;
	image?: string;
	template?: boolean;
	width?: number;
	height?: number;
};

export class Tray {
	id = 0;
	visible = false;
	title = "";
	image = "";
	template = true;
	width = 16;
	height = 16;
	menu: Array<MenuItemConfig> | null = null;

	constructor({
		title = "",
		image = "",
		template = true,
		width = 16,
		height = 16,
	}: TrayOptions = {}) {
		this.title = title;
		this.image = image;
		this.template = template;
		this.width = width;
		this.height = height;

		if (this.createNativeTray()) {
			TrayMap[this.id] = this;
		}
	}

	private createNativeTray(): boolean {
		try {
			const trayId = ffi.request.createTray({
				title: this.title,
				image: this.resolveImagePath(this.image),
				template: this.template,
				width: this.width,
				height: this.height,
			}) as number;

			if (!trayId) {
				throw new Error("Tray creation returned an invalid id");
			}

			this.id = trayId;
			this.visible = true;
			return true;
		} catch (error) {
			console.warn("Tray creation failed:", error);
			console.warn(
				"System tray functionality may not be available on this platform",
			);
			this.visible = false;
			return false;
		}
	}

	resolveImagePath(imgPath: string) {
		if (imgPath.startsWith("views://")) {
			return join(VIEWS_FOLDER, imgPath.replace("views://", ""));
		} else {
			// can specify any file path here
			return imgPath;
		}
	}

	setTitle(title: string) {
		this.title = title;
		if (!this.id) return;
		ffi.request.setTrayTitle({ id: this.id, title });
	}

	setImage(imgPath: string) {
		this.image = imgPath;
		if (!this.id) return;
		ffi.request.setTrayImage({
			id: this.id,
			image: this.resolveImagePath(imgPath),
		});
	}

	setMenu(menu: Array<MenuItemConfig>) {
		this.menu = menu;
		if (!this.id) return;
		const menuWithDefaults = menuConfigWithDefaults(menu);
		ffi.request.setTrayMenu({
			id: this.id,
			menuConfig: JSON.stringify(menuWithDefaults),
		});
	}

	on(name: "tray-clicked", handler: (event: unknown) => void) {
		const specificName = `${name}-${this.id}`;
		electrobunEventEmitter.on(specificName, handler);
	}

	setVisible(visible: boolean) {
		if (visible === this.visible) {
			return;
		}

		if (!visible) {
			if (this.id) ffi.request.hideTray({ id: this.id });
			this.visible = false;
			return;
		}

		if (!this.id) {
			if (this.createNativeTray()) {
				TrayMap[this.id] = this;
			}
			return;
		}

		this.visible = ffi.request.showTray({ id: this.id }) as boolean;
	}

	getBounds(): Rectangle {
		return ffi.request.getTrayBounds({ id: this.id });
	}

	remove() {
		console.log("Tray.remove() called for id:", this.id);
		const trayId = this.id;
		if (trayId) {
			ffi.request.removeTray({ id: trayId });
		}
		this.visible = false;
		delete TrayMap[trayId];
		this.id = 0;
		console.log("Tray removed from TrayMap");
	}

	static getById(id: number) {
		return TrayMap[id];
	}

	static getAll() {
		return Object.values(TrayMap);
	}

	static removeById(id: number) {
		const tray = TrayMap[id];
		if (tray) {
			tray.remove();
		}
	}
}

const menuConfigWithDefaults = (
	menu: Array<MenuItemConfig>,
): Array<MenuItemConfig> => {
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
				...(menuItem.submenu
					? { submenu: menuConfigWithDefaults(menuItem.submenu) }
					: {}),
			};
		}
	});
};

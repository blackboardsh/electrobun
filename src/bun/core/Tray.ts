import { zigRPC, type MenuItemConfig } from "../proc/zig";
import electrobunEventEmitter from "../events/eventEmitter";

let nextTrayId = 1;
const TrayMap = {};

type ConstructorOptions = {
  title?: string;
  image?: string;
};

export class Tray {
  id: number = nextTrayId++;

  constructor({ title = "", image = "" }: ConstructorOptions = {}) {
    zigRPC.request.createTray({ id: this.id, title, image });

    TrayMap[this.id] = this;
  }

  setTitle(title: string) {
    zigRPC.request.setTrayTitle({ id: this.id, title });
  }

  setImage(image: string) {
    zigRPC.request.setTrayImage({ id: this.id, image });
  }

  setMenu(menu: Array<MenuItemConfig>) {
    const menuWithDefaults = menuConfigWithDefaults(menu);
    zigRPC.request.setTrayMenu({
      id: this.id,
      menuConfig: JSON.stringify(menuWithDefaults),
    });
  }

  on(name: "tray-clicked", handler) {
    const specificName = `${name}-${this.id}`;
    electrobunEventEmitter.on(specificName, handler);
  }

  static getById(id: number) {
    return TrayMap[id];
  }

  static getAll() {
    return Object.values(TrayMap);
  }
}

const menuConfigWithDefaults = (
  menu: Array<MenuItemConfig>
): Array<MenuItemConfig> => {
  return menu.map((item) => {
    if (item.type === "divider" || item.type === "separator") {
      return { type: "divider" };
    } else {
      return {
        label: item.label || "",
        type: item.type || "normal",
        action: item.action || "",
        // default enabled to true unless explicitly set to false
        enabled: item.enabled === false ? false : true,
        checked: Boolean(item.checked),
        hidden: Boolean(item.hidden),
        tooltip: item.tooltip || undefined,
        ...(item.submenu
          ? { submenu: menuConfigWithDefaults(item.submenu) }
          : {}),
      };
    }
  });
};

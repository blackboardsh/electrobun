import { ffi, type MenuItemConfig } from "../proc/zig";
import electrobunEventEmitter from "../events/eventEmitter";
import { VIEWS_FOLDER } from "./Paths";
import { join } from "path";
import {FFIType} from 'bun:ffi';

let nextTrayId = 1;
const TrayMap = {};

type ConstructorOptions = {
  title?: string;
  image?: string;
  template?: boolean;
  width?: number;
  height?: number;
};

export class Tray {
  id: number = nextTrayId++;
  ptr: FFIType.ptr;

  constructor({
    title = "",
    image = "",
    template = true,
    width = 16,
    height = 16,
  }: ConstructorOptions = {}) {
    console.log("img", image);
    console.log("img", this.resolveImagePath(image));
    this.ptr = ffi.request.createTray({
      id: this.id,
      title,
      image: this.resolveImagePath(image),
      template,
      width,
      height,
    });

    TrayMap[this.id] = this;
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
    ffi.request.setTrayTitle({ id: this.id, title });
  }

  setImage(imgPath: string) {
    ffi.request.setTrayImage({
      id: this.id,
      image: this.resolveImagePath(imgPath),
    });
  }

  setMenu(menu: Array<MenuItemConfig>) {
    const menuWithDefaults = menuConfigWithDefaults(menu);
    ffi.request.setTrayMenu({
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

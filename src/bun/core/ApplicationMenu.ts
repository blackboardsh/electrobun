import { zigRPC, type ApplicationMenuItemConfig } from "../proc/zig";
import electrobunEventEmitter from "../events/eventEmitter";

export const setApplicationMenu = (menu: Array<ApplicationMenuItemConfig>) => {
  const menuWithDefaults = menuConfigWithDefaults(menu);
  zigRPC.request.setApplicationMenu({
    menuConfig: JSON.stringify(menuWithDefaults),
  });
};

export const on = (name: "application-menu-clicked", handler) => {
  const specificName = `${name}`;
  electrobunEventEmitter.on(specificName, handler);
};

const roleLabelMap = {
  quit: "Quit",
  hide: "Hide",
  hideOthers: "Hide Others",
  showAll: "Show All",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  pasteAndMatchStyle: "Paste And Match Style",
  delete: "Delete",
  selectAll: "Select All",
  startSpeaking: "Start Speaking",
  stopSpeaking: "Stop Speaking",
  enterFullScreen: "Enter FullScreen",
  exitFullScreen: "Exit FullScreen",
  toggleFullScreen: "Toggle Full Screen",
  minimize: "Minimize",
  zoom: "Zoom",
  bringAllToFront: "Bring All To Front",
  close: "Close",
  cycleThroughWindows: "Cycle Through Windows",
  showHelp: "Show Help",
};

const menuConfigWithDefaults = (
  menu: Array<ApplicationMenuItemConfig>
): Array<ApplicationMenuItemConfig> => {
  return menu.map((item) => {
    if (item.type === "divider" || item.type === "separator") {
      return { type: "divider" };
    } else {
      return {
        label: item.label || roleLabelMap[item.role] || "",
        type: item.type || "normal",
        // application menus can either have an action or a role. not both.
        ...(item.role ? { role: item.role } : { action: item.action || "" }),
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

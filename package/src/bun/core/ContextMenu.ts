// TODO: have a context specific menu that excludes role
import { ffi, type ApplicationMenuItemConfig } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";

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

export const on = (name: "context-menu-clicked", handler: (event: unknown) => void) => {
  const specificName = `${name}`;
  electrobunEventEmitter.on(specificName, handler);
};

// todo: Consolidate Application menu, context menu, and tray menus can all have roles.
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
      return { type: "divider" } as const;
    } else {
      const menuItem = item as NonDividerMenuItem;
      // Use shared serialization method
      const actionWithDataId = ffi.internal.serializeMenuAction(menuItem.action || "", menuItem.data);

      return {
        label: menuItem.label || roleLabelMap[menuItem.role as keyof typeof roleLabelMap] || "",
        type: menuItem.type || "normal",
        // application menus can either have an action or a role. not both.
        ...(menuItem.role ? { role: menuItem.role } : { action: actionWithDataId }),
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

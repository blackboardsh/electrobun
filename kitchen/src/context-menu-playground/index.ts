import Electrobun, { Electroview } from "electrobun/view";

interface MenuConfig {
  id: string;
  title: string;
  menu: any[];
}

const menuConfigs: MenuConfig[] = [
  {
    id: "menu1",
    title: "Basic Menu",
    menu: [
      { label: "Action 1", action: "action-1" },
      { label: "Action 2", action: "action-2" },
      { type: "separator" },
      { label: "Action 3", action: "action-3" },
    ],
  },
  {
    id: "menu2",
    title: "With Custom Data",
    menu: [
      { label: "Copy", role: "copy" },
      { label: "Paste", role: "paste" },
      { type: "separator" },
      {
        label: "Item with number data",
        action: "custom-data-1",
        data: { value: 42 },
      },
      {
        label: "Item with string data",
        action: "custom-data-2",
        data: { message: "Hello from context menu!" },
      },
      {
        label: "Item with object data",
        action: "custom-data-3",
        data: { user: "test", id: 123, active: true },
      },
    ],
  },
  {
    id: "menu3",
    title: "Submenus",
    menu: [
      {
        label: "File",
        submenu: [
          { label: "New", action: "file-new" },
          { label: "Open", action: "file-open" },
          { label: "Save", action: "file-save" },
          { type: "separator" },
          { label: "Export", action: "file-export" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
        ],
      },
      { type: "separator" },
      { label: "Preferences...", action: "prefs" },
    ],
  },
  {
    id: "menu4",
    title: "Disabled Items",
    menu: [
      { label: "Enabled Action", action: "enabled-1" },
      { label: "Disabled Action", action: "disabled-1", enabled: false },
      { type: "separator" },
      { label: "Another Enabled", action: "enabled-2" },
      { label: "Another Disabled", action: "disabled-2", enabled: false },
      { type: "separator" },
      {
        label: "Submenu with disabled",
        submenu: [
          { label: "Enabled in sub", action: "sub-enabled" },
          { label: "Disabled in sub", action: "sub-disabled", enabled: false },
        ],
      },
    ],
  },
];

const rpc = Electroview.defineRPC<any>({
  maxRequestTime: 600000,
  handlers: {
    requests: {},
    messages: {
      contextMenuClicked: (eventData: {
        action?: string;
        role?: string;
        data?: any;
      }) => {
        addLogEntry(eventData.action || eventData.role || "unknown", eventData.data);
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

let currentMenuId = "menu1";

function addLogEntry(action: string, data?: any) {
  const log = document.getElementById("eventLog");
  if (!log) return;

  const placeholder = log.querySelector(".log-placeholder");
  if (placeholder) placeholder.remove();

  const entry = document.createElement("div");
  entry.className = "log-entry";

  const now = new Date();
  const timestamp = now.toLocaleTimeString();

  let html = `<span class="timestamp">${timestamp}</span> Clicked: <span class="action">${action}</span>`;

  if (data) {
    html += `<span class="data">Data: ${JSON.stringify(data)}</span>`;
  }

  entry.innerHTML = html;
  log.insertBefore(entry, log.firstChild);
}

function showContextMenu(menuId: string) {
  const config = menuConfigs.find((c) => c.id === menuId);
  if (!config) return;

  electrobun.rpc?.request.showContextMenu({ menu: config.menu });
  addLogEntry(`Showing: ${config.title}`);
}

function setActiveButton(menuId: string) {
  document.querySelectorAll(".menu-btn").forEach((btn) => {
    btn.classList.remove("active");
  });
  document.getElementById(menuId)?.classList.add("active");
}

document.addEventListener("DOMContentLoaded", () => {
  // Done button
  document.getElementById("doneBtn")?.addEventListener("click", () => {
    electrobun.rpc?.request.closeWindow({});
  });

  // Clear log button
  document.getElementById("clearLog")?.addEventListener("click", () => {
    const log = document.getElementById("eventLog");
    if (log) {
      log.innerHTML =
        '<div class="log-placeholder">Context menu click events will appear here...</div>';
    }
  });

  // Menu buttons - click to show that menu
  menuConfigs.forEach((config) => {
    document.getElementById(config.id)?.addEventListener("click", () => {
      currentMenuId = config.id;
      setActiveButton(config.id);
      showContextMenu(config.id);
    });
  });

  // Right-click in test area shows current menu
  document.getElementById("testArea")?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(currentMenuId);
  });

  // Set initial active state
  setActiveButton(currentMenuId);
});

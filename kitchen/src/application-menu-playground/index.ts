import Electrobun, { Electroview } from "electrobun/view";

interface MenuConfig {
  id: string;
  title: string;
  description: string[];
  menu: any[];
}

const menuConfigs: MenuConfig[] = [
  {
    id: "config1",
    title: "Basic Menu",
    description: [
      'Test menu with "Click Me!" item (Cmd+T)',
      "Includes a disabled item",
      "Try the keyboard shortcut!",
    ],
    menu: [
      {
        submenu: [{ label: "Quit", role: "quit", accelerator: "q" }],
      },
      {
        label: "Test",
        submenu: [
          {
            label: "Click Me!",
            action: "test-action",
            accelerator: "CommandOrControl+T",
          },
          { type: "separator" },
          { label: "Disabled Item", action: "disabled", enabled: false },
        ],
      },
    ],
  },
  {
    id: "config2",
    title: "Checkboxes",
    description: [
      "Options menu with checkbox items",
      "Option A has a checkmark",
      "Option B does not have a checkmark",
      "Note: checkmarks are display-only",
    ],
    menu: [
      {
        submenu: [{ label: "Quit", role: "quit" }],
      },
      {
        label: "Options",
        submenu: [
          { label: "Option A (checked)", action: "opt-a", checked: true },
          { label: "Option B", action: "opt-b", checked: false },
          { type: "separator" },
          { label: "Toggle Me", action: "toggle", checked: true },
        ],
      },
    ],
  },
  {
    id: "config3",
    title: "Nested Submenus",
    description: [
      "Navigate menu with nested hierarchy",
      'Hover over "Level 1" to see submenu',
      'Hover over "Level 2" for deeper nesting',
      "Test navigation through all levels",
    ],
    menu: [
      {
        submenu: [{ label: "Quit", role: "quit" }],
      },
      {
        label: "Navigate",
        submenu: [
          {
            label: "Level 1",
            submenu: [
              { label: "Item 1A", action: "1a" },
              {
                label: "Level 2",
                submenu: [
                  { label: "Item 2A", action: "2a" },
                  { label: "Item 2B", action: "2b" },
                ],
              },
            ],
          },
          {
            label: "Another Branch",
            submenu: [{ label: "Branch Item", action: "branch" }],
          },
        ],
      },
    ],
  },
  {
    id: "config4",
    title: "Standard Roles",
    description: [
      "Edit menu with system roles",
      "Undo, Redo, Cut, Copy, Paste, Select All",
      "Uses native accelerators (Cmd+Z, Cmd+C, etc.)",
      "About item in app menu",
    ],
    menu: [
      {
        submenu: [
          { label: "About", role: "about" },
          { type: "separator" },
          { label: "Quit", role: "quit" },
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
          { role: "selectAll" },
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
      menuClicked: (data: { action?: string; role?: string }) => {
        addLogEntry(data.action || data.role || "unknown");
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

let currentConfig = "config1";

function addLogEntry(action: string) {
  const log = document.getElementById("eventLog");
  if (!log) return;

  const placeholder = log.querySelector(".log-placeholder");
  if (placeholder) placeholder.remove();

  const entry = document.createElement("div");
  entry.className = "log-entry";

  const now = new Date();
  const timestamp = now.toLocaleTimeString();

  entry.innerHTML = `<span class="timestamp">${timestamp}</span> Menu clicked: <span class="action">${action}</span>`;

  log.insertBefore(entry, log.firstChild);
}

function updateConfigDetails(configId: string) {
  const config = menuConfigs.find((c) => c.id === configId);
  if (!config) return;

  const details = document.getElementById("configDetails");
  if (!details) return;

  details.innerHTML = `
    <p><strong>${config.title}</strong></p>
    <ul>
      ${config.description.map((d) => `<li>${d}</li>`).join("")}
    </ul>
  `;
}

function setActiveButton(configId: string) {
  document.querySelectorAll(".config-btn").forEach((btn) => {
    btn.classList.remove("active");
  });
  document.getElementById(configId)?.classList.add("active");
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
        '<div class="log-placeholder">Menu click events will appear here...</div>';
    }
  });

  // Config buttons
  menuConfigs.forEach((config) => {
    document.getElementById(config.id)?.addEventListener("click", () => {
      currentConfig = config.id;
      setActiveButton(config.id);
      updateConfigDetails(config.id);
      electrobun.rpc?.request.setApplicationMenu({ menu: config.menu });
      addLogEntry(`Applied config: ${config.title}`);
    });
  });

  // Apply initial config
  const initialConfig = menuConfigs[0];
  electrobun.rpc?.request.setApplicationMenu({ menu: initialConfig.menu });
});

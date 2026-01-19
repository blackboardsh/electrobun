import Electrobun, { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<any>({
  maxRequestTime: 600000,
  handlers: {
    requests: {},
    messages: {},
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// DOM elements
let acceleratorInput: HTMLInputElement;
let registerBtn: HTMLButtonElement;
let unregisterBtn: HTMLButtonElement;
let unregisterAllBtn: HTMLButtonElement;
let activeShortcutsEl: HTMLElement;
let eventLogEl: HTMLElement;
let clearLogBtn: HTMLButtonElement;

// Track registered shortcuts
const registeredShortcuts: Map<string, { count: number }> = new Map();

function init() {
  acceleratorInput = document.getElementById("accelerator") as HTMLInputElement;
  registerBtn = document.getElementById("registerBtn") as HTMLButtonElement;
  unregisterBtn = document.getElementById("unregisterBtn") as HTMLButtonElement;
  activeShortcutsEl = document.getElementById("activeShortcuts") as HTMLElement;
  eventLogEl = document.getElementById("eventLog") as HTMLElement;
  clearLogBtn = document.getElementById("clearLogBtn") as HTMLButtonElement;

  unregisterAllBtn = document.getElementById("unregisterAllBtn") as HTMLButtonElement;

  registerBtn.addEventListener("click", registerShortcut);
  unregisterBtn.addEventListener("click", unregisterCurrent);
  unregisterAllBtn.addEventListener("click", unregisterAllShortcuts);
  clearLogBtn.addEventListener("click", clearLog);
  document.getElementById("doneBtn")?.addEventListener("click", () => {
    electrobun.rpc?.request.closeWindow({});
  });

  // Setup preset buttons
  document.querySelectorAll(".preset-btn[data-accelerator]").forEach((btn) => {
    btn.addEventListener("click", () => {
      acceleratorInput.value = (btn as HTMLElement).dataset.accelerator || "";
    });
  });
}

async function registerShortcut() {
  const accelerator = acceleratorInput.value.trim();
  if (!accelerator) {
    addLog("Please enter an accelerator", "error");
    return;
  }

  if (registeredShortcuts.has(accelerator)) {
    addLog(`Already registered: ${accelerator}`, "warn");
    return;
  }

  try {
    const result = await electrobun.rpc?.request.registerShortcut({ accelerator });
    if (result.success) {
      registeredShortcuts.set(accelerator, { count: 0 });
      addLog(`Registered: ${accelerator}`, "success");
      updateActiveShortcuts();
    } else {
      addLog(`Failed to register: ${accelerator}`, "error");
    }
  } catch (err) {
    addLog(`Error: ${err}`, "error");
  }
}

async function unregisterCurrent() {
  const accelerator = acceleratorInput.value.trim();
  if (!accelerator) return;

  if (!registeredShortcuts.has(accelerator)) {
    addLog(`Not registered: ${accelerator}`, "warn");
    return;
  }

  try {
    await electrobun.rpc?.request.unregisterShortcut({ accelerator });
    registeredShortcuts.delete(accelerator);
    addLog(`Unregistered: ${accelerator}`, "info");
    updateActiveShortcuts();
  } catch (err) {
    addLog(`Error: ${err}`, "error");
  }
}

async function unregisterByAccelerator(accelerator: string) {
  try {
    await electrobun.rpc?.request.unregisterShortcut({ accelerator });
    registeredShortcuts.delete(accelerator);
    addLog(`Unregistered: ${accelerator}`, "info");
    updateActiveShortcuts();
  } catch (err) {
    addLog(`Error: ${err}`, "error");
  }
}

async function unregisterAllShortcuts() {
  if (registeredShortcuts.size === 0) {
    addLog("No shortcuts to unregister", "warn");
    return;
  }

  try {
    await electrobun.rpc?.request.unregisterAllShortcuts({});
    const count = registeredShortcuts.size;
    registeredShortcuts.clear();
    addLog(`Unregistered all ${count} shortcuts`, "success");
    updateActiveShortcuts();
  } catch (err) {
    addLog(`Error: ${err}`, "error");
  }
}

function updateActiveShortcuts() {
  if (registeredShortcuts.size === 0) {
    activeShortcutsEl.innerHTML = `<span class="placeholder">No shortcuts registered yet.</span>`;
    return;
  }

  const html = Array.from(registeredShortcuts.entries())
    .map(([acc, data]) => `
      <div class="shortcut-item">
        <span class="accelerator">${escapeHtml(acc)}</span>
        <span class="count">Triggers: ${data.count}</span>
        <button class="remove-btn" data-accelerator="${escapeHtml(acc)}">Remove</button>
      </div>
    `)
    .join("");

  activeShortcutsEl.innerHTML = html;

  // Add click handlers for remove buttons
  activeShortcutsEl.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const acc = (btn as HTMLElement).dataset.accelerator;
      if (acc) unregisterByAccelerator(acc);
    });
  });
}

function addLog(message: string, type: "success" | "error" | "warn" | "info" | "trigger" = "info") {
  const placeholder = eventLogEl.querySelector(".placeholder");
  if (placeholder) placeholder.remove();

  const time = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = "log-entry";

  let color = "#fff";
  if (type === "success") color = "#4ade80";
  else if (type === "error") color = "#f87171";
  else if (type === "warn") color = "#fbbf24";
  else if (type === "trigger") color = "#a5b4fc";

  entry.innerHTML = `<span class="time">${time}</span><span style="color: ${color}">${escapeHtml(message)}</span>`;
  eventLogEl.insertBefore(entry, eventLogEl.firstChild);

  // Keep only last 30 entries
  while (eventLogEl.children.length > 30) {
    eventLogEl.removeChild(eventLogEl.lastChild!);
  }
}

function clearLog() {
  eventLogEl.innerHTML = `<span class="placeholder">Shortcut triggers will appear here...</span>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Listen for shortcut triggers from bun
electrobun.rpc?.addMessageListener("shortcutTriggered", (data: { accelerator: string }) => {
  const shortcut = registeredShortcuts.get(data.accelerator);
  if (shortcut) {
    shortcut.count++;
    addLog(`Triggered: ${data.accelerator} (count: ${shortcut.count})`, "trigger");
    updateActiveShortcuts();
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

import Electrobun, { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<any>({
  maxRequestTime: 600000, // 10 minutes for interactive exploration
  handlers: {
    requests: {},
    messages: {},
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// DOM elements
let trayTitleInput: HTMLInputElement;
let showMenuCheckbox: HTMLInputElement;
let hasSubmenuCheckbox: HTMLInputElement;
let newTitleInput: HTMLInputElement;
let eventLog: HTMLElement;

function init() {
  trayTitleInput = document.getElementById("trayTitle") as HTMLInputElement;
  showMenuCheckbox = document.getElementById("showMenu") as HTMLInputElement;
  hasSubmenuCheckbox = document.getElementById("hasSubmenu") as HTMLInputElement;
  newTitleInput = document.getElementById("newTitle") as HTMLInputElement;
  eventLog = document.getElementById("eventLog") as HTMLElement;

  document.getElementById("createTrayBtn")?.addEventListener("click", createTray);
  document.getElementById("updateTitleBtn")?.addEventListener("click", updateTitle);
  document.getElementById("startCounterBtn")?.addEventListener("click", startCounter);
  document.getElementById("stopCounterBtn")?.addEventListener("click", stopCounter);
  document.getElementById("removeTrayBtn")?.addEventListener("click", removeTray);
  document.getElementById("doneBtn")?.addEventListener("click", () => {
    electrobun.rpc?.request.closeWindow({});
  });
}

function addLog(message: string) {
  const time = new Date().toLocaleTimeString();
  const placeholder = eventLog.querySelector(".placeholder");
  if (placeholder) placeholder.remove();

  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.innerHTML = `<span class="time">${time}</span>${message}`;
  eventLog.insertBefore(entry, eventLog.firstChild);

  // Keep only last 20 entries
  while (eventLog.children.length > 20) {
    eventLog.removeChild(eventLog.lastChild!);
  }
}

async function createTray() {
  try {
    await electrobun.rpc?.request.createTray({
      title: trayTitleInput.value || "Test Tray",
      showMenu: showMenuCheckbox.checked,
      hasSubmenu: hasSubmenuCheckbox.checked,
    });
    addLog(`Created tray: "${trayTitleInput.value}"`);
  } catch (err) {
    addLog(`Error: ${err}`);
  }
}

async function updateTitle() {
  try {
    await electrobun.rpc?.request.updateTitle({
      title: newTitleInput.value,
    });
    addLog(`Updated title to: "${newTitleInput.value}"`);
  } catch (err) {
    addLog(`Error: ${err}`);
  }
}

async function startCounter() {
  try {
    await electrobun.rpc?.request.startCounter({});
    addLog("Started counter");
  } catch (err) {
    addLog(`Error: ${err}`);
  }
}

async function stopCounter() {
  try {
    await electrobun.rpc?.request.stopCounter({});
    addLog("Stopped counter");
  } catch (err) {
    addLog(`Error: ${err}`);
  }
}

async function removeTray() {
  try {
    await electrobun.rpc?.request.removeTray({});
    addLog("Removed tray");
  } catch (err) {
    addLog(`Error: ${err}`);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

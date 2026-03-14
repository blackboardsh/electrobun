import { existsSync } from "node:fs";

const phases = [
  { icon: "C", label: "Forrager: Calm", body: "Background Carrot idling in the tray." },
  { icon: "*", label: "Forrager: Focus", body: "Forrager switched to focus mode." },
  { icon: "!", label: "Forrager: Signal", body: "Forrager has something to tell you." },
];

let phaseIndex = 0;
let statePath = "";
let permissions = new Set();

function post(message) {
  self.postMessage(message);
}

function log(message) {
  post({ type: "action", action: "log", payload: { message } });
}

async function saveState() {
  if (!statePath) return;
  await Bun.write(statePath, JSON.stringify({ phaseIndex }, null, 2));
}

async function loadState() {
  if (!statePath || !existsSync(statePath)) return;
  try {
    const parsed = await Bun.file(statePath).json();
    if (typeof parsed.phaseIndex === "number") {
      phaseIndex = Math.max(0, Math.min(phases.length - 1, parsed.phaseIndex));
    }
  } catch (error) {
    log(`state load failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function currentPhase() {
  return phases[phaseIndex];
}

function syncUI() {
  post({ type: "action", action: "emit-view", payload: { name: "status", payload: { phaseIndex, ...currentPhase() } } });
}

function syncTray() {
  if (!permissions.has("host:tray")) return;
  post({ type: "action", action: "set-tray", payload: { title: currentPhase().label } });
  post({
    type: "action",
    action: "set-tray-menu",
    payload: [
      { type: "normal", label: "Cycle Forrager", action: "cycle" },
      { type: "normal", label: "Ping Me", action: "ping" },
      { type: "divider" },
      { type: "normal", label: "Stop Forrager", action: "stop" }
    ]
  });
  syncUI();
}

async function cycle() {
  phaseIndex = (phaseIndex + 1) % phases.length;
  await saveState();
  syncTray();
  log(`phase changed to ${currentPhase().label}`);
}

function notifyPing() {
  if (!permissions.has("host:notifications")) return;
  const phase = currentPhase();
  post({
    type: "action",
    action: "notify",
    payload: {
      title: phase.label,
      body: phase.body,
    },
  });
}

self.onmessage = async (event) => {
  const message = event.data;

  if (message.type === "init") {
    permissions = new Set(message.context.permissions || []);
    statePath = message.context.statePath;
    await loadState();
    post({ type: "ready" });
    syncTray();
    log("worker initialized");
    return;
  }

  if (message.type === "event") {
    if (message.name === "boot") {
      syncTray();
      return;
    }
    if (message.name === "tray") {
      const action = message.payload?.action;
      if (action === "cycle") {
        await cycle();
      } else if (action === "ping") {
        notifyPing();
      } else if (action === "stop") {
        post({ type: "action", action: "stop-carrot" });
      } else {
        await cycle();
      }
    }
    return;
  }

  if (message.type !== "request") {
    return;
  }

  try {
    switch (message.method) {
      case "boot": {
        syncTray();
        post({ type: "response", requestId: message.requestId, success: true, payload: { phaseIndex, ...currentPhase() } });
        break;
      }
      case "getStatus": {
        post({ type: "response", requestId: message.requestId, success: true, payload: { phaseIndex, ...currentPhase() } });
        break;
      }
      case "cycle": {
        await cycle();
        post({ type: "response", requestId: message.requestId, success: true, payload: { phaseIndex, ...currentPhase() } });
        break;
      }
      default:
        post({ type: "response", requestId: message.requestId, success: false, error: `Unknown method: ${message.method}` });
        break;
    }
  } catch (error) {
    post({
      type: "response",
      requestId: message.requestId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

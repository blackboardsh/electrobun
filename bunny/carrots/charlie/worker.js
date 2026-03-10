import { existsSync } from "node:fs";

let statePath = "";
let permissions = new Set();
let state = {
  count: 0,
  lastUpdatedAt: null,
};

function post(message) {
  self.postMessage(message);
}

function emitView(name, payload) {
  post({ type: "action", action: "emit-view", payload: { name, payload } });
}

function log(message) {
  post({ type: "action", action: "log", payload: { message } });
}

async function saveState() {
  if (!statePath) return;
  await Bun.write(statePath, JSON.stringify(state, null, 2));
}

async function loadState() {
  if (!statePath || !existsSync(statePath)) return;
  try {
    state = await Bun.file(statePath).json();
  } catch (error) {
    log(`state load failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function snapshot() {
  return {
    count: state.count,
    lastUpdatedAt: state.lastUpdatedAt,
    permissions: Array.from(permissions),
  };
}

async function notifyMilestone() {
  if (!permissions.has("notifications")) return;
  post({
    type: "action",
    action: "notify",
    payload: {
      title: "Charlie hit a milestone",
      body: `Charlie just reached ${state.count}.`,
    },
  });
}

self.onmessage = async (event) => {
  const message = event.data;

  if (message.type === "init") {
    statePath = message.context.statePath;
    permissions = new Set(message.context.permissions || []);
    await loadState();
    post({ type: "ready" });
    emitView("state", snapshot());
    log("worker initialized");
    return;
  }

  if (message.type === "event") {
    if (message.name === "boot") {
      emitView("state", snapshot());
    }
    return;
  }

  if (message.type !== "request") {
    return;
  }

  try {
    switch (message.method) {
      case "getSnapshot": {
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "increment": {
        state.count += 1;
        state.lastUpdatedAt = new Date().toISOString();
        await saveState();
        emitView("state", snapshot());
        log(`count incremented to ${state.count}`);
        if (state.count % 5 === 0) {
          await notifyMilestone();
        }
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "reset": {
        state.count = 0;
        state.lastUpdatedAt = new Date().toISOString();
        await saveState();
        emitView("state", snapshot());
        log("counter reset");
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      }
      case "notify": {
        if (permissions.has("notifications")) {
          post({
            type: "action",
            action: "notify",
            payload: {
              title: "Hello from Charlie",
              body: `Current count: ${state.count}`,
            },
          });
        }
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
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

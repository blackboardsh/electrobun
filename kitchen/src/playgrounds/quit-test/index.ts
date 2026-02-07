import Electrobun, { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<any>({
  maxRequestTime: 600000,
  handlers: {
    requests: {},
    messages: {},
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

let eventLogEl: HTMLElement;

function addLog(message: string, type: "success" | "error" | "info" = "info") {
  const placeholder = eventLogEl.querySelector(".placeholder");
  if (placeholder) placeholder.remove();

  const time = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = "log-entry";

  let color = "#fff";
  if (type === "success") color = "#4ade80";
  else if (type === "error") color = "#f87171";

  entry.innerHTML = `<span class="time">${time}</span><span style="color: ${color}">${escapeHtml(message)}</span>`;
  eventLogEl.insertBefore(entry, eventLogEl.firstChild);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function init() {
  eventLogEl = document.getElementById("eventLog") as HTMLElement;

  document.getElementById("doneBtn")?.addEventListener("click", () => {
    (electrobun.rpc as any)?.request.closeWindow({});
  });

  document.getElementById("utilsQuitBtn")?.addEventListener("click", async () => {
    addLog("Requesting Utils.quit()...", "info");
    try {
      await (electrobun.rpc as any)?.request.triggerQuit({ mode: "utils-quit" });
    } catch {
      addLog("RPC failed (app may have quit)", "info");
    }
  });

  document.getElementById("processExitBtn")?.addEventListener("click", async () => {
    addLog("Requesting process.exit(0)...", "info");
    try {
      await (electrobun.rpc as any)?.request.triggerQuit({ mode: "process-exit" });
    } catch {
      addLog("RPC failed (app may have quit)", "info");
    }
  });

  document.getElementById("clearLogBtn")?.addEventListener("click", () => {
    eventLogEl.innerHTML = `<span class="placeholder">Events will appear here...</span>`;
  });
}

// Listen for messages from bun (beforeQuit handler sends these)
(electrobun.rpc as any)?.addMessageListener("beforeQuitFired", (data: { message: string }) => {
  addLog(data.message, "success");
});

(electrobun.rpc as any)?.addMessageListener("beforeQuitDone", (data: { message: string }) => {
  addLog(data.message, "success");
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

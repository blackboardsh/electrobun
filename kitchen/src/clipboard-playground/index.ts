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
let readBtn: HTMLButtonElement;
let writeBtn: HTMLButtonElement;
let doneBtn: HTMLButtonElement;
let readResult: HTMLElement;
let formatsEl: HTMLElement;
let writeText: HTMLTextAreaElement;
let writeStatus: HTMLElement;
let eventLog: HTMLElement;

function init() {
  readBtn = document.getElementById("readBtn") as HTMLButtonElement;
  writeBtn = document.getElementById("writeBtn") as HTMLButtonElement;
  doneBtn = document.getElementById("doneBtn") as HTMLButtonElement;
  readResult = document.getElementById("readResult") as HTMLElement;
  formatsEl = document.getElementById("formats") as HTMLElement;
  writeText = document.getElementById("writeText") as HTMLTextAreaElement;
  writeStatus = document.getElementById("writeStatus") as HTMLElement;
  eventLog = document.getElementById("eventLog") as HTMLElement;

  readBtn.addEventListener("click", readClipboard);
  writeBtn.addEventListener("click", writeClipboard);
  doneBtn.addEventListener("click", () => {
    electrobun.rpc?.request.closeWindow({});
  });
}

async function readClipboard() {
  try {
    addLog("Reading clipboard...");
    const result = await electrobun.rpc?.request.readClipboard({});

    if (result.text) {
      readResult.innerHTML = `<span class="clipboard-content">${escapeHtml(result.text)}</span>`;
      addLog(`Read: "${truncate(result.text, 50)}"`, "success");
    } else {
      readResult.innerHTML = `<span class="placeholder">(empty or no text content)</span>`;
      addLog("Clipboard is empty or has no text", "warn");
    }

    if (result.formats && result.formats.length > 0) {
      formatsEl.innerHTML = `Available formats: ${result.formats.join(", ")}`;
    } else {
      formatsEl.innerHTML = `<span class="placeholder">No format information available</span>`;
    }
  } catch (err) {
    readResult.innerHTML = `<span style="color: #f87171;">Error: ${err}</span>`;
    addLog(`Error reading: ${err}`, "error");
  }
}

async function writeClipboard() {
  const text = writeText.value;
  if (!text) {
    writeStatus.className = "status-box error";
    writeStatus.textContent = "Please enter some text to write";
    return;
  }

  try {
    addLog(`Writing: "${truncate(text, 50)}"...`);
    await electrobun.rpc?.request.writeClipboard({ text });
    writeStatus.className = "status-box success";
    writeStatus.textContent = "Text written to clipboard! Try pasting below.";
    addLog("Write successful", "success");
  } catch (err) {
    writeStatus.className = "status-box error";
    writeStatus.textContent = `Error: ${err}`;
    addLog(`Error writing: ${err}`, "error");
  }
}

function addLog(message: string, type: "success" | "error" | "warn" | "info" = "info") {
  const placeholder = eventLog.querySelector(".placeholder");
  if (placeholder) placeholder.remove();

  const time = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = "log-entry";

  let typeClass = "";
  if (type === "success") typeClass = "success";
  else if (type === "error") typeClass = "error";

  entry.innerHTML = `<span class="time">${time}</span><span class="${typeClass}">${escapeHtml(message)}</span>`;
  eventLog.insertBefore(entry, eventLog.firstChild);

  // Keep only last 20 entries
  while (eventLog.children.length > 20) {
    eventLog.removeChild(eventLog.lastChild!);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

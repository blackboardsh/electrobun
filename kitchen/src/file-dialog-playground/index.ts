import Electrobun, { Electroview } from "electrobun/view";

// RPC setup - use long timeout since file dialogs can take a while
const rpc = Electroview.defineRPC<any>({
  maxRequestTime: 600000, // 10 minutes - users can browse for a while
  handlers: {
    requests: {},
    messages: {},
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// DOM elements
let startingFolderInput: HTMLInputElement;
let allowedFileTypesInput: HTMLInputElement;
let canChooseFilesCheckbox: HTMLInputElement;
let canChooseDirectoryCheckbox: HTMLInputElement;
let allowsMultipleSelectionCheckbox: HTMLInputElement;
let openDialogBtn: HTMLButtonElement;
let doneBtn: HTMLButtonElement;
let resultBox: HTMLElement;
let historyBox: HTMLElement;

// History of results (avoid naming conflict with window.history)
const resultHistory: Array<{
  timestamp: Date;
  options: any;
  result: string[];
}> = [];

function init() {
  // Get DOM elements
  startingFolderInput = document.getElementById("startingFolder") as HTMLInputElement;
  allowedFileTypesInput = document.getElementById("allowedFileTypes") as HTMLInputElement;
  canChooseFilesCheckbox = document.getElementById("canChooseFiles") as HTMLInputElement;
  canChooseDirectoryCheckbox = document.getElementById("canChooseDirectory") as HTMLInputElement;
  allowsMultipleSelectionCheckbox = document.getElementById("allowsMultipleSelection") as HTMLInputElement;
  openDialogBtn = document.getElementById("openDialogBtn") as HTMLButtonElement;
  doneBtn = document.getElementById("doneBtn") as HTMLButtonElement;
  resultBox = document.getElementById("result") as HTMLElement;
  historyBox = document.getElementById("history") as HTMLElement;

  // Setup event listeners
  openDialogBtn.addEventListener("click", openDialog);
  doneBtn.addEventListener("click", () => {
    electrobun.rpc?.request.closeWindow({});
  });

  // Setup preset buttons for folders
  document.querySelectorAll(".preset-btn[data-folder]").forEach((btn) => {
    btn.addEventListener("click", () => {
      startingFolderInput.value = (btn as HTMLElement).dataset.folder || "~/";
    });
  });

  // Setup preset buttons for file types
  document.querySelectorAll(".preset-btn[data-types]").forEach((btn) => {
    btn.addEventListener("click", () => {
      allowedFileTypesInput.value = (btn as HTMLElement).dataset.types || "*";
    });
  });
}

async function openDialog() {
  const options = {
    startingFolder: startingFolderInput.value || "~/",
    allowedFileTypes: allowedFileTypesInput.value || "*",
    canChooseFiles: canChooseFilesCheckbox.checked,
    canChooseDirectory: canChooseDirectoryCheckbox.checked,
    allowsMultipleSelection: allowsMultipleSelectionCheckbox.checked,
  };

  // Disable button while dialog is open
  openDialogBtn.disabled = true;
  openDialogBtn.textContent = "Dialog Open...";

  try {
    const result = await electrobun.rpc?.request.openFileDialog(options);

    // Store in history
    resultHistory.unshift({
      timestamp: new Date(),
      options,
      result: result || [],
    });

    // Update result display
    updateResultDisplay(result || []);
    updateHistoryDisplay();
  } catch (err) {
    console.error("Error opening dialog:", err);
    resultBox.innerHTML = `<span style="color: #f87171;">Error: ${err}</span>`;
  } finally {
    openDialogBtn.disabled = false;
    openDialogBtn.textContent = "Open File Dialog";
  }
}

function updateResultDisplay(result: string[]) {
  if (result.length > 0 && result[0] !== "") {
    const fileList = result
      .map((path) => `<span class="file-path">${escapeHtml(path)}</span>`)
      .join("");
    resultBox.innerHTML = `<div class="files">Selected ${result.length} item(s):</div>${fileList}`;
  } else {
    resultBox.innerHTML = `<span class="cancelled">Dialog cancelled or no selection</span>`;
  }
}

function updateHistoryDisplay() {
  if (resultHistory.length === 0) {
    historyBox.innerHTML = `<span class="placeholder">Previous results will appear here.</span>`;
    return;
  }

  const html = resultHistory
    .slice(0, 10) // Keep last 10
    .map((item) => {
      const time = item.timestamp.toLocaleTimeString();
      const opts = `files:${item.options.canChooseFiles} dirs:${item.options.canChooseDirectory} multi:${item.options.allowsMultipleSelection} types:${item.options.allowedFileTypes}`;

      let resultHtml: string;
      if (item.result.length > 0 && item.result[0] !== "") {
        resultHtml = item.result
          .map((p) => `<span class="file-path">${escapeHtml(truncatePath(p))}</span>`)
          .join("");
      } else {
        resultHtml = `<span class="cancelled">Cancelled</span>`;
      }

      return `
        <div class="result-item">
          <div class="timestamp">${time}</div>
          <div class="options">${opts}</div>
          ${resultHtml}
        </div>
      `;
    })
    .join("");

  historyBox.innerHTML = html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncatePath(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-2).join("/")}`;
}

// Start
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

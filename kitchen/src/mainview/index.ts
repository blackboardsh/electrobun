import Electrobun, { Electroview } from "electrobun/view";
import { type MyWebviewRPC } from "./rpc";

const rpc = Electroview.defineRPC<MyWebviewRPC>({
  maxRequestTime: 5000,
  handlers: {
    requests: {
      doMath: ({ a, b }) => {
        const resultDiv = document.getElementById("dialog-result");
        if (resultDiv) {
          resultDiv.innerHTML += `<br>bun asked me to do math with ${a} and ${b}`;
        }
        return a + b;
      },
    },
    messages: {
      logToWebview: ({ msg }) => {
        console.log(`bun asked me to logToWebview: ${msg}`);
      },
    },
  },
});
const electrobun = new Electrobun.Electroview({ rpc });

// Message Box Demo - Add click handlers for dialog buttons
const setupMessageBoxButtons = () => {
  const resultDiv = document.getElementById("dialog-result");
  const types = ["info", "warning", "error", "question"] as const;

  types.forEach((type) => {
    const btn = document.getElementById(`btn-${type}`);
    if (btn) {
      btn.addEventListener("click", async () => {
        if (resultDiv) {
          resultDiv.textContent = `Showing ${type} dialog...`;
        }
        try {
          const result = await electrobun.rpc?.request.showMessageBoxDemo({ type });
          if (result && resultDiv) {
            resultDiv.textContent = `You clicked: "${result.buttonLabel}" (button index: ${result.clickedButton})`;
          }
        } catch (err) {
          if (resultDiv) {
            resultDiv.textContent = `Error: ${err}`;
          }
        }
      });
    }
  });
};

// Clipboard Demo - Add click handlers for clipboard buttons
const setupClipboardButtons = () => {
  const resultDiv = document.getElementById("clipboard-result");
  const inputField = document.getElementById("clipboard-input") as HTMLInputElement;

  const writeBtn = document.getElementById("btn-clipboard-write");
  if (writeBtn) {
    writeBtn.addEventListener("click", async () => {
      const text = inputField?.value || "";
      if (!text) {
        if (resultDiv) resultDiv.textContent = "Please enter some text to copy.";
        return;
      }
      try {
        const result = await electrobun.rpc?.request.clipboardWrite({ text });
        if (result?.success && resultDiv) {
          resultDiv.textContent = `Copied to clipboard: "${text}"`;
        }
      } catch (err) {
        if (resultDiv) resultDiv.textContent = `Error: ${err}`;
      }
    });
  }

  const readBtn = document.getElementById("btn-clipboard-read");
  if (readBtn) {
    readBtn.addEventListener("click", async () => {
      try {
        const result = await electrobun.rpc?.request.clipboardRead({});
        if (result && resultDiv) {
          const formatsStr = result.formats.length > 0 ? result.formats.join(", ") : "none";
          resultDiv.innerHTML = `<strong>Formats:</strong> ${formatsStr}<br><strong>Text:</strong> ${result.text || "(no text)"}`;
        }
      } catch (err) {
        if (resultDiv) resultDiv.textContent = `Error: ${err}`;
      }
    });
  }
};

// Run setup when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    setupMessageBoxButtons();
    setupClipboardButtons();
  });
} else {
  setupMessageBoxButtons();
  setupClipboardButtons();
}

setTimeout(() => {
  if (electrobun.rpc) {
    electrobun.rpc.request
      .doMoreMath({ a: 9, b: 8 })
      .then((result) => {
        const resultDiv = document.getElementById("dialog-result");
        if (resultDiv) {
          resultDiv.innerHTML += `<br>I asked bun to do more math and it said ${result}`;
        }
      })
      .catch(() => {});

    electrobun.rpc.send.logToBun({ msg: "hello from webview" });
  }
}, 5000);

setTimeout(() => {
  console.log("sending big request:");
  if (electrobun.rpc) {
    const bigRequest = "z".repeat(1024 * 1024 * 2) + "z";
    electrobun.rpc.request.bigRequest(bigRequest).then((result) => {
      console.log("big response: ", result.length);
    });
  }
}, 5000);

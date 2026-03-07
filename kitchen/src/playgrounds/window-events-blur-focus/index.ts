import Electrobun, { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<any>({
  maxRequestTime: 120000,
  handlers: {
    requests: {},
    messages: {
      updateStatus: ({ blurDetected, focusDetected }: { blurDetected: boolean; focusDetected: boolean }) => {
        if (blurDetected) {
          document.getElementById("blur-indicator")?.classList.add("detected");
          const blurStatus = document.getElementById("blur-status");
          if (blurStatus) {
            blurStatus.classList.add("detected");
            blurStatus.textContent = "Blur: Detected!";
          }
        }
        if (focusDetected) {
          document.getElementById("focus-indicator")?.classList.add("detected");
          const focusStatus = document.getElementById("focus-status");
          if (focusStatus) {
            focusStatus.classList.add("detected");
            focusStatus.textContent = "Focus: Detected!";
          }
        }
        if (blurDetected && focusDetected) {
          document.getElementById("done-message")?.classList.add("show");
        }
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("closeBtn")?.addEventListener("click", () => {
    (electrobun.rpc as any)?.request.closeWindow({});
  });
});

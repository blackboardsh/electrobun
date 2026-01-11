import Electrobun, { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<{
  requests: {
    closeWindow: () => { success: boolean };
  };
  messages: {
    updatePosition: { x: number; y: number };
    updateSize: { width: number; height: number };
    updateStatus: { moveDetected: boolean; resizeDetected: boolean };
  };
}>({
  maxRequestTime: 120000,
  handlers: {
    requests: {},
    messages: {
      updatePosition: ({ x, y }) => {
        const el = document.getElementById("position");
        if (el) el.textContent = `${x}, ${y}`;
      },
      updateSize: ({ width, height }) => {
        const el = document.getElementById("size");
        if (el) el.textContent = `${width} x ${height}`;
      },
      updateStatus: ({ moveDetected, resizeDetected }) => {
        if (moveDetected) {
          document.getElementById("move-indicator")?.classList.add("detected");
          const moveStatus = document.getElementById("move-status");
          if (moveStatus) {
            moveStatus.classList.add("detected");
            moveStatus.textContent = "Move: Detected!";
          }
        }
        if (resizeDetected) {
          document.getElementById("resize-indicator")?.classList.add("detected");
          const resizeStatus = document.getElementById("resize-status");
          if (resizeStatus) {
            resizeStatus.classList.add("detected");
            resizeStatus.textContent = "Resize: Detected!";
          }
        }
        if (moveDetected && resizeDetected) {
          document.getElementById("done-message")?.classList.add("show");
        }
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("closeBtn")?.addEventListener("click", () => {
    electrobun.rpc?.request.closeWindow({});
  });
});

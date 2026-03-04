import { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<any>({
  maxRequestTime: 600000,
  handlers: {
    requests: {},
    messages: {},
  },
});

const electrobun = new Electroview({ rpc });

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("doneBtn")?.addEventListener("click", () => {
    (electrobun.rpc as any)?.request.closeWindow({});
  });

  const wgpu = document.getElementById("wgpuView") as any;
  const statusEl = document.getElementById("status");

  const sendRect = () => {
    if (!wgpu || !wgpu.wgpuViewId) return;
    const rect = wgpu.getBoundingClientRect();
    (electrobun.rpc as any)?.message.wgpuTagRect({
      id: wgpu.wgpuViewId,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    });
  };

  document.getElementById("toggleShaderBtn")?.addEventListener("click", () => {
    if (!wgpu || !wgpu.wgpuViewId) return;
    (electrobun.rpc as any)?.request.wgpuTagToggleShader({ id: wgpu.wgpuViewId });
    if (statusEl) statusEl.textContent = "Status: toggled shader";
  });

  document.getElementById("toggleTransparentBtn")?.addEventListener("click", () => {
    wgpu?.toggleTransparent();
  });

  document.getElementById("togglePassthroughBtn")?.addEventListener("click", () => {
    wgpu?.togglePassthrough();
  });

  document.getElementById("toggleHiddenBtn")?.addEventListener("click", () => {
    wgpu?.toggleHidden();
  });

  document.getElementById("addMaskBtn")?.addEventListener("click", () => {
    wgpu?.addMaskSelector(".mask-target");
  });

  document.getElementById("removeMaskBtn")?.addEventListener("click", () => {
    wgpu?.removeMaskSelector(".mask-target");
  });

  document.getElementById("resizeSmallBtn")?.addEventListener("click", () => {
    if (!wgpu) return;
    wgpu.style.width = "360px";
    wgpu.style.height = "220px";
  });

  document.getElementById("resizeLargeBtn")?.addEventListener("click", () => {
    if (!wgpu) return;
    wgpu.style.width = "600px";
    wgpu.style.height = "350px";
  });

  if (wgpu?.on) {
    wgpu.on("ready", async (e: any) => {
      if (statusEl) statusEl.textContent = `Status: ready (id ${e.detail.id})`;
      const rect = wgpu.getBoundingClientRect();
      await (electrobun.rpc as any)?.request.wgpuTagReady({
        id: e.detail.id,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      });
      sendRect();
    });
  }

  if (wgpu && "ResizeObserver" in window) {
    const observer = new ResizeObserver(() => {
      sendRect();
    });
    observer.observe(wgpu);
  }

  window.addEventListener("resize", () => {
    sendRect();
  });
});

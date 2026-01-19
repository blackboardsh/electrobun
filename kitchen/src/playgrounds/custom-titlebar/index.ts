import Electrobun, { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<{
  requests: {
    closeWindow: () => { success: boolean };
    minimizeWindow: () => { success: boolean };
    maximizeWindow: () => { success: boolean };
  };
  messages: {};
}>({
  maxRequestTime: 600000,
  handlers: {
    requests: {},
    messages: {},
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

document.addEventListener("DOMContentLoaded", () => {
  // Custom window control buttons
  document.getElementById("closeBtn")?.addEventListener("click", () => {
    electrobun.rpc?.request.closeWindow({});
  });

  document.getElementById("minimizeBtn")?.addEventListener("click", () => {
    electrobun.rpc?.request.minimizeWindow({});
  });

  document.getElementById("maximizeBtn")?.addEventListener("click", () => {
    electrobun.rpc?.request.maximizeWindow({});
  });

  // Done button
  document.getElementById("doneBtn")?.addEventListener("click", () => {
    electrobun.rpc?.request.closeWindow({});
  });
});

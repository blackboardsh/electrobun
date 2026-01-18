import Electrobun, { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<{
  requests: {
    closeWindow: () => { success: boolean };
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
  // Close button
  document.getElementById("closeBtn")?.addEventListener("click", () => {
    electrobun.rpc?.request.closeWindow({});
  });

  // Make the floating cards draggable
  const cards = document.querySelectorAll(".floating-card");
  cards.forEach((card) => {
    card.classList.add("electrobun-webkit-app-region-drag");
  });
});

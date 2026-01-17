import ElectrobunView, { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<any>({
  maxRequestTime: 600000,
  handlers: {
    requests: {},
    messages: {},
  },
});

const electrobun = new Electroview({ rpc });

// Done button handler
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("doneBtn")?.addEventListener("click", () => {
    electrobun.rpc?.request.closeWindow({});
  });
});

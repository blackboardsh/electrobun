import ElectrobunView, { Electroview } from "electrobun/view";

const rpc = Electroview.defineRPC<any>({
  handlers: {
    requests: {},
    messages: {},
  },
});

const electrobun = new ElectrobunView.Electroview({ rpc });

setTimeout(() => {
  console.log("updating src for webview tag");
  document
    .querySelector("electrobun-webview")
    ?.setAttribute("src", "https://github.com/blackboardsh/electrobun");
}, 2000);

setTimeout(() => {
  document.querySelector("electrobun-webview")?.loadURL("https://eggbun.sh");
}, 5000);

// unit test
// setTimeout(() => {
//   document.querySelector("electrobun-webview")?.remove();
// }, 1000);

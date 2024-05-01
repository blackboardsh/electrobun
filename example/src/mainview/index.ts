import ElectrobunView, { Electroview } from "electrobun/view";
import { type MyWebviewRPC, type MyWebviewSyncRPC } from "./rpc";

const rpc = Electroview.defineRPC<MyWebviewRPC>({
  handlers: {
    requests: {
      doMath: ({ a, b }) => {
        document.body.innerHTML += `bun asked me to do math with ${a} and ${b}\n`;
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
const electrobun = new ElectrobunView.Electroview({ rpc });

setTimeout(() => {
  // sync rpc test
  // The entire thread will halt while waiting for bun to respond
  // todo: make it nice to add typescript types for syncrpc
  const syncMathResult = electrobun.syncRpc({
    method: "doSyncMath",
    params: { a: 5, b: 9 },
  });

  console.log("----> sync result:", syncMathResult);
  document.body.innerHTML += `<br> \nsync result: ${syncMathResult}\n`;
}, 5000);

setTimeout(() => {
  if (electrobun.rpc) {
    electrobun.rpc.request
      .doMoreMath({ a: 9, b: 8 })
      .then((result) => {
        document.body.innerHTML += `I asked bun to do more math and it said ${result}\n`;
      })
      .catch(() => {});

    electrobun.rpc.send.logToBun({ msg: "hello from webview" });
  }
}, 5000);

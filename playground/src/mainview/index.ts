import Electrobun, { Electroview } from "electrobun/view";
import { type MyWebviewRPC } from "./rpc";

const rpc = Electroview.defineRPC<MyWebviewRPC>({
  maxRequestTime: 5000,
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
const electrobun = new Electrobun.Electroview({ rpc });

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

setTimeout(() => {
  console.log("sending big request:");
  if (electrobun.rpc) {
    const bigRequest = "z".repeat(1024 * 1024 * 2) + "z";
    electrobun.rpc.request.bigRequest(bigRequest).then((result) => {
      console.log("big response: ", result.length);
    });
  }
}, 5000);

// src/browser/index.ts
var electrobun = {
  bunBridge: (msg) => {
    window.webkit.messageHandlers.bunBridge.postMessage(msg);
  },
  receiveMessageFromBun: (msg) => {
    document.body.innerHTML = msg.msg;
  }
};
window.electrobun = electrobun;

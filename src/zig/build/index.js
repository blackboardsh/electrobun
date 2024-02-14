// src/browser/index.ts
var electrobun = {
  bunBridge: (msg) => {
    window.webkit.messageHandlers.bunBridge.postMessage(msg);
  }
};
window.electrobun = electrobun;

// src/browser/index.ts
var electrobun = {
  bunBridge: (msg) => {
    window.webkit.messageHandlers.bunBridge.postMessage(msg);
  }
};
window.electrobun = electrobun;
setTimeout(() => {
  document.body.innerHTML = "wow yeah! bro";
}, 4000);

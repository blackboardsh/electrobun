import { BrowserWindow } from "./src/bun/core/BrowserWindow";

const win = new BrowserWindow({
  title: "New Window Event Test",
  frame: {
    width: 800,
    height: 600,
    x: 100,
    y: 100
  },
  url: null,
  html: null,
  renderer: 'native', // Test with native WebKit first
});

// Listen for new-window-open events
win.webview.on("new-window-open", (event) => {
  console.log("🚀 NEW-WINDOW-OPEN EVENT:", event.detail);
});

// Load our test HTML
const testHTML = await Bun.file("./test-new-window.html").text();
win.webview.loadHTML(testHTML);

console.log("Test window created. Try clicking links with and without CMD key.");
console.log("Watch for 'NEW-WINDOW-OPEN EVENT' in the console.");
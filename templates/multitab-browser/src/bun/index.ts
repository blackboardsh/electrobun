import Electrobun, { BrowserWindow, BrowserView } from "electrobun/bun";

console.log("🌐 Multitab Browser starting...");

// Simplified tab management - demo without real webviews
const tabs = new Map();
let nextTabId = 1;
let mainRPC: any = null; // Will be set after window creation

// Set up RPC using the correct API pattern from interactive-playground
const rpc = BrowserView.defineRPC({
  maxRequestTime: 10000,
  handlers: {
    requests: {
      createTab: async ({ url }: { url?: string }) => {
        const id = `tab-${nextTabId++}`;
        
        const tab = {
          id,
          title: "New Tab",
          url: url || "https://electrobun.dev",
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
        };
        
        tabs.set(id, tab);
        
        // Simulate getting the title after a delay
        setTimeout(() => {
          if (mainRPC) {
            tab.title = new URL(tab.url).hostname || "New Tab";
            mainRPC.send("tabUpdated", tab);
          }
        }, 500);
        
        return tab;
      },
      
      closeTab: async ({ id }: { id: string }) => {
        tabs.delete(id);
        return;
      },
      
      activateTab: async ({ tabId }: { tabId: string }) => {
        // Just return the tab info - the iframe switching happens in the frontend
        return tabs.get(tabId);
      },
      
      navigateTo: async ({ tabId, url }: { tabId: string; url: string }) => {
        const tab = tabs.get(tabId);
        
        if (tab) {
          // Process URL - add https if needed, or search
          let processedUrl = url;
          if (!url.startsWith("http://") && !url.startsWith("https://")) {
            if (url.includes(".") && !url.includes(" ")) {
              processedUrl = `https://${url}`;
            } else {
              processedUrl = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
            }
          }
          
          tab.url = processedUrl;
          tab.isLoading = false;
          
          // Simulate title update
          setTimeout(() => {
            if (mainRPC && tab) {
              try {
                tab.title = new URL(processedUrl).hostname || "New Tab";
              } catch {
                tab.title = processedUrl;
              }
              mainRPC.send("tabUpdated", tab);
            }
          }, 500);
        }
        
        return tab;
      },
      
      goBack: async ({ tabId }: { tabId: string }) => {
        // In a real implementation, we'd track history
        console.log("Go back for tab:", tabId);
        return tabs.get(tabId);
      },
      
      goForward: async ({ tabId }: { tabId: string }) => {
        // In a real implementation, we'd track history
        console.log("Go forward for tab:", tabId);
        return tabs.get(tabId);
      },
      
      reload: async ({ tabId }: { tabId: string }) => {
        const tab = tabs.get(tabId);
        if (tab) {
          tab.isLoading = true;
          if (mainRPC) {
            mainRPC.send("tabUpdated", tab);
          }
          
          setTimeout(() => {
            tab.isLoading = false;
            if (mainRPC) {
              mainRPC.send("tabUpdated", tab);
            }
          }, 1000);
        }
        return tab;
      },
    },
    messages: {
      "*": (messageName: string, payload: any) => {
        console.log(`📨 Browser message: ${messageName}`, payload);
      },
    },
  },
});

// Create main browser window with RPC
const mainWindow = new BrowserWindow({
  title: "Multitab Browser",
  url: "views://mainview/index.html",
  frame: {
    width: 1400,
    height: 900,
    x: 100,
    y: 100,
  },
  rpc,
});

// Store reference to mainWindow RPC for sending messages
mainRPC = mainWindow.webview.rpc;

// Listen for window close event and exit the app
// For this browser app, we want to exit when the main window is closed
mainWindow.on("close", () => {
  console.log("🚪 Main window closed - exiting app");
  process.exit(0);
});

console.log("✅ Multitab Browser initialized");
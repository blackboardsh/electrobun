import Electrobun, { BrowserWindow, BrowserView, createRPC, Utils, type RPCSchema } from "electrobun/bun";

// Define RPC schema for photo saving and screen capture
export type PhotoBoothRPC = {
  bun: RPCSchema<{
    requests: {
      savePhoto: {
        params: {
          dataUrl: string;
          filename: string;
        };
        response: {
          success: boolean;
          path?: string;
          reason?: string;
          error?: string;
        };
      };
      captureScreen: {
        params: {};
        response: {
          success: boolean;
          dataUrl?: string;
          error?: string;
        };
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};

// Create RPC instance using BrowserView.defineRPC
const photoBoothRPC = BrowserView.defineRPC<PhotoBoothRPC>({
  maxRequestTime: 5000,
  handlers: {
    requests: {
      savePhoto: async ({ dataUrl, filename }) => {
        try {
          // Convert data URL to buffer
          const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
          const buffer = Buffer.from(base64Data, "base64");
          
          // Show save dialog using Utils
          const chosenPaths = await Utils.openFileDialog({
            startingFolder: Bun.env.HOME || "/",
            allowedFileTypes: "png",
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          });
          
          if (chosenPaths[0] && chosenPaths[0] !== "") {
            const savePath = `${chosenPaths[0]}/${filename}`;
            
            // Save the file
            await Bun.write(savePath, buffer);
            
            return { 
              success: true, 
              path: savePath 
            };
          } else {
            return { 
              success: false, 
              reason: "canceled" 
            };
          }
        } catch (error) {
          console.error("Error saving photo:", error);
          return { 
            success: false, 
            error: error.message 
          };
        }
      },
      captureScreen: async () => {
        try {
          // For now, we'll use the mainWindow's snapshot API
          // This captures the current window content
          // In a real implementation, you might want to use native screen capture APIs
          
          // Take a snapshot of the main window
          const snapshot = await mainWindow.snapshot();
          
          if (snapshot) {
            return {
              success: true,
              dataUrl: snapshot
            };
          } else {
            return {
              success: false,
              error: "Failed to capture screen"
            };
          }
        } catch (error) {
          console.error("Error capturing screen:", error);
          return {
            success: false,
            error: error.message
          };
        }
      }
    },
    messages: {}
  }
});

// Create the main window
// Use native renderer (WKWebView) by default, but allow overriding with CEF
const mainWindow = new BrowserWindow({
  title: "Photo Booth",
  url: "views://mainview/index.html",
  // Don't specify renderer to use the default (native WKWebView on macOS)
  frame: {
    width: 1000,
    height: 700,
    x: 100,
    y: 100,
  },
  rpc: photoBoothRPC,
});

console.log("Photo Booth app started!");
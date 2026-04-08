import { BrowserWindow, BrowserView, Updater } from "electrobun/bun";
import type { AppRPC } from "@shared/types/rpc";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

const rpc = BrowserView.defineRPC<AppRPC>({
  handlers: {
    messages: {
      ping: () => {
        console.log("[RPC]: Pong!!!");
      },
    },
  },
});

// Check if Vite dev server is running for HMR
async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log(
        "Vite dev server not running. Run 'bun run dev:hmr' for HMR support.",
      );
    }
  }
  return "views://mainview/index.html";
}

// Create the main application window
const url = await getMainViewUrl();

const mainWindow = new BrowserWindow({
  title: "electronbun-tanstack-router-react-template",
  url,
  rpc,
  styleMask: {
    Resizable: true,
    Miniaturizable: true,
  },
  frame: {
    width: 800,
    height: 670,
    x: 500,
    y: -100,
  },
});

mainWindow.on("close", () => {
  console.log("[APP]: Window closed");
});

console.log("Tanstack Router + React + Vite app started!");

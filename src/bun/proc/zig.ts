import { join, resolve } from "path";
import { type RPCSchema, type RPCTransport, createRPC } from "rpc-anywhere";
import { execSync } from "child_process";
import * as fs from "fs";
import electrobunEventEmitter from "../events/eventEmitter";
import { BrowserView } from "../core/BrowserView";
import { Updater } from "../core/Updater";
import { Tray } from "../core/Tray";
const CHUNK_SIZE = 1024 * 4; // 4KB
// todo (yoav): webviewBinaryPath and ELECTROBUN_VIEWS_FOLDER should be passed in as cli/env args by the launcher binary
// will likely be different on different platforms. Right now these are hardcoded for relative paths inside the mac app bundle.
const webviewBinaryPath = join("native", "webview");

const hash = await Updater.localInfo.hash();
// Note: we use the build's hash to separate from different apps and different builds
// but we also want a randomId to separate different instances of the same app
// todo (yoav): since collisions can crash the app add a function that checks if the
// file exists first
const randomId = Math.random().toString(36).substring(7);
const mainPipe = `/private/tmp/electrobun_ipc_pipe_${hash}_${randomId}_main_in`;

try {
  execSync("mkfifo " + mainPipe);
} catch (e) {
  console.log("pipe out already exists");
}

const zigProc = Bun.spawn([webviewBinaryPath], {
  stdin: "pipe",
  stdout: "pipe",
  env: {
    ...process.env,
    ELECTROBUN_VIEWS_FOLDER: resolve("../Resources/app/views"),
    MAIN_PIPE_IN: mainPipe,
  },
  onExit: (_zigProc) => {
    // right now just exit the whole app if the webview process dies.
    // in the future we probably want to try spin it back up aagain
    process.exit(0);
  },
});

process.on("SIGINT", (code) => {
  // todo (yoav): maybe send a friendly signal to the webviews to let them know
  // we're shutting down
  // clean up the webview process when the bun process dies.
  zigProc.kill();
  // fs.unlinkSync(mainPipe);
  process.exit();
});

process.on("exit", (code) => {
  // Note: this can happen when the bun process crashes
  // make sure that zigProc is killed so it doesn't linger around
  zigProc.kill();
});

const inStream = fs.createWriteStream(mainPipe, {
  flags: "r+",
});

function createStdioTransport(proc): RPCTransport {
  return {
    send(message) {
      try {
        // TODO: this is the same chunking code as browserview pipes,
        // should dedupe
        const messageString = JSON.stringify(message) + "\n";

        let offset = 0;
        while (offset < messageString.length) {
          const chunk = messageString.slice(offset, offset + CHUNK_SIZE);
          inStream.write(chunk);
          offset += CHUNK_SIZE;
        }

        // Ensure the newline is written after all chunks
        inStream.write("\n");
      } catch (error) {
        console.error("bun: failed to serialize message to zig", error);
      }
    },
    registerHandler(handler) {
      async function readStream(stream) {
        const reader = stream.getReader();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value);
            let eolIndex;
            // Process each line contained in the buffer
            while ((eolIndex = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, eolIndex).trim();
              buffer = buffer.slice(eolIndex + 1);
              if (line) {
                try {
                  const event = JSON.parse(line);
                  handler(event);
                } catch (error) {
                  // Non-json things are just bubbled up to the console.
                  console.error("zig: ", line);
                }
              }
            }
          }
        } catch (error) {
          console.error("Error reading from stream:", error);
        } finally {
          reader.releaseLock();
        }
      }

      readStream(proc.stdout);
    },
  };
}

// todo: consider renaming to TrayMenuItemConfig
export type MenuItemConfig =
  | { type: "divider" | "separator" }
  | {
      type: "normal";
      label: string;
      tooltip?: string;
      action?: string;
      submenu?: Array<MenuItemConfig>;
      enabled?: boolean;
      checked?: boolean;
      hidden?: boolean;
    };

export type ApplicationMenuItemConfig =
  | { type: "divider" | "separator" }
  | {
      type?: "normal";
      label: string;
      tooltip?: string;
      action?: string;
      submenu?: Array<ApplicationMenuItemConfig>;
      enabled?: boolean;
      checked?: boolean;
      hidden?: boolean;
    }
  | {
      type?: "normal";
      label?: string;
      tooltip?: string;
      role?: string;
      submenu?: Array<ApplicationMenuItemConfig>;
      enabled?: boolean;
      checked?: boolean;
      hidden?: boolean;
    };

// todo (yoav): move this stuff to bun/rpc/zig.ts
type ZigHandlers = RPCSchema<{
  requests: {
    createWindow: {
      params: {
        id: number;
        url: string | null;
        html: string | null;
        title: string;
        frame: {
          width: number;
          height: number;
          x: number;
          y: number;
        };
        styleMask: {
          Borderless: boolean;
          Titled: boolean;
          Closable: boolean;
          Miniaturizable: boolean;
          Resizable: boolean;
          UnifiedTitleAndToolbar: boolean;
          FullScreen: boolean;
          FullSizeContentView: boolean;
          UtilityWindow: boolean;
          DocModalWindow: boolean;
          NonactivatingPanel: boolean;
          HUDWindow: boolean;
        };
        titleBarStyle: string;
      };
      response: void;
    };
    createWebview: {
      params: {
        id: number;
        hostWebviewId: number | null;
        pipePrefix: string;
        url: string | null;
        html: string | null;
        partition: string | null;
        preload: string | null;
        frame: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        autoResize: boolean;
      };
      response: void;
    };

    addWebviewToWindow: {
      params: {
        windowId: number;
        webviewId: number;
      };
      response: void;
    };

    loadURL: {
      params: {
        webviewId: number;
        url: string;
      };
      response: void;
    };
    loadHTML: {
      params: {
        webviewId: number;
        html: string;
      };
      response: void;
    };

    setTitle: {
      params: {
        winId: number;
        title: string;
      };
      response: void;
    };

    closeWindow: {
      params: {
        winId: number;
      };
      response: void;
    };

    // fs
    moveToTrash: {
      params: {
        path: string;
      };
      response: boolean;
    };
    showItemInFolder: {
      params: {
        path: string;
      };
      response: boolean;
    };
    openFileDialog: {
      params: {
        startingFolder: string | null;
        allowedFileTypes: string | null;
        canChooseFiles: boolean;
        canChooseDirectory: boolean;
        allowsMultipleSelection: boolean;
      };
      response: { openFileDialogResponse: string };
    };

    // tray and menu
    createTray: {
      params: {
        id: number;
        title: string;
        image: string;
        template: boolean;
        width: number;
        height: number;
      };
      response: void;
    };
    setTrayTitle: {
      params: {
        id: number;
        title: string;
      };
      response: void;
    };
    setTrayImage: {
      params: {
        id: number;
        image: string;
      };
      response: void;
    };
    setTrayMenu: {
      params: {
        id: number;
        // json string of config
        menuConfig: string;
      };
      response: void;
    };
    setApplicationMenu: {
      params: {
        // json string of config
        menuConfig: string;
      };
      response: void;
    };
    showContextMenu: {
      params: {
        // json string of config
        menuConfig: string;
      };
      response: void;
    };
  };
}>;

type BunHandlers = RPCSchema<{
  requests: {
    decideNavigation: {
      params: {
        webviewId: number;
        url: string;
      };
      response: {
        allow: boolean;
      };
    };
    syncRequest: {
      params: {
        webviewId: number;
        request: string;
      };
      response: {
        payload: string;
      };
    };
    // todo: make these messages instead of requests
    log: {
      params: {
        msg: string;
      };
      response: {
        success: boolean;
      };
    };
    trayEvent: {
      params: {
        id: number;
        action: string;
      };
      response: {
        success: boolean;
      };
    };
    applicationMenuEvent: {
      params: {
        id: number;
        action: string;
      };
      response: {
        success: boolean;
      };
    };
    contextMenuEvent: {
      params: {
        action: string;
      };
      response: {
        success: boolean;
      };
    };
    webviewEvent: {
      params: {
        id: number;
        eventName: string;
        detail: string;
      };
      response: {
        success: boolean;
      };
    };
    windowClose: {
      params: {
        id: number;
      };
      response: {
        success: boolean;
      };
    };
    windowMove: {
      params: {
        id: number;
        x: number;
        y: number;
      };
      response: {
        success: boolean;
      };
    };
    windowResize: {
      params: {
        id: number;
        x: number;
        y: number;
        width: number;
        height: number;
      };
      response: {
        success: boolean;
      };
    };
  };
}>;

const zigRPC = createRPC<BunHandlers, ZigHandlers>({
  transport: createStdioTransport(zigProc),
  requestHandler: {
    decideNavigation: ({ webviewId, url }) => {
      const willNavigate = electrobunEventEmitter.events.webview.willNavigate({
        url,
        webviewId,
      });

      let result;
      // global will-navigate event
      result = electrobunEventEmitter.emitEvent(willNavigate);

      result = electrobunEventEmitter.emitEvent(willNavigate, webviewId);

      if (willNavigate.responseWasSet) {
        return willNavigate.response || { allow: true };
      } else {
        return { allow: true };
      }
    },
    syncRequest: ({ webviewId, request: requestStr }) => {
      const webview = BrowserView.getById(webviewId);
      const { method, params } = JSON.parse(requestStr);

      if (!webview) {
        const err = `error: could not find webview with id ${webviewId}`;
        console.log(err);
        return { payload: err };
      }

      if (!method) {
        const err = `error: request missing a method`;
        console.log(err);
        return { payload: err };
      }

      if (!webview.syncRpc || !webview.syncRpc[method]) {
        const err = `error: webview does not have a handler for method ${method}`;
        console.log(err);
        return { payload: err };
      }

      const handler = webview.syncRpc[method];
      var response;
      try {
        response = handler(params);
        // Note: Stringify(undefined) returns undefined,
        // if we send undefined as the payload it'll crash
        // so send an empty string which is a better analog for
        // undefined json string
        if (response === undefined) {
          response = "";
        }
      } catch (err) {
        console.log(err);
        console.log("syncRPC failed with", { method, params });
        return { payload: String(err) };
      }

      const payload = JSON.stringify(response);
      return { payload };
    },
    log: ({ msg }) => {
      console.log("zig: ", msg);
      return { success: true };
    },
    trayEvent: ({ id, action }) => {
      const tray = Tray.getById(id);
      if (!tray) {
        return { success: true };
      }

      const event = electrobunEventEmitter.events.tray.trayClicked({
        id,
        action,
      });

      let result;
      // global event
      result = electrobunEventEmitter.emitEvent(event);

      result = electrobunEventEmitter.emitEvent(event, id);
      // Note: we don't care about the result right now

      return { success: true };
    },
    applicationMenuEvent: ({ id, action }) => {
      const event = electrobunEventEmitter.events.app.applicationMenuClicked({
        id,
        action,
      });

      let result;
      // global event
      result = electrobunEventEmitter.emitEvent(event);

      return { success: true };
    },
    contextMenuEvent: ({ action }) => {
      const event = electrobunEventEmitter.events.app.contextMenuClicked({
        action,
      });

      let result;
      // global event
      result = electrobunEventEmitter.emitEvent(event);

      return { success: true };
    },
    webviewEvent: ({ id, eventName, detail }) => {
      const eventMap = {
        "did-navigate": "didNavigate",
        "did-navigate-in-page": "didNavigateInPage",
        "did-commit-navigation": "didCommitNavigation",
        "dom-ready": "domReady",
        "new-window-open": "newWindowOpen",
      };

      // todo: the events map should use the same hyphenated names instead of camelCase
      const handler =
        electrobunEventEmitter.events.webview[eventMap[eventName]];

      if (!handler) {
        console.log(`!!!no handler for webview event ${eventName}`);
        return { success: false };
      }

      const event = handler({
        id,
        detail,
      });

      let result;
      // global event
      result = electrobunEventEmitter.emitEvent(event);

      result = electrobunEventEmitter.emitEvent(event, id);
      // Note: we don't care about the result right now

      return { success: true };
    },
    windowClose: ({ id }) => {
      const handler = electrobunEventEmitter.events.window.close;

      const event = handler({
        id,
      });

      let result;
      // global event
      result = electrobunEventEmitter.emitEvent(event);

      result = electrobunEventEmitter.emitEvent(event, id);
      // Note: we don't care about the result right now

      return { success: false };
    },
    windowMove: ({ id, x, y }) => {
      const handler = electrobunEventEmitter.events.window.move;

      const event = handler({
        id,
        x,
        y,
      });

      let result;
      // global event
      result = electrobunEventEmitter.emitEvent(event);

      result = electrobunEventEmitter.emitEvent(event, id);
      // Note: we don't care about the result right now

      return { success: false };
    },
    windowResize: ({ id, x, y, width, height }) => {
      const handler = electrobunEventEmitter.events.window.resize;

      const event = handler({
        id,
        x,
        y,
        width,
        height,
      });

      let result;
      // global event
      result = electrobunEventEmitter.emitEvent(event);

      result = electrobunEventEmitter.emitEvent(event, id);
      // Note: we don't care about the result right now

      return { success: false };
    },
  },
  maxRequestTime: 25000,
});

export { zigRPC, zigProc };

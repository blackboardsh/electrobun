console.log('some dev code')
import Electrobun, {
  BrowserWindow,
  BrowserView,
  ApplicationMenu,
  ContextMenu,
  Tray,
  type RPCSchema,
  type ElectrobunEvent,
  createRPC,
  Utils,
} from "electrobun/bun";
import { type MyWebviewRPC } from "../mainview/rpc";
import { type MyExtensionSchema } from "../myextension/rpc";
import { resolve, resolveSync } from "bun";
import { homedir } from "os";
import { join } from "path";

setTimeout(() => {
  process.exit();
}, 30000)

// Electrobun.Updater.getLocalVersion();

// Note: the Canary Playground app will always try update to the latest version
// We should make this a button in the playground UI
setTimeout(async () => {
  const updateInfo = await Electrobun.Updater.checkForUpdate();

  if (updateInfo.updateAvailable) {
    console.log("update available", updateInfo);
    // todo (yoav): add a button to the UI to trigger this
    await Electrobun.Updater.downloadUpdate();
  }

  if (Electrobun.Updater.updateInfo()?.updateReady) {
    console.log("update app");
    await Electrobun.Updater.applyUpdate();
  }
}, 5000);

// const myWebviewRPC = createRPC<MyWebviewRPC["bun"], MyWebviewRPC["webview"]>({
//     maxRequestTime: 5000,
//     requestHandler: {
//         doMoreMath: ({a, b}) => {
//             console.log('\n\n\n\n')
//             console.log(`win1 webview asked me to do more math with: ${a} and ${b}`)
//             return a + b;
//         },
//         // todo (yoav): messages currently require subscripting
//         // logToBun: ({msg}) => {
//         //     console.log('\n\nWebview asked to logToBun: ', msg, '\n\n')
//         // }
//     }
// });

// setTimeout(async () => {
//   const files = await Electrobun.Utils.openFileDialog();

//   const fileToDelete = files[0];

//   console.log("----->>> openFileDialog result", fileToDelete);
//   if (fileToDelete) {
//     console.log("deleting file", fileToDelete);
//     await Electrobun.Utils.moveToTrash(fileToDelete);
//   } else {
//     console.log("no file selected");
//   }
// }, 10000);

// map action names to clicked state
const menuState = {
  "item-1": false,
  "sub-item-1": false,
  "sub-item-2": true,
};

const tray = new Tray({
  title: "Example Tray Item (click to create menu)",
  // Note: __dirname here will evaulate to src/bun when running in dev mode
  // todo: we should include it as an asset and use that url
  // This can be a views url or an absolute file path
  image: `views://assets/electrobun-logo-32-template.png`,
  template: true,
  width: 32,
  height: 32,
});

const updateTrayMenu = () => {
  tray.setMenu([
    {
      type: "normal",
      label: `Toggle me`,
      action: "item-1",      
      checked: menuState["item-1"],
      tooltip: `I'm a tooltip`,
      submenu: [
        {
          type: "normal",
          label: "Click me to toggle sub-item 2",
          tooltip: "i will also unhide sub-item-3",
          action: "sub-item-1",
          data: {
          'test': 'toast'
        },
        },
        {
          type: "divider",
        },
        {
          type: "normal",
          label: "Toggle sub-item-3's visibility",
          action: "sub-item-2",
          enabled: menuState["sub-item-1"],
        },
        {
          type: "normal",
          label: "I was hidden",
          action: "sub-item-3",
          hidden: menuState["sub-item-2"],
        },
      ],
    },
  ]);
};

// On Linux, AppIndicator doesn't send click events for the main icon
if (process.platform === "linux") {
  setTimeout(() => {
    updateTrayMenu();
    tray.setTitle("Example Tray Item (click to open menu)");
  }, 1000)
}

// TODO: events should be typed
tray.on("tray-clicked", (e) => {
  const { id, action } = e.data as { id: number; action: string };
  console.log("tray clicked", id, action, e);
  if (action === "") {
    // main menu was clicked before we create a system tray menu for it.
    updateTrayMenu();
    tray.setTitle("Example Tray Item (click to open menu)");
  } else {
    // once there's a menu, we can toggle the state of the menu items
    menuState[action] = !menuState[action];
    updateTrayMenu();
  }  
  // respond to left and right clicks on the tray icon/name
  console.log("event listener for tray clicked", e.data.action);
});

ApplicationMenu.setApplicationMenu([
  {
    submenu: [{ label: "Quit", role: "quit", accelerator: "q" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      {
        label: "Custom Menu Item  🚀",
        action: "custom-action-1",
        tooltip: "I'm a tooltip",
        data: {
          hi: 'there'
        }
      },
      {
        label: "Custom menu disabled",
        enabled: false,
        action: "custom-action-2",
      },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },
]);

Electrobun.events.on("application-menu-clicked", (e) => {
  console.log("application menu clicked", e.data); // custom-actino
});

Electrobun.events.on("new-window-open", (e) => {
  console.log('---------->>>> new window open ........', e)
  /**
   * {
  name: "new-window-open",
  data: {
    id: 2,
    detail: {
      url: "https://en.wikipedia.org/wiki/Wikipedia",
      isCmdClick: true,
      targetDisposition: 4,
      userGesture: true,
    },
  }
   * 
   */
})

// typically you'd wire up a frontend rightclick event, preventDefault, rpc to bun, then fire this.
// but you can also fire and handle context menus entirely from bun globally positioned on screen
// even if you have no windows open and another app is focused
setTimeout(() => {
  ContextMenu.showContextMenu([
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    {
      label: "Custom Menu Item  🚀",
      action: "custom-action-1",
      tooltip: "I'm a tooltip",
      data: {
        some: 'data',
        bool: true
      }
    },
    {
      label: "Custom menu disabled",
      enabled: false,
      action: "custom-action-2",
    },
    {
      label: "Custom menu disabled",
      enabled: false,
      action: "custom-action-2",
      // todo: support a data property on all menus (app, tray, context)
      data: {
        some: "data",
        that: "is serialized",
        nested: { thing: 23 },
      },
    },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "pasteAndMatchStyle" },
    { role: "delete" },
    { role: "selectAll" },
  ]);
}, 3000);

Electrobun.events.on("context-menu-clicked", (e) => {
  console.log("context event", e.data);
});

const myWebviewRPC = BrowserView.defineRPC<MyWebviewRPC>({
  maxRequestTime: 5000,
  handlers: {
    requests: {
      doMoreMath: ({ a, b }) => {
        console.log("\n\n\n\n");
        console.log(
          `win1 webview asked me to do more math with: ${a} and ${b}`
        );
        return a + b;
      },
      bigRequest: (input: string) => {
        console.log("big request received", input.length);
        return "y".repeat(1024 * 1024 * 2) + "y";
      },
    },
    messages: {
      "*": (messageName, payload) => {
        console.log("----------.,.,.,.", messageName, payload);
      },
      logToBun: ({ msg }) => {
        console.log(
          "^^^^^^^^^^^^^^^^^^^^^^^^^------------............ received message",
          msg
        );
        // console.log('\n\nWebview asked to logToBun: ', msg, '\n\n')
      },
    },
  },
});

// console.log('creating browser window')
const win = new BrowserWindow({
  title: "my url window",
  url: "views://mainview/index.html",
  renderer: "cef",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
  rpc: myWebviewRPC,
  
});

  win.webview.on("dom-ready", () => {
    console.log('---->:::2 main window dom-ready')
    // We never want the main window to navigate or reload once it's loaded
    win.webview.on("will-navigate", (e) => {
      console.log('---->:::3 main window will navigate')
      e.response = { allow: false };
    });
  });

win.setTitle("url browserwindow");

// Handle window close events
win.on("close", () => {
  console.log("Main window closed");
  // For the playground app, exit when the main window is closed
  process.exit(0);
});

setTimeout(async () => {
  const result = await win.webview.rpc?.request.evaluateJavascriptWithResponse({
    // script: `document.body.textContent`,
    script: `
    return new Promise(
      resolve => {
        setTimeout(() => {
          resolve(document.body.textContent + 'hi hi hi')
        }, 1000)
      }
    )
    `,
  });

  console.log("evaluateJavascriptWithResponse", result);
}, 1000);

const wikiWindow = new BrowserWindow({
  title: "my url window",
  url: "https://en.wikipedia.org/wiki/Special:Random",
  preload: "views://myextension/preload.js",
  renderer: 'cef',
  frame: {
    width: 600,
    height: 600,
    x: 0,
    y: 0,
  },
  // todo (yoav): can we pass this to the webview's preload code so it doesn't have to be included
  // in the user's webview bundle?
  // rpc: createRPC<MyExtensionSchema["bun"], MyExtensionSchema["webview"]>({
  //     maxRequestTime: 5000,
  //     // requestHandler: {}
  // })         ,
  // todo: this should be in browserview so we can add internal handlers.
  rpc: BrowserView.defineRPC<MyExtensionSchema>({
    maxRequestTime: 5000,
    handlers: {
      requests: {},
      messages: {},
    },
  }),
});

wikiWindow.on("close", (event) => {
  const { id } = event.data;
  console.log("wiki window closed", id);
});

wikiWindow.on("resize", (event) => {
  const { id, x, y, width, height } = event.data;
  console.log("wiki window resized", id, x, y, width, height);
});

wikiWindow.on("move", (event) => {
  const { id, x, y } = event.data;
  console.log("wiki window moved", id, x, y);
});

const webviewTagWindow = new BrowserWindow({
  title: "webview tag test",
  url: "views://webviewtag/index.html",
  renderer: "cef",
  frame: {
    width: 1800,
    height: 1200,
    x: 1300,
    y: 100,
  },
  titleBarStyle: "hiddenInset",
});

webviewTagWindow.on("close", () => {
  console.log("Webview tag window closed");
});

// TODO: make this a unit test
// setTimeout(() => {
//   console.log("trashing item");
//   Utils.moveToTrash("/Users/yoav/Desktop/600x200_copy.jpg");
// }, 2000);

// TODO: make this a unit test
// setTimeout(() => {
//   console.log("open in finder");
//   Utils.showItemInFolder("/Users/yoav/Desktop/600x200_copy.jpg");
// }, 2000);

// TODO: make this a unit test
// will always return an array whether multiple selection is enabled or not
// if no file is chosen the array will be [""] ie: index 0 will have an empty string
// setTimeout(async () => {
//   console.log("open file dialogue");
//   const chosenPaths = await Utils.openFileDialog({
//     startingFolder: join(homedir(), "Desktop"),
//     allowedFileTypes: "*",
//     // allowedFileTypes: "png,jpg",
//     canChooseFiles: true,
//     canChooseDirectory: false,
//     allowsMultipleSelection: true,
//   });
//   console.log("chosen paths", chosenPaths);
// }, 2000);

// wikiWindow.setRPC()

// todo (yoav): typescript types should resolve for e and e.setResponse
Electrobun.events.on("will-navigate", (e) => {
  console.log("example global will navigate handler", e.data.detail, e.data.id);
  e.response = { allow: true };
});

wikiWindow.webview.on("will-navigate", (e) => {
  console.log("example webview will navigate handler", e.data.detail, e.data.id);
  if (e.responseWasSet && e.response.allow === false) {
    e.response.allow = true;
    // e.clearResponse();
  }
});

wikiWindow.webview.on("did-navigate", (e) => {
  console.log(
    "did-navigate event handler in bun for wikiWindow",
    e.data.detail
  );
});

wikiWindow.webview.on("dom-ready", (e) => {
  console.log(
    "dom-ready event handler in bun for wikiWindow",
    e.data.detail
  );
});

wikiWindow.setTitle("New title from bun");

setTimeout(() => {
  win.webview.executeJavascript(
    'document.body.innerHTML = "executing random js in win2 webview";'
  );

  setTimeout(() => {
    // asking wikipedia for the title of the article
    wikiWindow.webview.rpc?.request
      .getTitle()
      .then((result) => {
        console.log("\n\n\n\n");
        console.log(`visiting wikipedia article for: ${result}`);
        console.log("\n\n\n\n");
      })
      .catch((err) => {
        console.log("getTitle error", err);
      });

    win.webview.rpc?.request
      .doMath({ a: 3, b: 4 })
      .then((result) => {
        console.log("\n\n\n\n");
        console.log(`I asked win1 webview to do math and it said: ${result}`);
        console.log("\n\n\n\n");
      })
      .catch(() => {});

    win.webview.rpc?.send.logToWebview({ msg: "hi from bun!" });
  }, 1000);
}, 3000);

import { join, resolve } from "path";
import { type RPCSchema, type RPCTransport, createRPC } from "rpc-anywhere";
import { execSync } from "child_process";
import * as fs from "fs";
import electrobunEventEmitter from "../events/eventEmitter";
import { BrowserView } from "../core/BrowserView";
import { Updater } from "../core/Updater";
import { Tray } from "../core/Tray";



// todo: set up FFI, this is already in the webworker.

import {  dirname } from "path";
import { dlopen, suffix, JSCallback, CString, ptr, FFIType, toArrayBuffer } from "bun:ffi";
import { BrowserWindow, BrowserWindowMap } from "../core/BrowserWindow";



const native = (() => {
  try {
    return dlopen(`./libNativeWrapper.${suffix}`, {  
      // window
      createWindowWithFrameAndStyleFromWorker: {
        // Pass each parameter individually
        args: [
          FFIType.u32,                 // windowId
          FFIType.f64, FFIType.f64,    // x, y
          FFIType.f64, FFIType.f64,    // width, height    
          FFIType.u32,           // styleMask 
          FFIType.cstring,       // titleBarStyle
          FFIType.function,      // closeHandler
          FFIType.function,      // moveHandler
          FFIType.function      // resizeHandler
          
        ],
        returns: FFIType.ptr
      },
      setNSWindowTitle: {
        args: [
          FFIType.ptr, // window ptr
          FFIType.cstring, // title
        ],
        returns: FFIType.void,
      },
      makeNSWindowKeyAndOrderFront: {
        args: [
          FFIType.ptr, // window ptr      
        ],
        returns: FFIType.void,
      },
      // webview
      initWebview: {
        args: [
          FFIType.u32, // webviewId
          FFIType.ptr, // windowPtr
          FFIType.cstring, // renderer          
          FFIType.cstring, // url                              
          FFIType.f64, FFIType.f64,    // x, y
          FFIType.f64, FFIType.f64,    // width, height              
          FFIType.bool, // autoResize
          FFIType.cstring, // partition                    
          FFIType.function, // decideNavigation: *const fn (u32, [*:0]const u8) callconv(.C) bool,
          FFIType.function, // webviewEventHandler: *const fn (u32, [*:0]const u8, [*:0]const u8) callconv(.C) void,
          FFIType.function, //  bunBridgeHandler: *const fn (u32, [*:0]const u8) callconv(.C) void,
          FFIType.function, //  webviewTagBridgeHandler: *const fn (u32, [*:0]const u8) callconv(.C) void,
          FFIType.cstring, // electrobunPreloadScript
          FFIType.cstring, // customPreloadScript
        ],
        returns: FFIType.ptr
      },
      // MacOS specific native utils
      getNSWindowStyleMask: {
        args: [
          FFIType.bool,
          FFIType.bool,
          FFIType.bool,
          FFIType.bool,
          FFIType.bool,
          FFIType.bool,
          FFIType.bool,
          FFIType.bool,
          FFIType.bool,
          FFIType.bool,
          FFIType.bool,
          FFIType.bool,
        ],
        returns: FFIType.u32
      }, 
      // JSCallback utils for native code to use
      setJSUtils: {
        args: [
          FFIType.function, // get Mimetype from url/filename
          FFIType.function, // get html property from webview
        ],
        returns: FFIType.void
      },   
      killApp: {
        args: [],
        returns: FFIType.void
      },
      testFFI2: {
        args: [FFIType.function],
        returns: FFIType.void
      }
    });
  } catch (err) {
    console.log('FATAL Error opening native FFI', err)
    process.exit();
  }
})();

const callbacks = [];
// TODO XX: rename this file and export and everything to something ffi like
// TODO XX: get it all working without CEF then resolve the path issues for CEF
// NOTE: Bun seems to hit limits on args or arg types. eg: trying to send 12 bools results 
// in only about 8 going through then params after that. I think it may be similar to 
// a zig bug I ran into last year. So check number of args in a signature when alignment issues occur.
export const zigRPC = {
  request: {
    createWindow: (params: {
        id: number,
        url: string | null,        
        title: string,
        frame: {
          width: number,
          height: number,
          x: number,
          y: number,
        },
        styleMask: {
          Borderless: boolean,
          Titled: boolean,
          Closable: boolean,
          Miniaturizable: boolean,
          Resizable: boolean,
          UnifiedTitleAndToolbar: boolean,
          FullScreen: boolean,
          FullSizeContentView: boolean,
          UtilityWindow: boolean,
          DocModalWindow: boolean,
          NonactivatingPanel: boolean,
          HUDWindow: boolean,
        },
        titleBarStyle: string,
      }): FFIType.ptr => {
        const {id, url, title, frame: {x, y, width, height}, styleMask: {
            Borderless,
            Titled,
            Closable,
            Miniaturizable,
            Resizable,
            UnifiedTitleAndToolbar,
            FullScreen,
            FullSizeContentView,
            UtilityWindow,
            DocModalWindow,
            NonactivatingPanel,
            HUDWindow
          }, 
          titleBarStyle} = params
          
          const styleMask = native.symbols.getNSWindowStyleMask(
            Borderless,
            Titled,
            Closable,
            Miniaturizable,
            Resizable,
            UnifiedTitleAndToolbar,
            FullScreen,
            FullSizeContentView,
            UtilityWindow,
            DocModalWindow,
            NonactivatingPanel,
            HUDWindow
          )          
     
        const windowPtr = native.symbols.createWindowWithFrameAndStyleFromWorker(
          id, 
          // frame
          x, y, width, height, 
          styleMask,
          // style
          toCString(titleBarStyle),
          // callbacks
          windowCloseCallback,
          windowMoveCallback,
          windowResizeCallback,       
        );
        
        
        if (!windowPtr) {
          throw "Failed to create window"
        }
        
        native.symbols.setNSWindowTitle(windowPtr, toCString(title));        
        native.symbols.makeNSWindowKeyAndOrderFront(windowPtr);

        return windowPtr;
      },
      setTitle: (params: {winId: number, title: string}) => {
        const {winId, title} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;
          

        if (!windowPtr) {          
          throw `Can't add webview to window. window no longer exists`;
        }
        
        native.symbols.setNSWindowTitle(windowPtr, toCString(title));        
      },

      createWebview: (params: {
        id: number;
        windowId: number;
        renderer: "cef" | "native";
        rpcPort: number;
        secretKey: string;
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
        navigationRules: string | null;
      }): FFIType.ptr => {

        const { id,
          windowId,
          renderer,
          rpcPort,
          secretKey,
          // hostWebviewId: number | null;
          // pipePrefix: string;
          url,
          // html: string | null;    
          partition,
          preload,
          frame: {
            x,
            y,
            width,
            height,
          },
          autoResize} = params

          const windowPtr = BrowserWindow.getById(windowId)?.ptr;
          

        if (!windowPtr) {          
          throw `Can't add webview to window. window no longer exists`;
        }

        const electrobunPreload = `
         window.__electrobunWebviewId = ${id};
         window.__electrobunWindowId = ${windowId};
         window.__electrobunRpcSocketPort = ${rpcPort};
        (async () => {
        
         function base64ToUint8Array(base64) {
           return new Uint8Array(atob(base64).split('').map(char => char.charCodeAt(0)));
         }
        
        function uint8ArrayToBase64(uint8Array) {
         let binary = '';
         for (let i = 0; i < uint8Array.length; i++) {
           binary += String.fromCharCode(uint8Array[i]);
         }
         return btoa(binary);
        }
         const generateKeyFromText = async (rawKey) => {        
           return await window.crypto.subtle.importKey(
             'raw',                  // Key format
             rawKey,                 // Key data
             { name: 'AES-GCM' },    // Algorithm details
             true,                   // Extractable (set to false for better security)
             ['encrypt', 'decrypt']  // Key usages
           );
         };        
         const secretKey = await generateKeyFromText(new Uint8Array([${secretKey}]));
        
         const encryptString = async (plaintext) => {
           const encoder = new TextEncoder();
           const encodedText = encoder.encode(plaintext);
           const iv = window.crypto.getRandomValues(new Uint8Array(12)); // Initialization vector (12 bytes)
           const encryptedBuffer = await window.crypto.subtle.encrypt(
            {
             name: "AES-GCM",
             iv: iv,
            },
            secretKey,
            encodedText
           );
                
                
           // Split the tag (last 16 bytes) from the ciphertext
           const encryptedData = new Uint8Array(encryptedBuffer.slice(0, -16));
           const tag = new Uint8Array(encryptedBuffer.slice(-16));
        
           return { encryptedData: uint8ArrayToBase64(encryptedData), iv: uint8ArrayToBase64(iv), tag: uint8ArrayToBase64(tag) };
         };
         
         // All args passed in as base64 strings
         const decryptString = async (encryptedData, iv, tag) => {
          encryptedData = base64ToUint8Array(encryptedData);
          iv = base64ToUint8Array(iv);
          tag = base64ToUint8Array(tag);
          // Combine encrypted data and tag to match the format expected by SubtleCrypto
          const combinedData = new Uint8Array(encryptedData.length + tag.length);
          combinedData.set(encryptedData);
          combinedData.set(tag, encryptedData.length);
          const decryptedBuffer = await window.crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: iv,
            },
            secretKey,
            combinedData // Pass the combined data (ciphertext + tag)
          );
          const decoder = new TextDecoder();
          return decoder.decode(decryptedBuffer);
         };
        
         window.__electrobun_encrypt = encryptString;
         window.__electrobun_decrypt = decryptString;
        })()
        ` + `
         function emitWebviewEvent (eventName, detail) {
             if (window.webkit?.messageHandlers?.webviewTagBridge) {
                 window.webkit.messageHandlers.webviewTagBridge.postMessage(JSON.stringify({id: 'webviewEvent', type: 'message', payload: {id: window.__electrobunWebviewId, eventName, detail}}));
             } else {
                 window.webviewTagBridge.postMessage(JSON.stringify({id: 'webviewEvent', type: 'message', payload: {id: window.__electrobunWebviewId, eventName, detail}}));
             }
         };                 
        
         window.addEventListener('load', function(event) {
           // Check if the current window is the top-level window        
           if (window === window.top) {        
            emitWebviewEvent('dom-ready', document.location.href);
           }
         });
        
         window.addEventListener('popstate', function(event) {
          emitWebviewEvent('did-navigate-in-page', window.location.href);
         });
        
         window.addEventListener('hashchange', function(event) {
          emitWebviewEvent('did-navigate-in-page', window.location.href);    
         });
        
         document.addEventListener('click', function(event) {
          if ((event.metaKey || event.ctrlKey) && event.target.tagName === 'A') {
            event.preventDefault();
            event.stopPropagation();
        
            // Get the href of the link
            const url = event.target.href;        
            
            // Open the URL in a new window or tab
            // Note: we already handle new windows in objc
            window.open(url, '_blank');
          }
        }, true);
        
         // prevent overscroll
         document.addEventListener('DOMContentLoaded', () => {        
          var style = document.createElement('style');
          style.type = 'text/css';
          style.appendChild(document.createTextNode('html, body { overscroll-behavior: none; }'));
          document.head.appendChild(style);
         });
                
        `
        const customPreload = preload;
       
        console.log('url', url)

        const webviewPtr = native.symbols.initWebview(
          id,
          windowPtr,
          toCString(renderer),
          toCString(url || ''),                          
          x, y,  
          width, height,             
          autoResize,
          toCString(partition || 'persist:default'),
          webviewDecideNavigation,
          webviewEventHandler,
          bunBridgeHandler,
          webviewTagBridgeHandler,
          toCString(electrobunPreload),
          toCString(customPreload || ''),        
        )
        console.log('after after')

        if (!webviewPtr) {
           throw "Failed to create webview"
        }

        return webviewPtr;
      },
    
  }
}

// Worker management. Move to a different file
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in worker:', err); 
  // Since the main js event loop is blocked by the native event loop
  // we use FFI to dispatch a kill command to main
  native.symbols.killApp(); 
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection in worker:', reason);
});




// const testCallback = new JSCallback(
//   (windowId, x, y) => {
//     console.log(`TEST FFI Callback reffed GLOBALLY in js`);
//     // Your window move handler implementation
//   },
//   {
//     args: [],
//     returns: "void",
//     threadsafe: true,
    
//   }
// );


const windowCloseCallback = new JSCallback(
  (id) => {
    const handler = electrobunEventEmitter.events.window.close;
      const event = handler({
        id,
      });

      let result;
      // global event
      result = electrobunEventEmitter.emitEvent(event);

      result = electrobunEventEmitter.emitEvent(event, id);
  },
  {
    args: ["u32"],
    returns: "void",
    threadsafe: true,
  }
);

const windowMoveCallback = new JSCallback(
  (id, x, y) => {
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
  },
  {
    args: ["u32", "f64", "f64"],
    returns: "void",
    threadsafe: true,
  }
);

const windowResizeCallback = new JSCallback(
  (id, x, y, width, height) => {
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
  },
  {
    args: ["u32", "f64", "f64", "f64", "f64"],
    returns: "void",
    threadsafe: true,
  }
);

let responses = {};
// globalThis.nextResponseId = 0;

const getResponseData = new JSCallback((responseId) => {
  return responses[responseId].buffer;
}, {
  args: [FFIType.u32],
  returns: FFIType.ptr
})

const getResponseLength = new JSCallback((responseId) => {
  return responses[responseId].byteLength;
}, {
  args: [FFIType.u32],
  returns: FFIType.ptr
})

const getMimeType = new JSCallback((filePath) => {
  const _filePath = new CString(filePath).toString();
  const mimeType = Bun.file(_filePath).type;// || "application/octet-stream";
  console.log('found mimetype: ', mimeType);
  return toCString(mimeType);
}, {
  args: [FFIType.cstring],  
  returns: FFIType.cstring,
  // threadsafe: true
});

const getHTMLForWebviewSync = new JSCallback((webviewId) => {
  const webview = BrowserView.getById(webviewId);
  
  return toCString(webview?.html || '');
}, {
  args: [FFIType.cstring],  
  returns: FFIType.cstring,
  // threadsafe: true
});


native.symbols.setJSUtils(getMimeType, getHTMLForWebviewSync);

// TODO XX: revisit this as integrated into the will-navigate handler
const webviewDecideNavigation = new JSCallback((webviewId, url) => {
  console.log('webviewDecideNavigation', webviewId, new CString(url))
  return true;
}, {
  args: [FFIType.u32, FFIType.cstring],
  // NOTE: In Objc true is YES which is so dumb, but that doesn't work with Bun's FFIType.bool
  // in JSCallbacks right now (it always infers false) so to make this cross platform we have to use 
  // FFIType.u32 and uint32_t and then just treat it as a boolean in code.
  returns: FFIType.u32,
  threadsafe: true
});


const webviewEventHandler = new JSCallback((id, _eventName, _detail) => {
  const eventName = new CString(_eventName);
  const detail = new CString(_detail);
  
  console.log('webviewEventHandler', id, eventName)
  const eventMap = {
      "will-navigate": "willNavigate",
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
}, {
  args: [FFIType.u32, FFIType.cstring],
  returns: FFIType.void,
  threadsafe: true
});

const bunBridgeHandler = new JSCallback((id, msg) => {
  // const webview = BrowserView.getById(id);
  // console.log('bunBridgeHandler', id, new CString(msg));
  a('bunBridgeHandler');
}, {
  args: [FFIType.u32, FFIType.cstring],
  returns: FFIType.void,
  threadsafe: true
});
const a = (str) => {console.log('==========hi', str)}
const webviewTagBridgeHandler = new JSCallback((id, msg) => {
  const x = 'hi';
  const y = x + x;
  a();
  // console.log('hi')
  // console.log('webviewTagBridgeHandler', id, new CString(msg))
}, {
  args: [FFIType.u32, FFIType.cstring],
  returns: FFIType.void,
  threadsafe: true
});


// Note: When passed over FFI JS will GC the buffer/pointer. Make sure to use strdup() or something
// on the c side to duplicate the string so objc/c++ gc can own it
function toCString(jsString: string, addNullTerminator: boolean = true): CString {      
  let appendWith = '';
  
  if (addNullTerminator && !jsString.endsWith('\0')) {
    appendWith = '\0';
  }
    const buff = Buffer.from(jsString + appendWith, 'utf8');    
    
  // @ts-ignore - This is valid in Bun
  return ptr(buff);
}





// const CHUNK_SIZE = 1024 * 4; // 4KB
// todo (yoav): webviewBinaryPath and ELECTROBUN_VIEWS_FOLDER should be passed in as cli/env args by the launcher binary
// will likely be different on different platforms. Right now these are hardcoded for relative paths inside the mac app bundle.
// const webviewBinaryPath = "./webview";
// const webviewBinaryPath = "../Frameworks/Electrobun.app/Contents/MacOS/webview";

// const hash = await Updater.localInfo.hash();






// // Note: we use the build's hash to separate from different apps and different builds
// // but we also want a randomId to separate different instances of the same app
// // todo (yoav): since collisions can crash the app add a function that checks if the
// // file exists first
// const randomId = Math.random().toString(36).substring(7);
// const mainPipe = `/private/tmp/electrobun_ipc_pipe_${hash}_${randomId}_main_in`;

// try {
//   execSync("mkfifo " + mainPipe);
// } catch (e) {
//   console.log("pipe out already exists");
// }

// const zigProc = Bun.spawn([webviewBinaryPath], {
//   stdin: "pipe",
//   stdout: "pipe",
//   env: {
//     ...process.env,
//     ELECTROBUN_VIEWS_FOLDER: resolve("../Resources/app/views"),
//     MAIN_PIPE_IN: mainPipe,
//   },
//   onExit: (_zigProc) => {
//     // right now just exit the whole app if the webview process dies.
//     // in the future we probably want to try spin it back up aagain
//     process.exit(0);
//   },
// });

// process.on("SIGINT", (code) => {
//   // todo (yoav): maybe send a friendly signal to the webviews to let them know
//   // we're shutting down
//   // clean up the webview process when the bun process dies.
//   zigProc.kill();
//   // fs.unlinkSync(mainPipe);
//   process.exit();
// });

// process.on("exit", (code) => {
//   // Note: this can happen when the bun process crashes
//   // make sure that zigProc is killed so it doesn't linger around
//   zigProc.kill();
// });

// const inStream = fs.createWriteStream(mainPipe, {
//   flags: "r+",
// });

// function createStdioTransport(proc): RPCTransport {
//   return {
//     send(message) {
//       try {
//         // TODO: this is the same chunking code as browserview pipes,
//         // should dedupe
//         const messageString = JSON.stringify(message) + "\n";

//         let offset = 0;
//         while (offset < messageString.length) {
//           const chunk = messageString.slice(offset, offset + CHUNK_SIZE);
//           inStream.write(chunk);
//           offset += CHUNK_SIZE;
//         }
//       } catch (error) {
//         console.error("bun: failed to serialize message to zig", error);
//       }
//     },
//     registerHandler(handler) {
//       async function readStream(stream) {
//         const reader = stream.getReader();
//         let buffer = "";

//         try {
//           while (true) {
//             const { done, value } = await reader.read();
//             if (done) break;
//             buffer += new TextDecoder().decode(value);
//             let eolIndex;
//             // Process each line contained in the buffer
//             while ((eolIndex = buffer.indexOf("\n")) >= 0) {
//               const line = buffer.slice(0, eolIndex).trim();
//               buffer = buffer.slice(eolIndex + 1);
//               if (line) {
//                 try {
//                   const event = JSON.parse(line);
//                   handler(event);
//                 } catch (error) {
//                   // Non-json things are just bubbled up to the console.
//                   console.error("zig: ", line);
//                 }
//               }
//             }
//           }
//         } catch (error) {
//           console.error("Error reading from stream:", error);
//         } finally {
//           reader.releaseLock();
//         }
//       }

//       readStream(proc.stdout);
//     },
//   };
// }

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
      accelerator?: string;
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
      accelerator?: string;
    };

// todo (yoav): move this stuff to bun/rpc/zig.ts
type ZigHandlers = RPCSchema<{
  requests: {
    createWindow: {
      params: {
        id: number;
        url: string | null;        
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
        windowId: number;
        renderer: "cef" | "native";
        rpcPort: number;
        secretKey: string;
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
        navigationRules: string | null;
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

// const zigRPC = createRPC<BunHandlers, ZigHandlers>({
//   transport: createStdioTransport(zigProc),
//   requestHandler: {
//     log: ({ msg }) => {
//       console.log("zig: ", msg);
//       return { success: true };
//     },
//     trayEvent: ({ id, action }) => {
//       const tray = Tray.getById(id);
//       if (!tray) {
//         return { success: true };
//       }

//       const event = electrobunEventEmitter.events.tray.trayClicked({
//         id,
//         action,
//       });

//       let result;
//       // global event
//       result = electrobunEventEmitter.emitEvent(event);

//       result = electrobunEventEmitter.emitEvent(event, id);
//       // Note: we don't care about the result right now

//       return { success: true };
//     },
//     applicationMenuEvent: ({ id, action }) => {
//       const event = electrobunEventEmitter.events.app.applicationMenuClicked({
//         id,
//         action,
//       });

//       let result;
//       // global event
//       result = electrobunEventEmitter.emitEvent(event);

//       return { success: true };
//     },
//     contextMenuEvent: ({ action }) => {
//       const event = electrobunEventEmitter.events.app.contextMenuClicked({
//         action,
//       });

//       let result;
//       // global event
//       result = electrobunEventEmitter.emitEvent(event);

//       return { success: true };
//     },




//   },
//   maxRequestTime: 25000,
// });

// export { zigRPC, zigProc };

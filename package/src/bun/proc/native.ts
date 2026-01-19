import { join, resolve } from "path";
import { type RPCSchema, type RPCTransport, createRPC } from "rpc-anywhere";
import { execSync } from "child_process";
import * as fs from "fs";
import electrobunEventEmitter from "../events/eventEmitter";
import { BrowserView } from "../core/BrowserView";
import { Updater } from "../core/Updater";
import { Tray } from "../core/Tray";

// Menu data reference system to avoid serialization overhead
const menuDataRegistry = new Map<string, any>();
let menuDataCounter = 0;

function storeMenuData(data: any): string {
  const id = `menuData_${++menuDataCounter}`;
  menuDataRegistry.set(id, data);
  return id;
}

function getMenuData(id: string): any {
  return menuDataRegistry.get(id);
}

function clearMenuData(id: string): void {
  menuDataRegistry.delete(id);
}

// Shared methods for EB delimiter serialization/deserialization
const ELECTROBUN_DELIMITER = '|EB|';

function serializeMenuAction(action: string, data: any): string {
  const dataId = storeMenuData(data);
  return `${ELECTROBUN_DELIMITER}${dataId}|${action}`;
}

function deserializeMenuAction(encodedAction: string): { action: string; data: any } {
  let actualAction = encodedAction;
  let data = undefined;
  
  if (encodedAction.startsWith(ELECTROBUN_DELIMITER)) {
    const parts = encodedAction.split('|');
    if (parts.length >= 4) { // ['', 'EB', 'dataId', 'actualAction', ...]
      const dataId = parts[2];
      actualAction = parts.slice(3).join('|'); // Rejoin in case action contains |
      data = getMenuData(dataId);
      
      // Clean up data from registry after use
      clearMenuData(dataId);
    }
  }
  
  return { action: actualAction, data };
}

// todo: set up FFI, this is already in the webworker.

import {  dirname } from "path";
import { dlopen, suffix, JSCallback, CString, ptr, FFIType, toArrayBuffer } from "bun:ffi";
import { BrowserWindow, BrowserWindowMap } from "../core/BrowserWindow";



export const native = (() => {
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
          FFIType.bool,          // transparent
          FFIType.function,      // closeHandler
          FFIType.function,      // moveHandler
          FFIType.function,      // resizeHandler
          FFIType.function       // focusHandler
        ],
        returns: FFIType.ptr
      },
      setWindowTitle: {
        args: [
          FFIType.ptr, // window ptr
          FFIType.cstring, // title
        ],
        returns: FFIType.void,
      },
      showWindow: {
        args: [
          FFIType.ptr, // window ptr
        ],
        returns: FFIType.void,
      },
      closeWindow: {
        args: [
          FFIType.ptr, // window ptr
        ],
        returns: FFIType.void,
      },
      minimizeWindow: {
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
      restoreWindow: {
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
      isWindowMinimized: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
      maximizeWindow: {
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
      unmaximizeWindow: {
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
      isWindowMaximized: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
      setWindowFullScreen: {
        args: [FFIType.ptr, FFIType.bool],
        returns: FFIType.void,
      },
      isWindowFullScreen: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
      setWindowAlwaysOnTop: {
        args: [FFIType.ptr, FFIType.bool],
        returns: FFIType.void,
      },
      isWindowAlwaysOnTop: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
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
          FFIType.function, //  bunBridgePostmessageHandler: *const fn (u32, [*:0]const u8) callconv(.C) void,
          FFIType.function, //  internalBridgeHandler: *const fn (u32, [*:0]const u8) callconv(.C) void,
          FFIType.cstring, // electrobunPreloadScript
          FFIType.cstring, // customPreloadScript
          FFIType.bool, // transparent
        ],
        returns: FFIType.ptr
      },

      // webviewtag
      webviewCanGoBack: {
        args: [FFIType.ptr],
        returns: FFIType.bool
      },

      webviewCanGoForward: {
        args: [FFIType.ptr],
        returns: FFIType.bool
      },
      // TODO: Curently CEF doesn't support this directly
      // revisit after refactor
      // callAsyncJavaScript: {
      //   args: [
      //     FFIType.
      //   ],
      //   returns: FFIType.void
      // },
      resizeWebview: {
        args: [
          FFIType.ptr, // webview handle
          FFIType.f64, // x
          FFIType.f64, // y
          FFIType.f64, // width
          FFIType.f64, // height
          FFIType.cstring // maskJson
        ],
        returns: FFIType.void
      },

      loadURLInWebView: {
        args: [FFIType.ptr, FFIType.cstring],
        returns: FFIType.void
      },
      loadHTMLInWebView: {
        args: [FFIType.ptr, FFIType.cstring],
        returns: FFIType.void
      },
     
      updatePreloadScriptToWebView: {
        args: [
          FFIType.ptr, // webview handle
          FFIType.cstring,  // script identifier
          FFIType.cstring,  // script
          FFIType.bool  // allframes
        ],
        returns: FFIType.void
      },
      webviewGoBack: {
        args: [FFIType.ptr],
        returns: FFIType.void
      },
      webviewGoForward: {
        args: [FFIType.ptr],
        returns: FFIType.void
      },
      webviewReload: {
        args: [FFIType.ptr],
        returns: FFIType.void
      },
      webviewRemove: {
        args: [FFIType.ptr],
        returns: FFIType.void
      },
      setWebviewHTMLContent: {
        args: [FFIType.u32, FFIType.cstring],
        returns: FFIType.void
      },
      startWindowMove: {
        args: [FFIType.ptr],
        returns: FFIType.void
      },
      stopWindowMove: {
        args: [],
        returns: FFIType.void
      },
      webviewSetTransparent: {
        // TODO XX: bools or ints?
        args: [FFIType.ptr, FFIType.bool],
        returns: FFIType.void
      },
      webviewSetPassthrough: {
        args: [FFIType.ptr, FFIType.bool],
        returns: FFIType.void
      },
      webviewSetHidden: {
        args: [FFIType.ptr, FFIType.bool],
        returns: FFIType.void
      },
      setWebviewNavigationRules: {
        args: [FFIType.ptr, FFIType.cstring],
        returns: FFIType.void
      },
      webviewFindInPage: {
        args: [FFIType.ptr, FFIType.cstring, FFIType.bool, FFIType.bool],
        returns: FFIType.void
      },
      webviewStopFind: {
        args: [FFIType.ptr],
        returns: FFIType.void
      },
      evaluateJavaScriptWithNoCompletion: {
        args: [FFIType.ptr, FFIType.cstring],
        returns: FFIType.void
      },
      // Tray
      createTray: {
        args: [
          FFIType.u32, // id
          FFIType.cstring, // title
          FFIType.cstring, // pathToImage
          FFIType.bool, // isTemplate
          FFIType.u32, // width
          FFIType.u32, //height
          FFIType.function, // trayItemHandler
         ],
        returns: FFIType.ptr
      },
      setTrayTitle: {
        args: [FFIType.ptr, FFIType.cstring],
        returns: FFIType.void
      },
      setTrayImage: {
        args: [FFIType.ptr, FFIType.cstring],
        returns: FFIType.void
      },
      setTrayMenu: {
        args: [FFIType.ptr, FFIType.cstring],
        returns: FFIType.void
      },
      removeTray: {
        args: [FFIType.ptr],
        returns: FFIType.void
      },
      setApplicationMenu: {
        args: [FFIType.cstring, FFIType.function],
        returns: FFIType.void
      },
      showContextMenu: {
        args: [FFIType.cstring, FFIType.function],
        returns: FFIType.void
      },   
      moveToTrash: {
        args: [FFIType.cstring],
        returns: FFIType.bool
      },  
      showItemInFolder: {
        args: [FFIType.cstring],
        returns: FFIType.void
      },
      openExternal: {
        args: [FFIType.cstring],
        returns: FFIType.bool
      },
      openPath: {
        args: [FFIType.cstring],
        returns: FFIType.bool
      },
      showNotification: {
        args: [
          FFIType.cstring, // title
          FFIType.cstring, // body
          FFIType.cstring, // subtitle
          FFIType.bool,    // silent
        ],
        returns: FFIType.void
      },

      // Global keyboard shortcuts
      setGlobalShortcutCallback: {
        args: [FFIType.function],
        returns: FFIType.void
      },
      registerGlobalShortcut: {
        args: [FFIType.cstring],
        returns: FFIType.bool
      },
      unregisterGlobalShortcut: {
        args: [FFIType.cstring],
        returns: FFIType.bool
      },
      unregisterAllGlobalShortcuts: {
        args: [],
        returns: FFIType.void
      },
      isGlobalShortcutRegistered: {
        args: [FFIType.cstring],
        returns: FFIType.bool
      },

      // Screen API
      getAllDisplays: {
        args: [],
        returns: FFIType.cstring
      },
      getPrimaryDisplay: {
        args: [],
        returns: FFIType.cstring
      },
      getCursorScreenPoint: {
        args: [],
        returns: FFIType.cstring
      },

      openFileDialog: {
        args: [
          FFIType.cstring,
          FFIType.cstring,
          FFIType.int,
          FFIType.int,
          FFIType.int,
        ],
        returns: FFIType.cstring
      },
      showMessageBox: {
        args: [
          FFIType.cstring, // type
          FFIType.cstring, // title
          FFIType.cstring, // message
          FFIType.cstring, // detail
          FFIType.cstring, // buttons (comma-separated)
          FFIType.int,     // defaultId
          FFIType.int,     // cancelId
        ],
        returns: FFIType.int
      },

      // Clipboard API
      clipboardReadText: {
        args: [],
        returns: FFIType.cstring
      },
      clipboardWriteText: {
        args: [FFIType.cstring],
        returns: FFIType.void
      },
      clipboardReadImage: {
        args: [FFIType.ptr], // pointer to size_t for output size
        returns: FFIType.ptr  // pointer to PNG data
      },
      clipboardWriteImage: {
        args: [FFIType.ptr, FFIType.u64], // PNG data pointer, size
        returns: FFIType.void
      },
      clipboardClear: {
        args: [],
        returns: FFIType.void
      },
      clipboardAvailableFormats: {
        args: [],
        returns: FFIType.cstring
      },

      // Session/Cookie API
      sessionGetCookies: {
        args: [FFIType.cstring, FFIType.cstring],
        returns: FFIType.cstring
      },
      sessionSetCookie: {
        args: [FFIType.cstring, FFIType.cstring],
        returns: FFIType.bool
      },
      sessionRemoveCookie: {
        args: [FFIType.cstring, FFIType.cstring, FFIType.cstring],
        returns: FFIType.bool
      },
      sessionClearCookies: {
        args: [FFIType.cstring],
        returns: FFIType.void
      },
      sessionClearStorageData: {
        args: [FFIType.cstring, FFIType.cstring],
        returns: FFIType.void
      },

      // URL scheme handler (macOS only)
      setURLOpenHandler: {
        args: [FFIType.function], // handler callback
        returns: FFIType.void
      },

      // Window style utilities
      getWindowStyle: {
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
      },
      // FFIFn: {
      //   args: [],
      //   returns: FFIType.void
      // },
    });
  } catch (err) {
    console.log('FATAL Error opening native FFI:', err.message);
    console.log('This may be due to:');
    console.log('  - Missing libNativeWrapper.dll/so/dylib');
    console.log('  - Architecture mismatch (ARM64 vs x64)');
    console.log('  - Missing WebView2 or CEF dependencies');
    if (suffix === 'so') {
      console.log('  - Missing system libraries (try: ldd ./libNativeWrapper.so)');
    }
    console.log('Check that the build process completed successfully for your architecture.');
    process.exit();
  }
})();

const callbacks = [];

// NOTE: Bun seems to hit limits on args or arg types. eg: trying to send 12 bools results 
// in only about 8 going through then params after that. I think it may be similar to 
// a zig bug I ran into last year. So check number of args in a signature when alignment issues occur.

// TODO XX: maybe this should actually be inside BrowserWindow and BrowserView as static methods
export const ffi = {
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
        transparent: boolean,
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
          titleBarStyle,
          transparent} = params

          const styleMask = native.symbols.getWindowStyle(
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
          transparent,
          // callbacks
          windowCloseCallback,
          windowMoveCallback,
          windowResizeCallback,
          windowFocusCallback,
        );
        
        
        if (!windowPtr) {
          throw "Failed to create window"
        }
        
        native.symbols.setWindowTitle(windowPtr, toCString(title));
        native.symbols.showWindow(windowPtr);

        return windowPtr;
      },
      setTitle: (params: {winId: number, title: string}) => {
        const {winId, title} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;
          

        if (!windowPtr) {          
          throw `Can't add webview to window. window no longer exists`;
        }
        
        native.symbols.setWindowTitle(windowPtr, toCString(title));        
      },
      
      closeWindow: (params: {winId: number}) => {
        const {winId} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;
        
        if (!windowPtr) {
          throw `Can't close window. Window no longer exists`;
        }
        
        native.symbols.closeWindow(windowPtr);
        // Note: Cleanup of BrowserWindowMap happens in the windowCloseCallback
      },

      focusWindow: (params: {winId: number}) => {
        const {winId} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          throw `Can't focus window. Window no longer exists`;
        }

        native.symbols.showWindow(windowPtr);
      },

      minimizeWindow: (params: {winId: number}) => {
        const {winId} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          throw `Can't minimize window. Window no longer exists`;
        }

        native.symbols.minimizeWindow(windowPtr);
      },

      restoreWindow: (params: {winId: number}) => {
        const {winId} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          throw `Can't restore window. Window no longer exists`;
        }

        native.symbols.restoreWindow(windowPtr);
      },

      isWindowMinimized: (params: {winId: number}): boolean => {
        const {winId} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          return false;
        }

        return native.symbols.isWindowMinimized(windowPtr);
      },

      maximizeWindow: (params: {winId: number}) => {
        const {winId} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          throw `Can't maximize window. Window no longer exists`;
        }

        native.symbols.maximizeWindow(windowPtr);
      },

      unmaximizeWindow: (params: {winId: number}) => {
        const {winId} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          throw `Can't unmaximize window. Window no longer exists`;
        }

        native.symbols.unmaximizeWindow(windowPtr);
      },

      isWindowMaximized: (params: {winId: number}): boolean => {
        const {winId} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          return false;
        }

        return native.symbols.isWindowMaximized(windowPtr);
      },

      setWindowFullScreen: (params: {winId: number; fullScreen: boolean}) => {
        const {winId, fullScreen} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          throw `Can't set fullscreen. Window no longer exists`;
        }

        native.symbols.setWindowFullScreen(windowPtr, fullScreen);
      },

      isWindowFullScreen: (params: {winId: number}): boolean => {
        const {winId} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          return false;
        }

        return native.symbols.isWindowFullScreen(windowPtr);
      },

      setWindowAlwaysOnTop: (params: {winId: number; alwaysOnTop: boolean}) => {
        const {winId, alwaysOnTop} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          throw `Can't set always on top. Window no longer exists`;
        }

        native.symbols.setWindowAlwaysOnTop(windowPtr, alwaysOnTop);
      },

      isWindowAlwaysOnTop: (params: {winId: number}): boolean => {
        const {winId} = params;
        const windowPtr = BrowserWindow.getById(winId)?.ptr;

        if (!windowPtr) {
          return false;
        }

        return native.symbols.isWindowAlwaysOnTop(windowPtr);
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

          const parentWindow = BrowserWindow.getById(windowId);
          const windowPtr = parentWindow?.ptr;
          // Get transparent flag from parent window
          const transparent = parentWindow?.transparent ?? false;
          

        if (!windowPtr) {          
          throw `Can't add webview to window. window no longer exists`;
        }        

        const electrobunPreload = `
         window.__electrobunWebviewId = ${id};
         window.__electrobunWindowId = ${windowId};
         window.__electrobunRpcSocketPort = ${rpcPort};
         window.__electrobunInternalBridge = window.webkit?.messageHandlers?.internalBridge || window.internalBridge || window.chrome?.webview?.hostObjects?.internalBridge;
         window.__electrobunBunBridge = window.webkit?.messageHandlers?.bunBridge || window.bunBridge || window.chrome?.webview?.hostObjects?.bunBridge;
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
        })();
        ` + `
         function emitWebviewEvent (eventName, detail) {
           // Note: There appears to be some race bug with Bun FFI where sites can
           // init (like views://myview/index.html) so fast while the Bun FFI to load a url is still executing
           // or something where the JSCallback that this postMessage fires is not available or busy or
           // its memory is allocated to something else or something and the handler receives garbage data in Bun.
           setTimeout(() => {
              window.__electrobunInternalBridge?.postMessage(JSON.stringify({id: 'webviewEvent', type: 'message', payload: {id: window.__electrobunWebviewId, eventName, detail}}));
          });
         };

         // Allow preload scripts to send custom messages to the host webview
         // Usage: window.__electrobunSendToHost({ type: 'myEvent', data: {...} })
         window.__electrobunSendToHost = function(message) {
           emitWebviewEvent('host-message', JSON.stringify(message));
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

         // Track cmd key state for SPA navigation detection
         let __electrobunCmdKeyHeld = false;
         let __electrobunCmdKeyTimestamp = 0;
         const CMD_KEY_THRESHOLD_MS = 500; // How long after cmd release to still consider it a cmd+click

         window.addEventListener('keydown', function(event) {
           if (event.key === 'Meta' || event.metaKey) {
             __electrobunCmdKeyHeld = true;
             __electrobunCmdKeyTimestamp = Date.now();
           }
         }, true);

         window.addEventListener('keyup', function(event) {
           if (event.key === 'Meta') {
             __electrobunCmdKeyHeld = false;
             __electrobunCmdKeyTimestamp = Date.now();
           }
         }, true);

         // Also track on blur in case key release happens outside window
         window.addEventListener('blur', function() {
           __electrobunCmdKeyHeld = false;
         });

         function __electrobunIsCmdHeld() {
           if (__electrobunCmdKeyHeld) return true;
           // Also return true if cmd was released very recently (for race conditions)
           return (Date.now() - __electrobunCmdKeyTimestamp) < CMD_KEY_THRESHOLD_MS && __electrobunCmdKeyTimestamp > 0;
         }

         // Intercept cmd+clicks on anchors before SPA frameworks (like Turbo) can handle them
         // Uses capture phase on window - this fires before document capture listeners
         window.addEventListener('click', function(event) {
           if (event.metaKey || event.ctrlKey) {
             // Find the closest anchor element (handles clicks on nested elements inside <a>)
             const anchor = event.target.closest('a');
             if (anchor && anchor.href) {
               event.preventDefault();
               event.stopPropagation();
               event.stopImmediatePropagation();
               emitWebviewEvent('new-window-open', JSON.stringify({
                 url: anchor.href,
                 isCmdClick: true,
                 isSPANavigation: false
               }));
             }
           }
         }, true);

         // Intercept history.pushState and replaceState for SPA navigation
         // This catches cases where cmd is held but the SPA still manages to call pushState
         const originalPushState = history.pushState;
         const originalReplaceState = history.replaceState;

         history.pushState = function(state, title, url) {
           if (__electrobunIsCmdHeld() && url) {
             // Resolve relative URLs
             const resolvedUrl = new URL(url, window.location.href).href;
             emitWebviewEvent('new-window-open', JSON.stringify({
               url: resolvedUrl,
               isCmdClick: true,
               isSPANavigation: true
             }));
             // Don't call original - block the navigation
             return;
           }
           return originalPushState.apply(this, arguments);
         };

         history.replaceState = function(state, title, url) {
           if (__electrobunIsCmdHeld() && url) {
             const resolvedUrl = new URL(url, window.location.href).href;
             emitWebviewEvent('new-window-open', JSON.stringify({
               url: resolvedUrl,
               isCmdClick: true,
               isSPANavigation: true
             }));
             return;
           }
           return originalReplaceState.apply(this, arguments);
         };
        
         // prevent overscroll
         document.addEventListener('DOMContentLoaded', () => {        
          var style = document.createElement('style');
          style.type = 'text/css';
          style.appendChild(document.createTextNode('html, body { overscroll-behavior: none; }'));
          document.head.appendChild(style);
         });
                
        `
        const customPreload = preload;               

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
          webviewEventJSCallback,
          bunBridgePostmessageHandler,
          internalBridgeHandler,
          toCString(electrobunPreload),
          toCString(customPreload || ''),
          transparent,
        )        

        if (!webviewPtr) {
           throw "Failed to create webview"
        }

        return webviewPtr;
      },

      evaluateJavascriptWithNoCompletion: (params: {id: number; js: string}) => {
        const {id, js} = params;
        const webview = BrowserView.getById(id);
        
        if (!webview?.ptr) {
          return;
        }
        
        native.symbols.evaluateJavaScriptWithNoCompletion(webview.ptr, toCString(js))        
      },

      createTray: (params: {
        id: number;
        title: string;
        image: string;
        template: boolean;
        width: number;
        height: number;
      }): FFIType.ptr => {
        const {
          id,
          title,
          image,
          template,
          width,
          height
        } = params;

        const trayPtr =  native.symbols.createTray(
          id,
          toCString(title),
          toCString(image),
          template,
          width,
          height,
          trayItemHandler,
        );

        if (!trayPtr) {
          throw 'Failed to create tray';
        }

        return trayPtr;
      },
      setTrayTitle: (params: {
        id: number,
        title: string,
      }): void => {
        const {
          id,
          title
        } = params;

        const tray = Tray.getById(id);

        native.symbols.setTrayTitle(
          tray.ptr,
          toCString(title)
        );
      },
      setTrayImage: (params: {
        id: number,
        image: string,
      }): void => {
        const {
          id,
          image
        } = params;

        const tray = Tray.getById(id);

        native.symbols.setTrayImage(
          tray.ptr,
          toCString(image)
        );
      },
      setTrayMenu: (params: {        
          id: number,
          // json string of config
          menuConfig: string,
        }): void => {
        const {
          id,
          menuConfig
        } = params;

        const tray = Tray.getById(id);
        
        native.symbols.setTrayMenu(
          tray.ptr,
          toCString(menuConfig)
        );
      },

      removeTray: (params: { id: number }): void => {
        const { id } = params;        
        const tray = Tray.getById(id);        
        
        if (!tray) {
          throw `Can't remove tray. Tray no longer exists`;
        }
                
        native.symbols.removeTray(tray.ptr);        
        // The Tray class will handle removing from TrayMap
      },
      setApplicationMenu: (params: {menuConfig: string}): void => {
        const {
          menuConfig
        } = params;

        native.symbols.setApplicationMenu(
          toCString(menuConfig),
          applicationMenuHandler
        );
      },
      showContextMenu: (params: {menuConfig: string}): void => {
        const {
          menuConfig
        } = params;

        native.symbols.showContextMenu(
          toCString(menuConfig),
          contextMenuHandler
        );
      },
      moveToTrash: (params: {path: string}): boolean => {
        const {
          path
        } = params;

        return native.symbols.moveToTrash(toCString(path));        
      },
      showItemInFolder: (params: {path: string}): void => {
        const {
          path
        } = params;

        native.symbols.showItemInFolder(toCString(path));
      },
      openExternal: (params: {url: string}): boolean => {
        const { url } = params;
        return native.symbols.openExternal(toCString(url));
      },
      openPath: (params: {path: string}): boolean => {
        const { path } = params;
        return native.symbols.openPath(toCString(path));
      },
      showNotification: (params: {title: string, body?: string, subtitle?: string, silent?: boolean}): void => {
        const { title, body = '', subtitle = '', silent = false } = params;
        native.symbols.showNotification(
          toCString(title),
          toCString(body),
          toCString(subtitle),
          silent
        );
      },
      openFileDialog: (params: {startingFolder: string, allowedFileTypes: string, canChooseFiles: boolean, canChooseDirectory: boolean, allowsMultipleSelection: boolean}): string => {
        const {
          startingFolder,
          allowedFileTypes,
          canChooseFiles,
          canChooseDirectory,
          allowsMultipleSelection,
        } = params;
        const filePath = native.symbols.openFileDialog(toCString(startingFolder), toCString(allowedFileTypes), canChooseFiles, canChooseDirectory, allowsMultipleSelection);

        return filePath.toString();
      },
      showMessageBox: (params: {type?: string, title?: string, message?: string, detail?: string, buttons?: string[], defaultId?: number, cancelId?: number}): number => {
        const {
          type = 'info',
          title = '',
          message = '',
          detail = '',
          buttons = ['OK'],
          defaultId = 0,
          cancelId = -1,
        } = params;
        // Convert buttons array to comma-separated string
        const buttonsStr = buttons.join(',');
        return native.symbols.showMessageBox(
          toCString(type),
          toCString(title),
          toCString(message),
          toCString(detail),
          toCString(buttonsStr),
          defaultId,
          cancelId
        );
      },

      // Clipboard API
      clipboardReadText: (): string | null => {
        const result = native.symbols.clipboardReadText();
        if (!result) return null;
        return result.toString();
      },
      clipboardWriteText: (params: {text: string}): void => {
        native.symbols.clipboardWriteText(toCString(params.text));
      },
      clipboardReadImage: (): Uint8Array | null => {
        // Allocate a buffer for the size output
        const sizeBuffer = new BigUint64Array(1);
        const dataPtr = native.symbols.clipboardReadImage(ptr(sizeBuffer));

        if (!dataPtr) return null;

        const size = Number(sizeBuffer[0]);
        if (size === 0) return null;

        // Copy the data to a Uint8Array
        const result = new Uint8Array(size);
        const sourceView = new Uint8Array(toArrayBuffer(dataPtr, 0, size));
        result.set(sourceView);

        // Note: The native code allocated this memory with malloc
        // We should free it, but Bun's FFI doesn't expose free directly
        // The memory will be reclaimed when the process exits

        return result;
      },
      clipboardWriteImage: (params: {pngData: Uint8Array}): void => {
        const { pngData } = params;
        native.symbols.clipboardWriteImage(ptr(pngData), BigInt(pngData.length));
      },
      clipboardClear: (): void => {
        native.symbols.clipboardClear();
      },
      clipboardAvailableFormats: (): string[] => {
        const result = native.symbols.clipboardAvailableFormats();
        if (!result) return [];
        const formatsStr = result.toString();
        if (!formatsStr) return [];
        return formatsStr.split(',').filter(f => f.length > 0);
      },

      // ffifunc: (params: {}): void => {
      //   const {
          
      //   } = params;

      //   native.symbols.ffifunc(

      //   );
      // },
    
  },
   // Internal functions for menu data management
  internal: {
    storeMenuData,
    getMenuData,
    clearMenuData,
    serializeMenuAction,
    deserializeMenuAction,
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

process.on('SIGINT', () => {
  console.log('[electrobun] Received SIGINT, calling killApp() for graceful shutdown...');
  native.symbols.killApp();
});

process.on('SIGTERM', () => {
  console.log('[electrobun] Received SIGTERM, calling killApp() for graceful shutdown...');
  native.symbols.killApp();
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

const windowFocusCallback = new JSCallback(
  (id) => {
    const handler = electrobunEventEmitter.events.window.focus;
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

const getMimeType = new JSCallback((filePath) => {
  const _filePath = new CString(filePath).toString();
  const mimeType = Bun.file(_filePath).type;// || "application/octet-stream";

  // For this usecase we generally don't want the charset included in the mimetype 
  // otherwise it can break. eg: for html with text/javascript;charset=utf-8 browsers
  // will tend to render the code/text instead of interpreting the html.
  
  return toCString(mimeType.split(';')[0]);
}, {
  args: [FFIType.cstring],  
  returns: FFIType.cstring,
  // threadsafe: true
});

const getHTMLForWebviewSync = new JSCallback((webviewId) => {
  const webview = BrowserView.getById(webviewId);
  
  return toCString(webview?.html || '');
}, {
  args: [FFIType.u32],  
  returns: FFIType.cstring,
  // threadsafe: true
});


native.symbols.setJSUtils(getMimeType, getHTMLForWebviewSync);

// URL scheme open handler (macOS only)
// Receives URLs when the app is opened via custom URL schemes (e.g., myapp://path)
const urlOpenCallback = new JSCallback(
  (urlPtr) => {
    const url = new CString(urlPtr).toString();
    const handler = electrobunEventEmitter.events.app.openUrl;
    const event = handler({ url });
    electrobunEventEmitter.emitEvent(event);
  },
  {
    args: [FFIType.cstring],
    returns: "void",
    threadsafe: true,
  }
);

// Register the URL open handler with native code (macOS only)
if (process.platform === 'darwin') {
  native.symbols.setURLOpenHandler(urlOpenCallback);
}

// Global shortcut storage and callback
const globalShortcutHandlers = new Map<string, () => void>();

const globalShortcutCallback = new JSCallback(
  (acceleratorPtr) => {
    const accelerator = new CString(acceleratorPtr).toString();
    const handler = globalShortcutHandlers.get(accelerator);
    if (handler) {
      handler();
    }
  },
  {
    args: [FFIType.cstring],
    returns: "void",
    threadsafe: true,
  }
);

// Set up the global shortcut callback
native.symbols.setGlobalShortcutCallback(globalShortcutCallback);

// GlobalShortcut module for external use
export const GlobalShortcut = {
  /**
   * Register a global keyboard shortcut
   * @param accelerator - The shortcut string (e.g., "CommandOrControl+Shift+Space")
   * @param callback - Function to call when the shortcut is triggered
   * @returns true if registered successfully, false otherwise
   */
  register: (accelerator: string, callback: () => void): boolean => {
    if (globalShortcutHandlers.has(accelerator)) {
      return false; // Already registered
    }

    const result = native.symbols.registerGlobalShortcut(toCString(accelerator));
    if (result) {
      globalShortcutHandlers.set(accelerator, callback);
    }
    return result;
  },

  /**
   * Unregister a global keyboard shortcut
   * @param accelerator - The shortcut string to unregister
   * @returns true if unregistered successfully, false otherwise
   */
  unregister: (accelerator: string): boolean => {
    const result = native.symbols.unregisterGlobalShortcut(toCString(accelerator));
    if (result) {
      globalShortcutHandlers.delete(accelerator);
    }
    return result;
  },

  /**
   * Unregister all global keyboard shortcuts
   */
  unregisterAll: (): void => {
    native.symbols.unregisterAllGlobalShortcuts();
    globalShortcutHandlers.clear();
  },

  /**
   * Check if a shortcut is registered
   * @param accelerator - The shortcut string to check
   * @returns true if registered, false otherwise
   */
  isRegistered: (accelerator: string): boolean => {
    return native.symbols.isGlobalShortcutRegistered(toCString(accelerator));
  },
};

// Types for Screen API
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Display {
  id: number;
  bounds: Rectangle;
  workArea: Rectangle;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface Point {
  x: number;
  y: number;
}

// Screen module for display and cursor information
export const Screen = {
  /**
   * Get the primary display
   * @returns Display object for the primary monitor
   */
  getPrimaryDisplay: (): Display => {
    const jsonStr = native.symbols.getPrimaryDisplay();
    if (!jsonStr) {
      return {
        id: 0,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        workArea: { x: 0, y: 0, width: 0, height: 0 },
        scaleFactor: 1,
        isPrimary: true,
      };
    }
    try {
      return JSON.parse(jsonStr);
    } catch {
      return {
        id: 0,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        workArea: { x: 0, y: 0, width: 0, height: 0 },
        scaleFactor: 1,
        isPrimary: true,
      };
    }
  },

  /**
   * Get all connected displays
   * @returns Array of Display objects
   */
  getAllDisplays: (): Display[] => {
    const jsonStr = native.symbols.getAllDisplays();
    if (!jsonStr) {
      return [];
    }
    try {
      return JSON.parse(jsonStr);
    } catch {
      return [];
    }
  },

  /**
   * Get the current cursor position in screen coordinates
   * @returns Point with x and y coordinates
   */
  getCursorScreenPoint: (): Point => {
    const jsonStr = native.symbols.getCursorScreenPoint();
    if (!jsonStr) {
      return { x: 0, y: 0 };
    }
    try {
      return JSON.parse(jsonStr);
    } catch {
      return { x: 0, y: 0 };
    }
  },
};

// Types for Session/Cookie API
export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number; // Unix timestamp in seconds
}

export interface CookieFilter {
  url?: string;
  name?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  session?: boolean;
}

export type StorageType =
  | 'cookies'
  | 'localStorage'
  | 'sessionStorage'
  | 'indexedDB'
  | 'webSQL'
  | 'cache'
  | 'all';

// Cookies API for a session
class SessionCookies {
  private partitionId: string;

  constructor(partitionId: string) {
    this.partitionId = partitionId;
  }

  /**
   * Get cookies matching the filter criteria
   * @param filter - Optional filter to match cookies
   * @returns Array of matching cookies
   */
  get(filter?: CookieFilter): Cookie[] {
    const filterJson = JSON.stringify(filter || {});
    const result = native.symbols.sessionGetCookies(
      toCString(this.partitionId),
      toCString(filterJson)
    );
    if (!result) return [];
    try {
      return JSON.parse(result);
    } catch {
      return [];
    }
  }

  /**
   * Set a cookie
   * @param cookie - The cookie to set
   * @returns true if the cookie was set successfully
   */
  set(cookie: Cookie): boolean {
    const cookieJson = JSON.stringify(cookie);
    return native.symbols.sessionSetCookie(
      toCString(this.partitionId),
      toCString(cookieJson)
    );
  }

  /**
   * Remove a specific cookie
   * @param url - The URL associated with the cookie
   * @param name - The name of the cookie
   * @returns true if the cookie was removed successfully
   */
  remove(url: string, name: string): boolean {
    return native.symbols.sessionRemoveCookie(
      toCString(this.partitionId),
      toCString(url),
      toCString(name)
    );
  }

  /**
   * Clear all cookies for this session
   */
  clear(): void {
    native.symbols.sessionClearCookies(toCString(this.partitionId));
  }
}

// Session class representing a storage partition
class SessionInstance {
  readonly partition: string;
  readonly cookies: SessionCookies;

  constructor(partition: string) {
    this.partition = partition;
    this.cookies = new SessionCookies(partition);
  }

  /**
   * Clear storage data for this session
   * @param types - Array of storage types to clear, or 'all' to clear everything
   */
  clearStorageData(types: StorageType[] | 'all' = 'all'): void {
    const typesArray = types === 'all' ? ['all'] : types;
    native.symbols.sessionClearStorageData(
      toCString(this.partition),
      toCString(JSON.stringify(typesArray))
    );
  }
}

// Cache of session instances
const sessionCache = new Map<string, SessionInstance>();

// Session module for storage/cookie management
export const Session = {
  /**
   * Get or create a session for a given partition
   * @param partition - The partition identifier (e.g., "persist:myapp" or "ephemeral")
   * @returns Session instance for the partition
   */
  fromPartition: (partition: string): SessionInstance => {
    let session = sessionCache.get(partition);
    if (!session) {
      session = new SessionInstance(partition);
      sessionCache.set(partition, session);
    }
    return session;
  },

  /**
   * Get the default session (persist:default partition)
   */
  get defaultSession(): SessionInstance {
    return Session.fromPartition('persist:default');
  },
};

// DEPRECATED: This callback is no longer used for navigation decisions.
// Navigation rules are now stored in native code and evaluated synchronously
// without calling back to Bun. Use webview.setNavigationRules() instead.
// This callback is kept for FFI signature compatibility but is not called.
const webviewDecideNavigation = new JSCallback((webviewId, url) => {
  return true;
}, {
  args: [FFIType.u32, FFIType.cstring],
  returns: FFIType.u32,
  threadsafe: true
});


const webviewEventHandler = (id, eventName, detail) => {    
  const webview = BrowserView.getById(id);
  if (!webview) {
    console.error('[webviewEventHandler] No webview found for id:', id);
    return;
  }
  
  if (webview.hostWebviewId) {
    const hostWebview = BrowserView.getById(webview.hostWebviewId);

    if (!hostWebview) {
      console.error('[webviewEventHandler] No webview found for id:', id);
      return;
    }

    // This is a webviewtag so we should send the event into the parent as well
    // TODO XX: escape event name and detail to remove `
    // NOTE: for new-window-open and host-message the detail is a json string that needs to be parsed
    let js;
    if (eventName === 'new-window-open' || eventName === 'host-message') {
      js = `document.querySelector('#electrobun-webview-${id}').emit(\`${eventName}\`, ${detail});`
    } else {
      js = `document.querySelector('#electrobun-webview-${id}').emit(\`${eventName}\`, \`${detail}\`);`
    }
    
    native.symbols.evaluateJavaScriptWithNoCompletion(hostWebview.ptr, toCString(js))        
  }
    
  const eventMap = {
      "will-navigate": "willNavigate",
      "did-navigate": "didNavigate",
      "did-navigate-in-page": "didNavigateInPage",
      "did-commit-navigation": "didCommitNavigation",
      "dom-ready": "domReady",
      "new-window-open": "newWindowOpen",
      "host-message": "hostMessage",
      "download-started": "downloadStarted",
      "download-progress": "downloadProgress",
      "download-completed": "downloadCompleted",
      "download-failed": "downloadFailed",
      "load-started": "loadStarted",
      "load-committed": "loadCommitted", 
      "load-finished": "loadFinished",
    };

  // todo: the events map should use the same hyphenated names instead of camelCase
  const handler =
    electrobunEventEmitter.events.webview[eventMap[eventName]];

  if (!handler) {
    console.error('[webviewEventHandler] No handler found for event:', eventName, '(mapped to:', eventMap[eventName], ')');
    return { success: false };
  }

  // Parse JSON data for events that send JSON
  let parsedDetail = detail;
  if (eventName === "new-window-open" || eventName === "host-message" ||
      eventName === "download-started" || eventName === "download-progress" ||
      eventName === "download-completed" || eventName === "download-failed") {
    try {
      parsedDetail = JSON.parse(detail);
    } catch (e) {
      console.error('[webviewEventHandler] Failed to parse JSON:', e);
      // Fallback to string if parsing fails (backward compatibility)
      parsedDetail = detail;
    }
  }

  const event = handler({
    id,
    detail: parsedDetail,
  });  

  let result;
  // global event  
  result = electrobunEventEmitter.emitEvent(event);        
  result = electrobunEventEmitter.emitEvent(event, id);  
}

const webviewEventJSCallback = new JSCallback((id, _eventName, _detail) => {
  let eventName = "";
  let detail = "";

  try {
    // Convert cstring pointers to actual strings
    eventName = new CString(_eventName).toString();
    detail = new CString(_detail).toString();
  } catch (err) {
    console.error('[webviewEventJSCallback] Error converting strings:', err);
    console.error('[webviewEventJSCallback] Raw values:', { _eventName, _detail });
    return;
  }

  webviewEventHandler(id, eventName, detail);    
}, {
  args: [FFIType.u32, FFIType.cstring, FFIType.cstring],
  returns: FFIType.void,
  threadsafe: true
});



const bunBridgePostmessageHandler = new JSCallback((id, msg) => {    
  try {
    const msgStr = new CString(msg);
    
    if (!msgStr.length) {
      return;
    }
    const msgJson = JSON.parse(msgStr);    
    
    const webview = BrowserView.getById(id);
    
    webview.rpcHandler?.(msgJson).then(result => {      
    }).catch(err => console.log('error in rpchandler', err))
    
  } catch (err) {
    console.error('error sending message to bun: ', err)
    console.error('msgString: ', new CString(msg));
  }
    
  
}, {
  args: [FFIType.u32, FFIType.cstring],
  returns: FFIType.void,
  threadsafe: true
});

// internalRPC (bun <-> browser internal stuff)
// BrowserView.rpc (user defined bun <-> browser rpc unique to each webview)
// nativeRPC (internal bun <-> native rpc)


const internalBridgeHandler = new JSCallback((id, msg) => {    
  try {    
    const batchMessage = new CString(msg); 
    const jsonBatch = JSON.parse(batchMessage);

    if (jsonBatch.id === 'webviewEvent'){
      // Note: Some WebviewEvents from inside the webview are routed through here      
      // Others call the JSCallback directly from native code.
      const {payload} = jsonBatch;
      webviewEventHandler(payload.id, payload.eventName, payload.detail);
      return;
    }
    

    jsonBatch.forEach((msgStr) => {      
      // if (!msgStr.length) {
      //   console.error('WEBVIEW EVENT SENT TO WEBVIEW TAG BRIDGE HANDLER?', )
      //   return;
      // }
      const msgJson = JSON.parse(msgStr);    
      
      if (msgJson.type === 'message') {      
        const handler = internalRpcHandlers.message[msgJson.id];
        handler(msgJson.payload);
      } else if(msgJson.type === 'request') {      
        const hostWebview = BrowserView.getById(msgJson.hostWebviewId);
        // const targetWebview = BrowserView.getById(msgJson.params.params.hostWebviewId);
        const handler = internalRpcHandlers.request[msgJson.method];
        
        
        const payload = handler(msgJson.params);
        

        const resultObj = {
          type: 'response',
          id: msgJson.id,
          success: true,
          payload,
        }
        
        if (!hostWebview) {        
          console.log('--->>> internal request in bun: NO HOST WEBVIEW FOUND');
          return 
        }
              
        hostWebview.sendInternalMessageViaExecute(resultObj);          
      }
    });
          
    } catch (err) {
      console.error('error in internalBridgeHandler: ', err)
      // console.log('msgStr: ', id, new CString(msg));
    }        

    
}, {
  args: [FFIType.u32, FFIType.cstring],
  returns: FFIType.void,
  threadsafe: true
});

const trayItemHandler = new JSCallback((id, action) => {
  // Note: Some invisible character that doesn't appear in .length
  // is causing issues      
  const actionString = (new CString(action).toString() || "").trim();
  
  // Use shared deserialization method
  const { action: actualAction, data } = deserializeMenuAction(actionString);
  
  const event = electrobunEventEmitter.events.tray.trayClicked({
    id,
    action: actualAction,
    data, // Always include data property (undefined if no data)
  });

  let result;
  // global event
  result = electrobunEventEmitter.emitEvent(event);    
  result = electrobunEventEmitter.emitEvent(event, id);    
}, {
  args: [FFIType.u32, FFIType.cstring],
  returns: FFIType.void,
  threadsafe: true,
})


const applicationMenuHandler = new JSCallback((id, action) => {  
  const actionString = new CString(action).toString();
  
  // Use shared deserialization method
  const { action: actualAction, data } = deserializeMenuAction(actionString);
  
  const event = electrobunEventEmitter.events.app.applicationMenuClicked({
    id,
    action: actualAction,
    data, // Always include data property (undefined if no data)
  });
  
  // global event
  electrobunEventEmitter.emitEvent(event);
}, {
  args: [FFIType.u32, FFIType.cstring],
  returns: FFIType.void,
  threadsafe: true
})

const contextMenuHandler = new JSCallback((id, action) => {  
  const actionString = new CString(action).toString();
  
  // Use shared deserialization method
  const { action: actualAction, data } = deserializeMenuAction(actionString);
  
  const event = electrobunEventEmitter.events.app.contextMenuClicked({
    action: actualAction,
    data, // Always include data property (undefined if no data)
  });

  electrobunEventEmitter.emitEvent(event);
}, {
  args: [FFIType.u32, FFIType.cstring],
  returns: FFIType.void,
  threadsafe: true
})

// Note: When passed over FFI JS will GC the buffer/pointer. Make sure to use strdup() or something
// on the c side to duplicate the string so objc/c++ gc can own it
export function toCString(jsString: string, addNullTerminator: boolean = true): CString {      
  let appendWith = '';
  
  if (addNullTerminator && !jsString.endsWith('\0')) {
    appendWith = '\0';
  }
    const buff = Buffer.from(jsString + appendWith, 'utf8');    
    
  // @ts-ignore - This is valid in Bun
  return ptr(buff);
}



export const internalRpcHandlers = {
  request: {
  // todo: this shouldn't be getting method, just params.
    webviewTagInit: (params:
     BrowserViewOptions & { windowId: number }
    ) => {      
      
      const {
        hostWebviewId,
        windowId,
        renderer,
        html,
        preload,
        partition,
        frame,
        navigationRules,
      } = params;

      const url = !params.url && !html ? "https://electrobun.dev" : params.url;    

      const webviewForTag = new BrowserView({
        url,
        html,
        preload,
        partition,
        frame,
        hostWebviewId,
        autoResize: false,
        windowId,
        renderer,//: "cef",
        navigationRules,
      });      

      return webviewForTag.id;
    },  
    webviewTagCanGoBack: (params) => {      
      const {id} = params;
      const webviewPtr = BrowserView.getById(id)?.ptr;
      if (!webviewPtr) {
        console.error('no webview ptr')
        return false;
      }
      
      return native.symbols.webviewCanGoBack(webviewPtr);            
    },  
    webviewTagCanGoForward: (params) => {
      const {id} = params;
      const webviewPtr = BrowserView.getById(id)?.ptr;
      if (!webviewPtr) {
        console.error('no webview ptr')
        return false;
      }
      
      return native.symbols.webviewCanGoForward(webviewPtr);  
    },  
    webviewTagCallAsyncJavaScript: (params) => {
      console.log('TODO: webviewTagCallAsyncJavaScript NOT YET IMPLEMENTED', params)
      // Not implemented - users can use RPC for JavaScript execution if needed
    }
  },
  message: {
    webviewTagResize: (params) => {
      const browserView = BrowserView.getById(params.id);
      const webviewPtr = browserView?.ptr;
      
      if (!webviewPtr) {
        console.log('[Bun] ERROR: webviewTagResize - no webview ptr found for id:', params.id);
        return;
      }
      
      const {x, y, width, height} = params.frame;
      native.symbols.resizeWebview(webviewPtr, x, y, width, height, toCString(params.masks))
    },      
    webviewTagUpdateSrc: (params) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagUpdateSrc: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.loadURLInWebView(webview.ptr, toCString(params.url));      
    },
    webviewTagUpdateHtml: (params) => {      
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagUpdateHtml: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }   
      
      // Store HTML content in native map for scheme handlers
      native.symbols.setWebviewHTMLContent(webview.id, toCString(params.html));
      
      webview.loadHTML(params.html);
      webview.html = params.html;
    },
    webviewTagUpdatePreload: (params) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagUpdatePreload: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.updatePreloadScriptToWebView(webview.ptr, toCString('electrobun_custom_preload_script'), toCString(params.preload), true);
    },
    webviewTagGoBack: (params) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagGoBack: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.webviewGoBack(webview.ptr);
    },
    webviewTagGoForward: (params) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagGoForward: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.webviewGoForward(webview.ptr);
    },
    webviewTagReload: (params) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagReload: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.webviewReload(webview.ptr);
    },
    webviewTagRemove: (params) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagRemove: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.webviewRemove(webview.ptr);
    },
    startWindowMove: (params) => {
      const window = BrowserWindow.getById(params.id);
      native.symbols.startWindowMove(window.ptr);
    },
    stopWindowMove: (params) => {
      native.symbols.stopWindowMove();
    },
    webviewTagSetTransparent: (params) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagSetTransparent: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.webviewSetTransparent(webview.ptr, params.transparent);
    },
    webviewTagSetPassthrough: (params) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagSetPassthrough: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.webviewSetPassthrough(webview.ptr, params.enablePassthrough);
    },
    webviewTagSetHidden: (params) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagSetHidden: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.webviewSetHidden(webview.ptr, params.hidden);
    },
    webviewTagSetNavigationRules: (params: {id: number; rules: string[]}) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagSetNavigationRules: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      const rulesJson = JSON.stringify(params.rules);
      native.symbols.setWebviewNavigationRules(webview.ptr, toCString(rulesJson));
    },
    webviewTagFindInPage: (params: {id: number; searchText: string; forward: boolean; matchCase: boolean}) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagFindInPage: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.webviewFindInPage(webview.ptr, toCString(params.searchText), params.forward, params.matchCase);
    },
    webviewTagStopFind: (params: {id: number}) => {
      const webview = BrowserView.getById(params.id);
      if (!webview || !webview.ptr) {
        console.error(`webviewTagStopFind: BrowserView not found or has no ptr for id ${params.id}`);
        return;
      }
      native.symbols.webviewStopFind(webview.ptr);
    },
    webviewEvent: (params) => {
      console.log('-----------------+webviewEvent', params)
    },
  },
  
 
};

// todo: consider renaming to TrayMenuItemConfig
export type MenuItemConfig =
  | { type: "divider" | "separator" }
  | {
      type: "normal";
      label: string;
      tooltip?: string;
      action?: string;
      data?: any;
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
      data?: any;
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
      data?: any;
      submenu?: Array<ApplicationMenuItemConfig>;
      enabled?: boolean;
      checked?: boolean;
      hidden?: boolean;
      accelerator?: string;
    };

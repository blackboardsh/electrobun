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
          FFIType.function, //  bunBridgePostmessageHandler: *const fn (u32, [*:0]const u8) callconv(.C) void,
          FFIType.function, //  internalBridgeHandler: *const fn (u32, [*:0]const u8) callconv(.C) void,
          FFIType.cstring, // electrobunPreloadScript
          FFIType.cstring, // customPreloadScript
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
      },
      // FFIFn: {
      //   args: [],
      //   returns: FFIType.void
      // },
    });
  } catch (err) {
    console.log('FATAL Error opening native FFI', err)
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
              console.log('emitWebviewEvent', eventName, detail)             
              window.__electrobunInternalBridge?.postMessage(JSON.stringify({id: 'webviewEvent', type: 'message', payload: {id: window.__electrobunWebviewId, eventName, detail}}));
          });
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
        console.log('native.symbols.setTrayMenu', tray.ptr, menuConfig)
        native.symbols.setTrayMenu(
          tray.ptr,
          toCString(menuConfig)
        );
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
      
      // ffifunc: (params: {}): void => {
      //   const {
          
      //   } = params;

      //   native.symbols.ffifunc(

      //   );
      // },
    
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


const webviewEventHandler = (id, eventName, detail) => {
  const webview = BrowserView.getById(id);
  if (webview.hostWebviewId) {
    // This is a webviewtag so we should send the event into the parent as well
    // TODO XX: escape event name and detail to remove `
    const js = `document.querySelector('#electrobun-webview-${id}').emit(\`${eventName}\`, \`${detail}\`);`
    
    native.symbols.evaluateJavaScriptWithNoCompletion(webview.ptr, toCString(js))        
  }
    
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
}

const webviewEventJSCallback = new JSCallback((id, _eventName, _detail) => {  
  const eventName = new CString(_eventName);
  const detail = new CString(_detail);

  webviewEventHandler(id, eventName, detail);    
}, {
  args: [FFIType.u32, FFIType.cstring],
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
    console.log('--->>> internal request in bun');
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
        
        console.log('--->>> internal request in bun: sendingInternalMessageViaExecute', resultObj);

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
  const event = electrobunEventEmitter.events.tray.trayClicked({
    id,
    action: new CString(action),
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
  const event = electrobunEventEmitter.events.app.applicationMenuClicked({
    id,
    action: new CString(action),
  });
  
  // global event
  electrobunEventEmitter.emitEvent(event);  
}, {
  args: [FFIType.u32, FFIType.cstring],
  returns: FFIType.void,
  threadsafe: true
})

const contextMenuHandler = new JSCallback((id, action) => {  
  const event = electrobunEventEmitter.events.app.contextMenuClicked({
    action: new CString(action),
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
      console.log('------>>>>> webviewTagInit in bun');
      console.log('------>>>>> webviewTagInit in bun loading url: ', params.url);
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
      console.log('------>>>>> webviewTagInit in bun, loaded with id: ', webviewForTag.id);
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
      console.log('-----------+ request: ', 'webviewTagCallAsyncJavaScript', params)
    }
  },
  message: {
    webviewTagResize: (params) => {
      // console.log('------------------webviewTagResize', params)
      const webviewPtr = BrowserView.getById(params.id)?.ptr;
      const {x, y, width, height} = params.frame;      
      native.symbols.resizeWebview(webviewPtr, x, y, width, height, toCString(params.masks))
    },      
    webviewTagUpdateSrc: (params) => {
      const webviewPtr = BrowserView.getById(params.id)?.ptr;
      native.symbols.loadURLInWebView(webviewPtr, toCString(params.url))      
    },
    webviewTagUpdateHtml: (params) => {      
      const webview = BrowserView.getById(params.id);   
      webview.loadHTML(params.html) 
      webview.html = params.html;
      
    },
    webviewTagUpdatePreload: (params) => {
      const webview = BrowserView.getById(params.id);
      native.symbols.updatePreloadScriptToWebView(webview.ptr, toCString('electrobun_custom_preload_script'), toCString(params.preload), true);
    },
    webviewTagGoBack: (params) => {
      const webview = BrowserView.getById(params.id);
      native.symbols.webviewGoBack(webview.ptr);
    },
    webviewTagGoForward: (params) => {
      const webview = BrowserView.getById(params.id);
      native.symbols.webviewGoForward(webview.ptr);
    },
    webviewTagReload: (params) => {
      const webview = BrowserView.getById(params.id);
      native.symbols.webviewReload(webview.ptr);
    },
    webviewTagRemove: (params) => {
      const webview = BrowserView.getById(params.id);
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
      native.symbols.webviewSetTransparent(webview.ptr, params.transparent);
    },
    webviewTagSetPassthrough: (params) => {
      const webview = BrowserView.getById(params.id);
      native.symbols.webviewSetPassthrough(webview.ptr, params.enablePassthrough);
    },
    webviewTagSetHidden: (params) => {
      const webview = BrowserView.getById(params.id);
      native.symbols.webviewSetHidden(webview.ptr, params.hidden);
    },
    webviewEvent: (params) => {
      console.log('-----------------+webviewEvent', params)
    },
  }
};

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

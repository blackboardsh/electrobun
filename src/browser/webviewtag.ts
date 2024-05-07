import { type RPCSchema, type RPCTransport, createRPC } from "rpc-anywhere";

const ConfigureWebviewTags = (
  enableWebviewTags: boolean
): { receiveMessageFromZig: (msg: any) => void } => {
  if (!enableWebviewTags) {
    return {
      receiveMessageFromZig: () => {},
    };
  }

  // todo (yoav): move this stuff to browser/rpc/webview.ts
  type ZigWebviewHandlers = RPCSchema<{
    requests: {
      webviewTagInit: {
        params: {
          id: number;
          windowId: number;
          url: string | null;
          html: string | null;
          preload: string | null;
          frame: {
            width: number;
            height: number;
            x: number;
            y: number;
          };
        };
        response: void;
      };
    };
  }>;

  type WebviewTagHandlers = RPCSchema<{
    requests: {};
    messages: {
      webviewTagResize: {
        id: number;
        frame: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
      };
      webviewTagUpdateSrc: {
        id: number;
        url: string;
      };
      webviewTagGoBack: {
        id: number;
      };
      webviewTagGoForward: {
        id: number;
      };
      webviewTagReload: {
        id: number;
      };
    };
  }>;

  let rpcHandler: (msg: any) => void;

  function createStdioTransport(): RPCTransport {
    return {
      send(message) {
        window.webkit.messageHandlers.webviewTagBridge.postMessage(
          JSON.stringify(message)
        );
      },
      registerHandler(handler) {
        rpcHandler = handler;
        // webview tag doesn't handle any messages from zig just yet
      },
    };
  }

  // This will be attached to the global object, zig can rpc reply by executingJavascript
  // of that global reference to the function
  const receiveMessageFromZig = (msg: any) => {
    if (rpcHandler) {
      rpcHandler(msg);
    }
  };

  const webviewTagRPC = createRPC<WebviewTagHandlers, ZigWebviewHandlers>({
    transport: createStdioTransport(),
    // requestHandler: {

    // },
    maxRequestTime: 1000,
  });

  // TODO: webview ids are stored in zig/objc as u32. We need a way to guarantee that ones
  // created via webview tag across multiple windows don't conflict with ones created from bun
  let nextWebviewId = 10_000;

  class WebviewTag extends HTMLElement {
    // todo (yoav): come up with a better mechanism to eliminate collisions with bun created
    // webviews
    webviewId = nextWebviewId++;

    // rpc
    rpc: any;

    // observers
    resizeObserver?: ResizeObserver;
    intersectionObserver?: IntersectionObserver;
    mutationObserver?: MutationObserver;

    positionCheckLoop?: Timer;
    lastRect = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };

    constructor() {
      super();
      console.log("webview component created.");

      // Give it a frame to be added to the dom and render before measuring
      requestAnimationFrame(() => {
        this.initWebview();
      });
    }

    // TODO: implement proper rpc-anywhere style rpc here
    sendToZig(message: {}) {
      window.webkit.messageHandlers.webviewTagBridge.postMessage(
        JSON.stringify(message)
      );
    }

    initWebview() {
      const rect = this.getBoundingClientRect();
      this.lastRect = rect;

      webviewTagRPC.request.webviewTagInit({
        id: this.webviewId,
        windowId: window.__electrobunWindowId,
        url: this.getAttribute("src"),
        html: null,
        preload: null,
        frame: {
          width: rect.width,
          height: rect.height,
          x: rect.x,
          y: rect.y,
        },
      });
    }

    // Call this via document.querySelector('electrobun-webview').syncDimensions();
    // That way the host can trigger an alignment with the nested webview when they
    // know that they're chaning something in order to eliminate the lag that the
    // catch all loop will catch
    syncDimensions(force: boolean = false) {
      const rect = this.getBoundingClientRect();
      const { x, y, width, height } = rect;
      const lastRect = this.lastRect;

      if (
        force ||
        lastRect.x !== x ||
        lastRect.y !== y ||
        lastRect.width !== width ||
        lastRect.height !== height
      ) {
        this.lastRect = rect;

        webviewTagRPC.send.webviewTagResize({
          id: this.webviewId,
          frame: {
            width: width,
            height: height,
            x: x,
            y: y,
          },
        });
      }
    }

    boundSyncDimensions = () => this.syncDimensions(true);

    connectedCallback() {
      // Note: Since there's not catch all way to listen for x/y changes
      // we have a 400ms interval to check
      // on m1 max this 400ms interval for one nested webview
      // only uses around 0.1% cpu

      // Note: We also listen for resize events and changes to
      // certain properties to get reactive repositioning for
      // many cases.

      // todo: consider having an option to disable this and let user
      // trigger position sync for high performance cases (like
      // a browser with a hundred tabs)
      this.positionCheckLoop = setInterval(() => this.syncDimensions(), 400);

      this.resizeObserver = new ResizeObserver(() => {
        this.syncDimensions();
      });
      // Note: In objc the webview is positioned in the window from the bottom-left corner
      // the html anchor is positioned in the webview from the top-left corner
      // In those cases the getBoundingClientRect() will return the same value, but
      // we still need to send it to objc to calculate from its bottom left position
      // otherwise it'll move around unexpectedly.
      window.addEventListener("resize", this.boundSyncDimensions);

      // todo: For chromium webviews (windows native or chromium bundled)
      // should be able to use performanceObservers on layout-shift to
      // call syncDimensions more reactively
    }

    disconnectedCallback() {
      clearInterval(this.positionCheckLoop);
      this.resizeObserver?.disconnect();
      this.intersectionObserver?.disconnect();
      this.mutationObserver?.disconnect();
      window.removeEventListener("resize", this.boundSyncDimensions);
    }

    static get observedAttributes() {
      // TODO: support html, preload, and other stuff here
      return ["src", "class", "style"];
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (name === "src" && oldValue !== newValue) {
        this.updateIFrameSrc(newValue);
      } else {
        this.syncDimensions();
      }
    }

    updateIFrameSrc(src: string) {
      webviewTagRPC.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url: src,
      });
    }

    goBack() {
      webviewTagRPC.send.webviewTagGoBack({ id: this.webviewId });
    }

    goForward() {
      webviewTagRPC.send.webviewTagGoForward({ id: this.webviewId });
    }

    reload() {
      webviewTagRPC.send.webviewTagReload({ id: this.webviewId });
    }
  }

  customElements.define("electrobun-webview", WebviewTag);

  insertWebviewTagNormalizationStyles();

  return {
    receiveMessageFromZig,
  };
};

// Give <electrobun-webview>s some default styles that can
// be easily overridden in the host document
const insertWebviewTagNormalizationStyles = () => {
  var style = document.createElement("style");
  style.type = "text/css";

  var css = `
electrobun-webview {
    display: block;
    width: 800px;
    height: 300px;
    background: #333;
}
`;

  style.appendChild(document.createTextNode(css));

  var head = document.getElementsByTagName("head")[0];
  if (!head) {
    return;
  }

  if (head.firstChild) {
    head.insertBefore(style, head.firstChild);
  } else {
    head.appendChild(style);
  }
};

export { ConfigureWebviewTags };

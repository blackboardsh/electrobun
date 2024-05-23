const ConfigureWebviewTags = (
  enableWebviewTags: boolean,
  zigRpc: (params: any) => any
) => {
  if (!enableWebviewTags) {
    return;
  }

  // TODO: webview ids are stored in zig/objc as u32. We need a way to guarantee that ones
  // created via webview tag across multiple windows don't conflict with ones created from bun
  let nextWebviewId = 10_000;

  // todo: provide global types for <electrobun-webview> tag elements (like querySelector results etc.)

  class WebviewTag extends HTMLElement {
    // todo (yoav): come up with a better mechanism to eliminate collisions with bun created
    // webviews
    webviewId = nextWebviewId++;

    // rpc
    zigRpc: any;

    // observers
    resizeObserver?: ResizeObserver;
    intersectionObserver?: IntersectionObserver;
    mutationObserver?: MutationObserver;

    positionCheckLoop?: Timer;
    positionCheckLoopReset?: Timer;

    lastRect = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };

    id = `electrobun-webview-${this.webviewId}`;

    transparent: boolean = false;
    passthroughEnabled: boolean = false;
    delegateMode: boolean = false;

    constructor() {
      super();
      this.zigRpc = zigRpc;
      console.log("webview component created.");

      // Give it a frame to be added to the dom and render before measuring
      requestAnimationFrame(() => {
        this.initWebview();
      });
    }

    initWebview() {
      const rect = this.getBoundingClientRect();
      this.lastRect = rect;

      this.setAttribute("id", this.id);

      this.zigRpc.request.webviewTagInit({
        id: this.webviewId,
        windowId: window.__electrobunWindowId,
        url: this.src || this.getAttribute("src"),
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
        // if we're not already in an accelerated loop then accelerate it
        // if (!this.positionCheckLoopReset) {
        this.setPositionCheckLoop(true);
        // }

        this.lastRect = rect;

        this.zigRpc.send.webviewTagResize({
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

    setPositionCheckLoop(accelerate = false) {
      if (this.positionCheckLoop) {
        clearInterval(this.positionCheckLoop);
        this.positionCheckLoop = undefined;
      }

      if (this.positionCheckLoopReset) {
        clearTimeout(this.positionCheckLoopReset);
        this.positionCheckLoopReset = undefined;
      }

      const delay = accelerate ? 100 : 400;

      if (accelerate) {
        this.setDelegateMode(true);
        clearTimeout(this.positionCheckLoopReset);
        this.positionCheckLoopReset = setTimeout(() => {
          this.setPositionCheckLoop(false);
          this.setDelegateMode(false);
          // if (!this.transparent) {
          //   this.clearScreenImage();
          // }
        }, 1000);
      }
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
      this.positionCheckLoop = setInterval(() => this.syncDimensions(), delay);
    }

    connectedCallback() {
      this.setPositionCheckLoop();

      this.resizeObserver = new ResizeObserver(() => {
        this.syncDimensions();
      });
      // Note: In objc the webview is positioned in the window from the bottom-left corner
      // the html anchor is positioned in the webview from the top-left corner
      // In those cases the getBoundingClientRect() will return the same value, but
      // we still need to send it to objc to calculate from its bottom left position
      // otherwise it'll move around unexpectedly.
      window.addEventListener("resize", this.boundSyncDimensions);

      window.addEventListener("scroll", this.boundSyncDimensions);

      // todo: For chromium webviews (windows native or chromium bundled)
      // should be able to use performanceObservers on layout-shift to
      // call syncDimensions more reactively
    }

    disconnectedCallback() {
      // removed from the dom
      clearInterval(this.positionCheckLoop);
      this.resizeObserver?.disconnect();
      this.intersectionObserver?.disconnect();
      this.mutationObserver?.disconnect();
      window.removeEventListener("resize", this.boundSyncDimensions);
      window.removeEventListener("scroll", this.boundSyncDimensions);
      this.zigRpc.send.webviewTagRemove({ id: this.webviewId });
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
      this.zigRpc.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url: src,
      });
    }

    goBack() {
      this.zigRpc.send.webviewTagGoBack({ id: this.webviewId });
    }

    goForward() {
      this.zigRpc.send.webviewTagGoForward({ id: this.webviewId });
    }

    reload() {
      this.zigRpc.send.webviewTagReload({ id: this.webviewId });
    }
    loadURL(url: string) {
      this.setAttribute("src", url);
      this.zigRpc.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url,
      });
    }
    // Note: you can set an interval and do this 60 times a second and it's pretty smooth
    // but it uses quite a bit of cpu
    syncScreenshot() {
      // This will async fetch a screenshot of the nested webview from zig/objc and it'll call setScreenImage
      // for this webview when it's done
      this.zigRpc.send.webviewTagGetScreenshot({
        id: this.webviewId,
        hostId: window.__electrobunWebviewId,
      });
    }
    // This is called from zig, typically with a png data url
    setScreenImage(dataUrl: string) {
      console.log("setScreenImage");
      // preload the image before applying it so we don't see it load in the dom
      const img = new Image();
      img.src = dataUrl;
      img.onload = () => {
        // console.log("setScreenImage, dataUrl", dataUrl);
        this.style.backgroundImage = `url(${dataUrl})`;
      };
    }
    clearScreenImage() {
      console.log("clearScreenImage");
      this.style.backgroundImage = "";
    }
    // This sets the native webview hovering over the dom to be transparent
    toggleTransparent(transparent?: boolean, bypassState?: boolean) {
      if (!bypassState) {
        if (typeof transparent === "undefined") {
          this.transparent = !this.transparent;
        } else {
          this.transparent = transparent;
        }
      }

      if (!this.transparent && !transparent) {
        this.clearScreenImage();
      }

      this.zigRpc.send.webviewTagSetTransparent({
        id: this.webviewId,
        transparent: this.transparent || Boolean(transparent),
      });
    }
    togglePassthrough(enablePassthrough?: boolean, bypassState?: boolean) {
      if (!bypassState) {
        if (typeof enablePassthrough === "undefined") {
          this.passthroughEnabled = !this.passthroughEnabled;
        } else {
          this.passthroughEnabled = enablePassthrough;
        }
      }

      this.zigRpc.send.webviewTagSetPassthrough({
        id: this.webviewId,
        enablePassthrough:
          this.passthroughEnabled || Boolean(enablePassthrough),
      });
    }

    // Note: Delegate mode can be used when we want to temporarily layer the webview contents
    // in the host webview's z-index. This is done by:
    // 1. getting a screenshot of the webview's contents and setting it to the background of the webviewtag on the host
    // 2. setting the hovering native webview for the nested webviewtag to be invisible and pass through mouse events
    setDelegateMode(delegateMode: boolean) {
      this.delegateMode = delegateMode;
      if (delegateMode === true) {
        this.syncScreenshot();
        // give it a non-deterministic instant to load to avoid flicker
        setTimeout(() => {
          this.togglePassthrough(true, true);
          this.toggleTransparent(true, true);
        }, 100);
      } else {
        this.togglePassthrough(this.passthroughEnabled);
        this.toggleTransparent(this.transparent);
      }
    }
  }

  customElements.define("electrobun-webview", WebviewTag);

  insertWebviewTagNormalizationStyles();
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

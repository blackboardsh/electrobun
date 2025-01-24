import { zigRPC } from "../proc/zig";
import electrobunEventEmitter from "../events/eventEmitter";
import { BrowserView } from "./BrowserView";
import { type RPC } from "rpc-anywhere";

let nextWindowId = 1;

// todo (yoav): if we default to builtInSchema, we don't want dev to have to define custom handlers
// for the built-in schema stuff.
type WindowOptionsType<T = undefined> = {
  title: string;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  url: string | null;
  html: string | null;
  preload: string | null;
  rpc?: T;
  syncRpc?: { [method: string]: (params: any) => any };
  styleMask?: {};
  // TODO: implement all of them
  titleBarStyle: "hiddenInset" | "default";
  navigationRules: string | null;
};

const defaultOptions: WindowOptionsType = {
  title: "Electrobun",
  frame: {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  },
  url: "https://electrobun.dev",
  html: null,
  preload: null,
  titleBarStyle: "default",
  navigationRules: null,
};

const BrowserWindowMap = {};

// todo (yoav): do something where the type extends the default schema
// that way we can provide built-in requests/messages and devs can extend it

export class BrowserWindow<T> {
  id: number = nextWindowId++;
  title: string = "Electrobun";
  state: "creating" | "created" = "creating";
  url: string | null = null;
  html: string | null = null;
  preload: string | null = null;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  } = {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  };
  // todo (yoav): make this an array of ids or something
  webviewId: number;

  constructor(options: Partial<WindowOptionsType<T>> = defaultOptions) {
    this.title = options.title || "New Window";
    this.frame = options.frame
      ? { ...defaultOptions.frame, ...options.frame }
      : { ...defaultOptions.frame };
    this.url = options.url || null;
    this.html = options.html || null;
    this.preload = options.preload || null;
    this.navigationRules = options.navigationRules || null;

    this.init(options);
  }

  init({
    rpc,
    syncRpc,
    styleMask,
    titleBarStyle,
  }: Partial<WindowOptionsType<T>>) {
    zigRPC.request.createWindow({
      id: this.id,
      title: this.title,
      url: this.url,
      html: this.html,
      frame: {
        width: this.frame.width,
        height: this.frame.height,
        x: this.frame.x,
        y: this.frame.y,
      },
      styleMask: {
        Borderless: false,
        Titled: true,
        Closable: true,
        Miniaturizable: true,
        Resizable: true,
        UnifiedTitleAndToolbar: false,
        FullScreen: false,
        FullSizeContentView: false,
        UtilityWindow: false,
        DocModalWindow: false,
        NonactivatingPanel: false,
        HUDWindow: false,
        ...(styleMask || {}),
        ...(titleBarStyle === "hiddenInset"
          ? {
              Titled: true,
              FullSizeContentView: true,
            }
          : {}),
      },
      titleBarStyle: titleBarStyle || "default",
    });

    // todo (yoav): user should be able to override this and pass in their
    // own webview instance, or instances for attaching to the window.
    const webview = new BrowserView({
      // TODO: decide whether we want to keep sending url/html
      // here, if we're manually calling loadURL/loadHTML below
      // then we can remove it from the api here
      url: this.url,
      html: this.html,
      preload: this.preload,
      // frame: this.frame,
      frame: {
        x: 0,
        y: 0,
        width: this.frame.width,
        height: this.frame.height,
      },
      rpc,
      syncRpc,
      // todo: we need to send the window here and attach it in one go
      // then the view creation code in objc can toggle between offscreen
      // or on screen views depending on if windowId is null
      // does this mean browserView needs to track the windowId or handle it ephemerally?
      windowId: this.id,
      renderer: "cef", // or native(default) // passed on from opt
      navigationRules: this.navigationRules,
    });

    this.webviewId = webview.id;   

    BrowserWindowMap[this.id] = this;
  }

  get webview() {
    // todo (yoav): we don't want this to be undefined, so maybe we should just
    // link directly to the browserview object instead of a getter
    return BrowserView.getById(this.webviewId) as BrowserView<T>;
  }

  setTitle(title: string) {
    this.title = title;
    return zigRPC.request.setTitle({ winId: this.id, title });
  }

  close() {
    return zigRPC.request.closeWindow({ winId: this.id });
  }

  // todo (yoav): move this to a class that also has off, append, prepend, etc.
  // name should only allow browserWindow events
  on(name, handler) {
    const specificName = `${name}-${this.id}`;
    electrobunEventEmitter.on(specificName, handler);
  }
}

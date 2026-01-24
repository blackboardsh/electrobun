import { ffi } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import { BrowserView } from "./BrowserView";
import { type RPC } from "rpc-anywhere";
import {FFIType} from 'bun:ffi'
import { BuildConfig } from "./BuildConfig";

const buildConfig = await BuildConfig.get();

let nextWindowId = 1;

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
  renderer: 'native' | 'cef';
  rpc?: T;
  styleMask?: {};
  // titleBarStyle options:
  // - 'default': normal titlebar with native window controls
  // - 'hidden': no titlebar, no native window controls (for fully custom chrome)
  // - 'hiddenInset': transparent titlebar with inset native controls
  titleBarStyle: "hidden" | "hiddenInset" | "default";
  // transparent: when true, window background is transparent (see-through)
  transparent: boolean;
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
  renderer: buildConfig.defaultRenderer,
  titleBarStyle: "default",
  transparent: false,
  navigationRules: null,
};

export const BrowserWindowMap = {};

export class BrowserWindow<T> {
  id: number = nextWindowId++;
  ptr: FFIType.ptr;
  title: string = "Electrobun";
  state: "creating" | "created" = "creating";
  url: string | null = null;
  html: string | null = null;
  preload: string | null = null;
  renderer:  'native' | 'cef';
  transparent: boolean = false;
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
    this.renderer = options.renderer || defaultOptions.renderer;
    this.transparent = options.transparent ?? false;
    this.navigationRules = options.navigationRules || null;

    this.init(options);
  }

  init({
    rpc,
    styleMask,
    titleBarStyle,
    transparent,
  }: Partial<WindowOptionsType<T>>) {

    this.ptr = ffi.request.createWindow({
      id: this.id,
      title: this.title,
      url: this.url || "",
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
        // hiddenInset: transparent titlebar with inset native controls
        ...(titleBarStyle === "hiddenInset"
          ? {
              Titled: true,
              FullSizeContentView: true,
            }
          : {}),
        // hidden: no titlebar, no native controls (for fully custom chrome)
        ...(titleBarStyle === "hidden"
          ? {
              Titled: false,
              FullSizeContentView: true,
            }
          : {}),
      },
      titleBarStyle: titleBarStyle || "default",
      transparent: transparent ?? false,
    });

    BrowserWindowMap[this.id] = this;

    

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
      renderer: this.renderer, 
      frame: {
        x: 0,
        y: 0,
        width: this.frame.width,
        height: this.frame.height,
      },
      rpc,      
      // todo: we need to send the window here and attach it in one go
      // then the view creation code in objc can toggle between offscreen
      // or on screen views depending on if windowId is null
      // does this mean browserView needs to track the windowId or handle it ephemerally?
      windowId: this.id,
      navigationRules: this.navigationRules,
    });

    console.log('setting webviewId: ', webview.id)

    this.webviewId = webview.id;   
  }

  get webview() {    
    // todo (yoav): we don't want this to be undefined, so maybe we should just
    // link directly to the browserview object instead of a getter
    return BrowserView.getById(this.webviewId) as BrowserView<T>;
  }

  static getById(id: number) {
    return BrowserWindowMap[id];
  }

  setTitle(title: string) {
    this.title = title;
    return ffi.request.setTitle({ winId: this.id, title });
  }

  close() {
    return ffi.request.closeWindow({ winId: this.id });
  }

  focus() {
    return ffi.request.focusWindow({ winId: this.id });
  }

  show() {
    return ffi.request.focusWindow({ winId: this.id });
  }

  minimize() {
    return ffi.request.minimizeWindow({ winId: this.id });
  }

  unminimize() {
    return ffi.request.restoreWindow({ winId: this.id });
  }

  isMinimized(): boolean {
    return ffi.request.isWindowMinimized({ winId: this.id });
  }

  maximize() {
    return ffi.request.maximizeWindow({ winId: this.id });
  }

  unmaximize() {
    return ffi.request.unmaximizeWindow({ winId: this.id });
  }

  isMaximized(): boolean {
    return ffi.request.isWindowMaximized({ winId: this.id });
  }

  setFullScreen(fullScreen: boolean) {
    return ffi.request.setWindowFullScreen({ winId: this.id, fullScreen });
  }

  isFullScreen(): boolean {
    return ffi.request.isWindowFullScreen({ winId: this.id });
  }

  setAlwaysOnTop(alwaysOnTop: boolean) {
    return ffi.request.setWindowAlwaysOnTop({ winId: this.id, alwaysOnTop });
  }

  isAlwaysOnTop(): boolean {
    return ffi.request.isWindowAlwaysOnTop({ winId: this.id });
  }

  setPosition(x: number, y: number) {
    this.frame.x = x;
    this.frame.y = y;
    return ffi.request.setWindowPosition({ winId: this.id, x, y });
  }

  setSize(width: number, height: number) {
    this.frame.width = width;
    this.frame.height = height;
    return ffi.request.setWindowSize({ winId: this.id, width, height });
  }

  setFrame(x: number, y: number, width: number, height: number) {
    this.frame = { x, y, width, height };
    return ffi.request.setWindowFrame({ winId: this.id, x, y, width, height });
  }

  getFrame(): { x: number; y: number; width: number; height: number } {
    const frame = ffi.request.getWindowFrame({ winId: this.id });
    // Update internal state
    this.frame = frame;
    return frame;
  }

  getPosition(): { x: number; y: number } {
    const frame = this.getFrame();
    return { x: frame.x, y: frame.y };
  }

  getSize(): { width: number; height: number } {
    const frame = this.getFrame();
    return { width: frame.width, height: frame.height };
  }


  // todo (yoav): move this to a class that also has off, append, prepend, etc.
  // name should only allow browserWindow events
  on(name, handler) {
    const specificName = `${name}-${this.id}`;
    electrobunEventEmitter.on(specificName, handler);
  }
}

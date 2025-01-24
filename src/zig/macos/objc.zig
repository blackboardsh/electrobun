pub const WKNavigationResponsePolicy = enum(c_int) {
    cancel = 0,
    allow = 1,
    download = 2,
};

const CGFloat = f64;

const CGPoint = extern struct {
    x: CGFloat,
    y: CGFloat,
};

const CGSize = extern struct {
    width: CGFloat,
    height: CGFloat,
};

const NSRect = extern struct {
    origin: CGPoint,
    size: CGSize,
};

pub extern fn invokeDecisionHandler(decisionHandler: *anyopaque, policy: WKNavigationResponsePolicy) callconv(.C) void;
pub extern fn getUrlFromNavigationAction(navigationAction: *anyopaque) callconv(.C) [*:0]const u8;
pub extern fn getBodyFromScriptMessage(scriptMessage: *anyopaque) callconv(.C) [*:0]const u8;

pub extern fn getNilValue() callconv(.C) *anyopaque;
pub extern fn createNSRectWrapper(x: f64, y: f64, width: f64, height: f64) callconv(.C) *anyopaque;

// pub extern fn createNSWindowWithFrameAndStyle(frame: *anyopaque, styleMask: WindowStyleMaskOptions) callconv(.C) *anyopaque;
// application
pub extern fn runNSApplication() callconv(.C) void;

// window
pub const WindowStyleMaskOptions = extern struct {
    Borderless: bool = false,
    Titled: bool = false,
    Closable: bool = false,
    Miniaturizable: bool = false,
    Resizable: bool = false,
    UnifiedTitleAndToolbar: bool = false,
    FullScreen: bool = false,
    FullSizeContentView: bool = false,
    UtilityWindow: bool = false,
    DocModalWindow: bool = false,
    NonactivatingPanel: bool = false,
    HUDWindow: bool = false,
};

const createNSWindowWithFrameAndStyleParams = extern struct {
    frame: NSRect,
    styleMask: WindowStyleMaskOptions,
    titleBarStyle: [*:0]const u8,
};

// Note: this struct is mirrored in objective-c, it's returned by a zig function that is called by objc function
// so extern (c-compatible) struct is not enough
pub const FileResponse = extern struct {
    mimeType: [*:0]const u8,
    fileContents: [*]const u8,
    len: usize,
    opaquePointer: ?*anyopaque,
};

pub const FileLoader = *const fn (webviewId: u32, [*:0]const u8, [*:0]const u8) callconv(.C) FileResponse;
pub const SnapshotHandler = *const fn (hostId: u32, id: u32, [*:0]const u8) void;
pub const windowCloseHandler = *const fn (winId: u32) callconv(.C) void;
pub const windowMoveHandler = *const fn (winId: u32, x: f64, y: f64) callconv(.C) void;
pub const windowResizeHandler = *const fn (winId: u32, x: f64, y: f64, width: f64, height: f64) callconv(.C) void;
pub const callAsyncJavascriptCompletionHandler = *const fn (messageId: [*:0]const u8, webviewId: u32, hostWebviewId: u32, responseJSON: [*:0]const u8) callconv(.C) void;

pub extern fn createNSWindowWithFrameAndStyle(windowId: u32, createNSWindowWithFrameAndStyleParams, zigCloseHandler: windowCloseHandler, zigMoveHandler: windowMoveHandler, zigResizeHandler: windowResizeHandler) callconv(.C) *anyopaque;
pub extern fn makeNSWindowKeyAndOrderFront(window: *anyopaque) callconv(.C) void;
pub extern fn setNSWindowTitle(window: *anyopaque, title: [*:0]const u8) callconv(.C) void;
pub extern fn closeNSWindow(window: *anyopaque) callconv(.C) void;
pub extern fn getWindowBounds(window: *anyopaque) callconv(.C) *anyopaque;

// webview
pub extern fn initWebview(
    webviewId: u32,
    window: *anyopaque,
    renderer: [*:0]const u8,
    url: ?[*:0]const u8,
    html: ?[*:0]const u8,
    frame: NSRect,
    assetFileLoader: FileLoader,
    autoResize: bool,
    partition: [*:0]const u8,
    decideNavigation: *const fn (u32, [*:0]const u8) callconv(.C) bool,
    webviewEventHandler: *const fn (u32, [*:0]const u8, [*:0]const u8) callconv(.C) void,
    bunBridgeHandler: *const fn (u32, [*:0]const u8) callconv(.C) void,
    webviewTagBridgeHandler: *const fn (u32, [*:0]const u8) callconv(.C) void,
) callconv(.C) *anyopaque;
pub extern fn addPreloadScriptToWebView(webView: *anyopaque, script: [*:0]const u8, forMainFrameOnly: bool) callconv(.C) void;
pub extern fn updatePreloadScriptToWebView(webView: *anyopaque, scriptIdentifier: [*:0]const u8, script: [*:0]const u8, forMainFrameOnly: bool) callconv(.C) void;
pub extern fn loadURLInWebView(webView: *anyopaque, url: [*:0]const u8) callconv(.C) void;
pub extern fn loadHTMLInWebView(webView: *anyopaque, html: [*:0]const u8) callconv(.C) void;
// pub extern fn setNavigationDelegateWithCallback(webView: *anyopaque, webviewId: u32, decideNavigation: *const fn (u32, [*:0]const u8) callconv(.C) bool, webviewEventHandler: *const fn (u32, [*:0]const u8, [*:0]const u8) callconv(.C) void) callconv(.C) *anyopaque;
// pub extern fn addScriptMessageHandler(webView: *anyopaque, webviewId: u32, name: [*:0]const u8, handler: *const fn (u32, [*:0]const u8) callconv(.C) void) callconv(.C) *anyopaque;
pub extern fn addScriptMessageHandlerWithReply(webView: *anyopaque, webviewId: u32, name: [*:0]const u8, handler: *const fn (u32, [*:0]const u8) [*:0]const u8) callconv(.C) *anyopaque;
pub extern fn evaluateJavaScriptWithNoCompletion(webView: *anyopaque, script: [*:0]const u8) callconv(.C) void;
pub extern fn evaluateJavaScriptinSecureContentWorld(webView: *anyopaque, script: [*:0]const u8) callconv(.C) void;
pub extern fn callAsyncJavaScript(messageId: [*:0]const u8, webView: *anyopaque, script: [*:0]const u8, webviewId: u32, hostWebviewId: u32, handler: callAsyncJavascriptCompletionHandler) callconv(.C) void;
pub extern fn resizeWebview(webView: *anyopaque, frame: NSRect, masks: [*:0]const u8) callconv(.C) void;
pub extern fn webviewTagGoBack(webView: *anyopaque) callconv(.C) void;
pub extern fn webviewTagGoForward(webView: *anyopaque) callconv(.C) void;
pub extern fn webviewTagReload(webView: *anyopaque) callconv(.C) void;
pub extern fn webviewRemove(webView: *anyopaque) callconv(.C) void;
pub extern fn startWindowMove(window: *anyopaque) callconv(.C) void;
pub extern fn stopWindowMove(window: *anyopaque) callconv(.C) void;
pub extern fn getWebviewSnapshot(hostId: u32, id: u32, webView: *anyopaque, snapshotHandler: SnapshotHandler) callconv(.C) void;
pub extern fn webviewTagSetTransparent(webView: *anyopaque, transparent: bool) callconv(.C) void;
pub extern fn webviewTagToggleMirroring(webView: *anyopaque, enable: bool) callconv(.C) void;
pub extern fn webviewTagSetPassthrough(webView: *anyopaque, enablePassthrough: bool) callconv(.C) void;
pub extern fn webviewSetHidden(webView: *anyopaque, hidden: bool) callconv(.C) void;
pub extern fn webviewCanGoBack(webView: *anyopaque) callconv(.C) bool;
pub extern fn webviewCanGoForward(webView: *anyopaque) callconv(.C) bool;

// fs
pub extern fn moveToTrash(path: [*:0]const u8) callconv(.C) bool;
pub extern fn showItemInFolder(path: [*:0]const u8) callconv(.C) bool;
pub extern fn openFileDialog(startingFolder: [*:0]const u8, allowedFileTypes: [*:0]const u8, canChooseFiles: bool, canChooseDirectory: bool, allowsMultipleSelection: bool) callconv(.C) ?[*:0]const u8;

// system tray and menu
pub const TrayItemHandler = fn (trayId: u32, action: [*:0]const u8) void;

pub extern fn createTray(id: u32, title: [*:0]const u8, pathToImage: [*:0]const u8, template: bool, width: u32, height: u32, trayItemHandler: ?*const TrayItemHandler) *anyopaque;
pub extern fn setTrayTitle(trayItem: *anyopaque, title: [*:0]const u8) callconv(.C) void;
pub extern fn setTrayImage(trayItem: *anyopaque, image: [*:0]const u8) callconv(.C) void;
pub extern fn setTrayMenu(trayItem: *anyopaque, menuConfigJson: [*:0]const u8) callconv(.C) void;

// application menu
pub extern fn setApplicationMenu(menuConfigJson: [*:0]const u8, zigTrayItemHandler: ?*const TrayItemHandler) callconv(.C) void;

// context menu
// pub const ZigContextMenuHandler = fn (action: [*:0]const u8) void;
pub extern fn showContextMenu(menuConfigJson: [*:0]const u8, zigContextMenuHandler: ?*const TrayItemHandler) callconv(.C) void;

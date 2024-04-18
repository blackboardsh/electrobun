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
};

// Note: this struct is mirrored in objective-c, it's returned by a zig function that is called by objc function
// so extern (c-compatible) struct is not enough
pub const FileResponse = packed struct {
    mimeType: [*:0]const u8,
    fileContents: [*:0]const u8,
};

pub extern fn createNSWindowWithFrameAndStyle(createNSWindowWithFrameAndStyleParams) callconv(.C) *anyopaque;
pub extern fn makeNSWindowKeyAndOrderFront(window: *anyopaque) callconv(.C) void;
pub extern fn setNSWindowTitle(window: *anyopaque, title: [*:0]const u8) callconv(.C) void;
pub extern fn getWindowBounds(window: *anyopaque) callconv(.C) *anyopaque;
pub extern fn addWebviewToWindow(window: *anyopaque, view: *anyopaque) callconv(.C) void;

// webview
pub extern fn createAndReturnWKWebView(frame: NSRect, assetFileLoader: *const fn ([*:0]const u8) FileResponse, autoResize: bool) callconv(.C) *anyopaque;
pub extern fn addPreloadScriptToWebView(webView: *anyopaque, script: [*:0]const u8, forMainFrameOnly: bool) callconv(.C) void;
pub extern fn loadURLInWebView(webView: *anyopaque, url: [*:0]const u8) callconv(.C) void;
pub extern fn loadHTMLInWebView(webView: *anyopaque, html: [*:0]const u8) callconv(.C) void;
pub extern fn setNavigationDelegateWithCallback(webView: *anyopaque, webviewId: u32, delegate: *const fn (u32, [*:0]const u8) bool) callconv(.C) *anyopaque;
pub extern fn addScriptMessageHandlerWithCallback(webView: *anyopaque, webviewId: u32, name: [*:0]const u8, handler: *const fn (u32, [*:0]const u8) void) callconv(.C) *anyopaque;
pub extern fn evaluateJavaScriptWithNoCompletion(webView: *anyopaque, script: [*:0]const u8) callconv(.C) void;
pub extern fn resizeWebview(webView: *anyopaque, frame: NSRect) callconv(.C) void;

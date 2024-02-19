pub const WKNavigationResponsePolicy = enum(c_int) {
    cancel = 0,
    allow = 1,
    download = 2,
};

pub extern fn invokeDecisionHandler(decisionHandler: *anyopaque, policy: WKNavigationResponsePolicy) callconv(.C) void;
pub extern fn getUrlFromNavigationAction(navigationAction: *anyopaque) callconv(.C) [*:0]const u8;
pub extern fn getBodyFromScriptMessage(scriptMessage: *anyopaque) callconv(.C) [*:0]const u8;
pub extern fn evaluateJavaScriptWithNoCompletion(webView: *anyopaque, script: [*:0]const u8) callconv(.C) void;
pub extern fn getNilValue() callconv(.C) *anyopaque;

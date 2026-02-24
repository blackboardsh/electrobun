// devtools_cdp.h - Chrome DevTools Protocol (CDP) message passing
// Enables programmatic CDP access to CEF webviews without a remote debugging port.
// Uses CEF's CefBrowserHost::SendDevToolsMessage / AddDevToolsMessageObserver APIs.
//
// This is a header-only implementation to match the project convention.

#ifndef ELECTROBUN_DEVTOOLS_CDP_H
#define ELECTROBUN_DEVTOOLS_CDP_H

#include <cstdint>
#include <cstddef>

namespace electrobun {

// Callback invoked when a CDP method returns a result.
// webviewId: the Electrobun webview that owns the browser
// messageId: the "id" from the CDP request (for matching responses)
// success: true if the method succeeded
// result: raw UTF-8 JSON result string (only valid for the duration of the callback)
// resultSize: byte length of result
typedef void (*CDPMethodResultCallback)(
    uint32_t webviewId,
    int messageId,
    uint32_t success,
    const char* result,
    size_t resultSize
);

// Callback invoked when a CDP event fires (e.g. "Page.loadEventFired").
// webviewId: the Electrobun webview that owns the browser
// method: the CDP event name (e.g. "Network.requestWillBeSent")
// params: raw UTF-8 JSON params string (only valid for the duration of the callback)
// paramsSize: byte length of params
typedef void (*CDPEventCallback)(
    uint32_t webviewId,
    const char* method,
    const char* params,
    size_t paramsSize
);

} // namespace electrobun

#endif // ELECTROBUN_DEVTOOLS_CDP_H

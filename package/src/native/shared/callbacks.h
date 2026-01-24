// callbacks.h - Cross-platform callback type definitions
// Used for bridging between native code and Zig/Bun FFI across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_CALLBACKS_H
#define ELECTROBUN_CALLBACKS_H

#include <cstdint>

namespace electrobun {

// Webview navigation and event callbacks
// NOTE: Bun's FFIType.true doesn't play well with Objective-C's YES/NO char booleans
// so when sending booleans from JSCallbacks we use uint32_t
typedef uint32_t (*DecideNavigationCallback)(uint32_t webviewId, const char* url);
typedef void (*WebviewEventHandler)(uint32_t webviewId, const char* type, const char* url);
typedef uint32_t (*HandlePostMessage)(uint32_t webviewId, const char* message);
typedef const char* (*HandlePostMessageWithReply)(uint32_t webviewId, const char* message);
typedef void (*AsyncJavascriptCompletionHandler)(const char* messageId, uint32_t webviewId, uint32_t hostWebviewId, const char* responseJSON);

// Window event callbacks
typedef void (*WindowCloseHandler)(uint32_t windowId);
typedef void (*WindowMoveHandler)(uint32_t windowId, double x, double y);
typedef void (*WindowResizeHandler)(uint32_t windowId, double x, double y, double width, double height);
typedef void (*WindowFocusHandler)(uint32_t windowId);

// Tray and menu callbacks
typedef void (*StatusItemHandler)(uint32_t trayId, const char* action);
typedef void (*MenuHandler)(const char* menuItemId);

// Snapshot callback
typedef void (*SnapshotCallback)(uint32_t hostId, uint32_t webviewId, const char* dataUrl);

// URL open handler for deep linking
typedef void (*URLOpenHandler)(const char* url);

// JS Utils callbacks (DEPRECATED: Now using map-based approach instead)
typedef const char* (*GetMimeType)(const char* filePath);
typedef const char* (*GetHTMLForWebviewSync)(uint32_t webviewId);

} // namespace electrobun

#endif // ELECTROBUN_CALLBACKS_H

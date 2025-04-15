#include <cstdint>
#include <stdio.h>
#include <stdlib.h>

#define DLL_EXPORT __declspec(dllexport)

//---------------------------------------------------
// Type Declarations
//---------------------------------------------------

// Dummy types to represent opaque objects.
struct AbstractView {};
struct NSWindow {};
struct WKWebView {};
struct NSStatusItem {};

// A simple rectangle type.
struct NSRect {
    double x;
    double y;
    double width;
    double height;
};

// File response type for file-loading callbacks.
struct FileResponse {
    const char* mimeType;
    const char* fileContents;
    size_t len;
    void* opaquePointer;
};

// Callback typedef for file loading.
typedef FileResponse (*FileLoader)(uint32_t, const char*, const char*);

// Callback for snapshot handling.
typedef void (*SnapshotHandler)(uint32_t, uint32_t, const char*);

// Window event handler callbacks.
typedef void (*windowCloseHandler)(uint32_t);
typedef void (*windowMoveHandler)(uint32_t, double, double);
typedef void (*windowResizeHandler)(uint32_t, double, double, double, double);

// Tray item handler.
typedef void (*TrayItemHandler)(uint32_t, const char*);

// Structure for window style options.
struct WindowStyleMaskOptions {
    bool Borderless;
    bool Titled;
    bool Closable;
    bool Miniaturizable;
    bool Resizable;
    bool UnifiedTitleAndToolbar;
    bool FullScreen;
    bool FullSizeContentView;
    bool UtilityWindow;
    bool DocModalWindow;
    bool NonactivatingPanel;
    bool HUDWindow;
};

// Parameters for creating a window.
struct CreateNSWindowWithFrameAndStyleParams {
    NSRect frame;
    WindowStyleMaskOptions styleMask;
    const char* titleBarStyle;
};

// Callback for asynchronous JavaScript completion.
typedef void (*callAsyncJavascriptCompletionHandler)(const char* messageId, uint32_t webviewId, uint32_t hostWebviewId, const char* responseJSON);

//---------------------------------------------------
// Extern "C" Stub Implementations
//---------------------------------------------------

extern "C" {

// 1. Invoke a decision handler with a policy (stub).
DLL_EXPORT void invokeDecisionHandler(void* decisionHandler, int policy) {
    printf("invokeDecisionHandler called with policy: %d\n", policy);
}

// 2. Get URL from a navigation action (stub).
DLL_EXPORT const char* getUrlFromNavigationAction(void* navigationAction) {
    printf("getUrlFromNavigationAction called\n");
    return "http://example.com";
}

// 3. Get body from a script message (stub).
DLL_EXPORT const char* getBodyFromScriptMessage(void* scriptMessage) {
    printf("getBodyFromScriptMessage called\n");
    return "body";
}

// 4. Create an NSRect wrapper. Returns a pointer to a heap-allocated NSRect.
DLL_EXPORT void* createNSRectWrapper(double x, double y, double width, double height) {
    printf("createNSRectWrapper called with: %f, %f, %f, %f\n", x, y, width, height);
    NSRect* rect = (NSRect*)malloc(sizeof(NSRect));
    if (rect) {
        rect->x = x;
        rect->y = y;
        rect->width = width;
        rect->height = height;
    }
    return rect;
}

// 5. Run the NSApplication (stub).
DLL_EXPORT void runNSApplication() {
    printf("runNSApplication called\n");
}

// 6. Create a window with frame and style.
DLL_EXPORT void* createNSWindowWithFrameAndStyle(uint32_t windowId,
    CreateNSWindowWithFrameAndStyleParams params,
    windowCloseHandler zigCloseHandler,
    windowMoveHandler zigMoveHandler,
    windowResizeHandler zigResizeHandler) {
    printf("createNSWindowWithFrameAndStyle called with windowId: %u\n", windowId);
    // Stub: return a new NSWindow pointer.
    return new NSWindow();
}

// 7. Make the window key and order it to the front.
DLL_EXPORT void makeNSWindowKeyAndOrderFront(void* window) {
    printf("makeNSWindowKeyAndOrderFront called\n");
}

// 8. Set the window title.
DLL_EXPORT void setNSWindowTitle(void* window, const char* title) {
    printf("setNSWindowTitle called with title: %s\n", title);
}

// 9. Close the window.
DLL_EXPORT void closeNSWindow(void* window) {
    printf("closeNSWindow called\n");
}

// 10. Get the window bounds. Returns a pointer to a dummy NSRect.
DLL_EXPORT void* getWindowBounds(void* window) {
    printf("getWindowBounds called\n");
    NSRect* rect = (NSRect*)malloc(sizeof(NSRect));
    if (rect) {
        rect->x = 0;
        rect->y = 0;
        rect->width = 800;
        rect->height = 600;
    }
    return rect;
}

// 11. Initialize a webview.
DLL_EXPORT void* initWebview(uint32_t webviewId,
    void* window,
    const char* renderer,
    const char* url,
    NSRect frame,
    FileLoader assetFileLoader,
    bool autoResize,
    const char* partition,
    bool (*decideNavigation)(uint32_t, const char*),
    void (*webviewEventHandler)(uint32_t, const char*, const char*),
    void (*bunBridgeHandler)(uint32_t, const char*),
    void (*internalBridgeHandler)(uint32_t, const char*),
    const char* electrobunPreloadScript,
    const char* customPreloadScript) {
    printf("initWebview called with webviewId: %u, url: %s\n", webviewId, url);
    // Stub: return a new AbstractView pointer.
    return new AbstractView();
}

// 12. Add a preload script to a webview.
DLL_EXPORT void addPreloadScriptToWebView(void* webView, const char* script, bool forMainFrameOnly) {
    printf("addPreloadScriptToWebView called with script: %s\n", script);
}

// 13. Update a preload script.
DLL_EXPORT void updatePreloadScriptToWebView(void* webView, const char* scriptIdentifier, const char* script, bool forMainFrameOnly) {
    printf("updatePreloadScriptToWebView called with identifier: %s\n", scriptIdentifier);
}

// 14. Load a URL in the webview.
DLL_EXPORT void loadURLInWebView(void* webView, const char* url) {
    printf("loadURLInWebView called with url: %s\n", url);
}

// 15. Add a script message handler with reply.
DLL_EXPORT void* addScriptMessageHandlerWithReply(void* webView, uint32_t webviewId, const char* name, const char* (*handler)(uint32_t, const char*)) {
    printf("addScriptMessageHandlerWithReply called with webviewId: %u, name: %s\n", webviewId, name);
    // Stub: return a dummy pointer.
    return new AbstractView();
}

// 16. Evaluate JavaScript with no completion callback.
DLL_EXPORT void evaluateJavaScriptWithNoCompletion(void* webView, const char* script) {
    printf("evaluateJavaScriptWithNoCompletion called with script: %s\n", script);
}

// 17. Call asynchronous JavaScript.
DLL_EXPORT void callAsyncJavaScript(const char* messageId, void* webView, const char* script, uint32_t webviewId, uint32_t hostWebviewId, callAsyncJavascriptCompletionHandler handler) {
    printf("callAsyncJavaScript called with messageId: %s\n", messageId);
    // Optionally, invoke the completion handler with a dummy response.
    if (handler) {
        handler(messageId, webviewId, hostWebviewId, "dummy response");
    }
}

// 18. Resize the webview.
DLL_EXPORT void resizeWebview(void* webView, NSRect frame, const char* masks) {
    printf("resizeWebview called with frame: (%f, %f, %f, %f) and masks: %s\n", frame.x, frame.y, frame.width, frame.height, masks);
}

// 19. Go back in the webview.
DLL_EXPORT void webviewTagGoBack(void* webView) {
    printf("webviewTagGoBack called\n");
}

// 20. Go forward in the webview.
DLL_EXPORT void webviewTagGoForward(void* webView) {
    printf("webviewTagGoForward called\n");
}

// 21. Reload the webview.
DLL_EXPORT void webviewTagReload(void* webView) {
    printf("webviewTagReload called\n");
}

// 22. Remove the webview.
DLL_EXPORT void webviewRemove(void* webView) {
    printf("webviewRemove called\n");
}

// 23. Begin moving the window.
DLL_EXPORT void startWindowMove(void* window) {
    printf("startWindowMove called\n");
}

// 24. End moving the window.
DLL_EXPORT void stopWindowMove(void* window) {
    printf("stopWindowMove called\n");
}

// 25. Get a snapshot of the webview.
DLL_EXPORT void getWebviewSnapshot(uint32_t hostId, uint32_t id, void* webView, SnapshotHandler snapshotHandler) {
    printf("getWebviewSnapshot called with hostId: %u, id: %u\n", hostId, id);
    if (snapshotHandler) {
        snapshotHandler(hostId, id, "snapshot data");
    }
}

// 26. Set the webview's transparency.
DLL_EXPORT void webviewTagSetTransparent(void* webView, bool transparent) {
    printf("webviewTagSetTransparent called with transparent: %d\n", transparent);
}

// 27. Set the webview's passthrough.
DLL_EXPORT void webviewTagSetPassthrough(void* webView, bool enablePassthrough) {
    printf("webviewTagSetPassthrough called with enablePassthrough: %d\n", enablePassthrough);
}

// 28. Set the webview's hidden state.
DLL_EXPORT void webviewSetHidden(void* webView, bool hidden) {
    printf("webviewSetHidden called with hidden: %d\n", hidden);
}

// 29. Check if the webview can go back.
DLL_EXPORT bool webviewCanGoBack(void* webView) {
    printf("webviewCanGoBack called\n");
    return false;
}

// 30. Check if the webview can go forward.
DLL_EXPORT bool webviewCanGoForward(void* webView) {
    printf("webviewCanGoForward called\n");
    return false;
}

// 31. Move a file to trash.
DLL_EXPORT bool moveToTrash(const char* path) {
    printf("moveToTrash called with path: %s\n", path);
    return true;
}

// 32. Show an item in its folder.
DLL_EXPORT bool showItemInFolder(const char* path) {
    printf("showItemInFolder called with path: %s\n", path);
    return true;
}

// 33. Open a file dialog.
DLL_EXPORT const char* openFileDialog(const char* startingFolder, const char* allowedFileTypes, bool canChooseFiles, bool canChooseDirectory, bool allowsMultipleSelection) {
    printf("openFileDialog called with startingFolder: %s\n", startingFolder);
    return nullptr;
}

// 34. Create a system tray item.
DLL_EXPORT void* createTray(uint32_t id, const char* title, const char* pathToImage, bool templated, uint32_t width, uint32_t height, const TrayItemHandler* trayItemHandler) {
    printf("createTray called with id: %u, title: %s\n", id, title);
    // Stub: return a dummy tray item.
    return new NSStatusItem();
}

// 35. Set the tray item's title.
DLL_EXPORT void setTrayTitle(void* trayItem, const char* title) {
    printf("setTrayTitle called with title: %s\n", title);
}

// 36. Set the tray item's image.
DLL_EXPORT void setTrayImage(void* trayItem, const char* image) {
    printf("setTrayImage called with image: %s\n", image);
}

// 37. Set the tray item's menu.
DLL_EXPORT void setTrayMenu(void* trayItem, const char* menuConfigJson) {
    printf("setTrayMenu called with menuConfigJson: %s\n", menuConfigJson);
}

// 38. Set the application menu.
DLL_EXPORT void setApplicationMenu(const char* menuConfigJson, const TrayItemHandler* zigTrayItemHandler) {
    printf("setApplicationMenu called with menuConfigJson: %s\n", menuConfigJson);
}

// 39. Show a context menu.
DLL_EXPORT void showContextMenu(const char* menuConfigJson, const TrayItemHandler* zigContextMenuHandler) {
    printf("showContextMenu called with menuConfigJson: %s\n", menuConfigJson);
}

// 40. Test FFI by printing the pointer.
DLL_EXPORT void testFFI(void* ptr) {
    printf("testFFI called with ptr: %p\n", ptr);
}

} // end extern "C"

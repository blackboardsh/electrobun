#include <Windows.h>
#include <string>
#include <cstring>
#include <functional>
#include <vector>

// Forward declarations for classes
class AbstractView;
class NSWindow;
class NSStatusItem;
class WKWebView;

// Type definitions to match macOS types
// Note: uint32_t is already defined in <stdint.h>
#include <stdint.h>
// BOOL is already defined in Windows.h, so we'll use it directly
// Define CGFloat as double to match the 64-bit Mac version (or float for 32-bit)
typedef double CGFloat;

// Function pointer type definitions
typedef uint32_t (*DecideNavigationCallback)(uint32_t webviewId, const char* url);
typedef void (*WebviewEventHandler)(uint32_t webviewId, const char* type, const char* url);
typedef BOOL (*HandlePostMessage)(uint32_t webviewId, const char* message);
typedef const char* (*HandlePostMessageWithReply)(uint32_t webviewId, const char* message);
typedef void (*callAsyncJavascriptCompletionHandler)(const char *messageId, uint32_t webviewId, uint32_t hostWebviewId, const char *responseJSON);
typedef void (*WindowCloseHandler)(uint32_t windowId);
typedef void (*WindowMoveHandler)(uint32_t windowId, double x, double y);
typedef void (*WindowResizeHandler)(uint32_t windowId, double x, double y, double width, double height);
typedef void (*ZigStatusItemHandler)(uint32_t trayId, const char *action);
typedef void (*zigSnapshotCallback)(uint32_t hostId, uint32_t webviewId, const char * dataUrl);
typedef const char* (*GetMimeType)(const char* filePath);
typedef const char* (*GetHTMLForWebviewSync)(uint32_t webviewId);

// Stub classes for macOS types
class AbstractView {
public:
    uint32_t webviewId;
};

class NSWindow {
public:
    void* contentView;
};

class NSStatusItem {
public:
    void* button;
};

class MyScriptMessageHandlerWithReply {
public:
    HandlePostMessageWithReply zigCallback;
    uint32_t webviewId;
};

class WKWebView {
public:
    void* configuration;
};

struct NSRect {
    double x;
    double y;
    double width;
    double height;
};

struct createNSWindowWithFrameAndStyleParams {
    NSRect frame;
    uint32_t styleMask;
    const char *titleBarStyle;
};

// Implementation of the exported functions

// Ensure the exported functions have appropriate visibility
#define ELECTROBUN_EXPORT __declspec(dllexport)

extern "C" {

ELECTROBUN_EXPORT void runNSApplication() {
    // printf("runNSApplication in native code");
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    
}

ELECTROBUN_EXPORT void killApp() {
    // Stub implementation
    // Would terminate the process
    ExitProcess(1);
}

ELECTROBUN_EXPORT void shutdownApplication() {
    // Stub implementation
    // Would clean up resources
}

ELECTROBUN_EXPORT AbstractView* initWebview(uint32_t webviewId,
                         NSWindow *window,
                         const char *renderer,
                         const char *url,
                         double x, double y,
                         double width, double height,
                         bool autoResize,
                         const char *partitionIdentifier,
                         DecideNavigationCallback navigationCallback,
                         WebviewEventHandler webviewEventHandler,
                         HandlePostMessage bunBridgeHandler,
                         HandlePostMessage internalBridgeHandler,
                         const char *electrobunPreloadScript,
                         const char *customPreloadScript) {
    // Stub implementation
    AbstractView* view = new AbstractView();
    view->webviewId = webviewId;
    return view;
}

ELECTROBUN_EXPORT MyScriptMessageHandlerWithReply* addScriptMessageHandlerWithReply(WKWebView *webView,
                                                              uint32_t webviewId,
                                                              const char *name,
                                                              HandlePostMessageWithReply callback) {
    // Stub implementation
    MyScriptMessageHandlerWithReply* handler = new MyScriptMessageHandlerWithReply();
    handler->zigCallback = callback;
    handler->webviewId = webviewId;
    return handler;
}

ELECTROBUN_EXPORT void loadURLInWebView(AbstractView *abstractView, const char *urlString) {
    // Stub implementation
}

ELECTROBUN_EXPORT void webviewGoBack(AbstractView *abstractView) {
    // Stub implementation
}

ELECTROBUN_EXPORT void webviewGoForward(AbstractView *abstractView) {
    // Stub implementation
}

ELECTROBUN_EXPORT void webviewReload(AbstractView *abstractView) {
    // Stub implementation
}

ELECTROBUN_EXPORT void webviewRemove(AbstractView *abstractView) {
    // Stub implementation
    delete abstractView;
}

ELECTROBUN_EXPORT BOOL webviewCanGoBack(AbstractView *abstractView) {
    // Stub implementation
    return FALSE;
}

ELECTROBUN_EXPORT BOOL webviewCanGoForward(AbstractView *abstractView) {
    // Stub implementation
    return FALSE;
}

ELECTROBUN_EXPORT void evaluateJavaScriptWithNoCompletion(AbstractView *abstractView, const char *script) {
    // Stub implementation
}

ELECTROBUN_EXPORT void testFFI(void *ptr) {
    // Stub implementation
}

ELECTROBUN_EXPORT void callAsyncJavaScript(const char *messageId,
                        AbstractView *abstractView,
                        const char *jsString,
                        uint32_t webviewId,
                        uint32_t hostWebviewId,
                        callAsyncJavascriptCompletionHandler completionHandler) {
    // Stub implementation
    if (completionHandler) {
        completionHandler(messageId, webviewId, hostWebviewId, "\"\"");
    }
}

ELECTROBUN_EXPORT void addPreloadScriptToWebView(AbstractView *abstractView, const char *scriptContent, BOOL forMainFrameOnly) {
    // Stub implementation
}

ELECTROBUN_EXPORT void updatePreloadScriptToWebView(AbstractView *abstractView,
                                 const char *scriptIdentifier,
                                 const char *scriptContent,
                                 BOOL forMainFrameOnly) {
    // Stub implementation
}

ELECTROBUN_EXPORT void invokeDecisionHandler(void (*decisionHandler)(int), int policy) {
    // Stub implementation
    if (decisionHandler) {
        decisionHandler(policy);
    }
}

ELECTROBUN_EXPORT const char* getUrlFromNavigationAction(void *navigationAction) {
    // Stub implementation
    static const char* defaultUrl = "about:blank";
    return defaultUrl;
}

ELECTROBUN_EXPORT const char* getBodyFromScriptMessage(void *message) {
    // Stub implementation
    static const char* emptyString = "";
    return emptyString;
}

ELECTROBUN_EXPORT void webviewSetTransparent(AbstractView *abstractView, BOOL transparent) {
    // Stub implementation
}

ELECTROBUN_EXPORT void webviewSetPassthrough(AbstractView *abstractView, BOOL enablePassthrough) {
    // Stub implementation
}

ELECTROBUN_EXPORT void webviewSetHidden(AbstractView *abstractView, BOOL hidden) {
    // Stub implementation
}

ELECTROBUN_EXPORT NSRect createNSRectWrapper(double x, double y, double width, double height) {
    // Stub implementation
    NSRect rect = {x, y, width, height};
    return rect;
}

ELECTROBUN_EXPORT NSWindow* createNSWindowWithFrameAndStyle(uint32_t windowId,
                                         createNSWindowWithFrameAndStyleParams config,
                                         WindowCloseHandler zigCloseHandler,
                                         WindowMoveHandler zigMoveHandler,
                                         WindowResizeHandler zigResizeHandler) {
    // Stub implementation
    return new NSWindow();
}

ELECTROBUN_EXPORT void testFFI2(void (*completionHandler)()) {
    // Stub implementation
    if (completionHandler) {
        completionHandler();
    }
}

// Define a struct to store window data
typedef struct {
    uint32_t windowId;
    WindowCloseHandler closeHandler;
    WindowMoveHandler moveHandler;
    WindowResizeHandler resizeHandler;
} WindowData;

// Window procedure that will handle events and call your handlers
LRESULT CALLBACK CustomWindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    // Get our custom data
    WindowData* data = (WindowData*)GetWindowLongPtr(hwnd, GWLP_USERDATA);
    
    if (data) {
        switch (msg) {
            case WM_CLOSE:
                if (data->closeHandler) {
                    data->closeHandler(data->windowId);
                }
                return 0; // Don't close the window yet, let the handler decide
                
            case WM_MOVE:
                if (data->moveHandler) {
                    int x = LOWORD(lParam);
                    int y = HIWORD(lParam);
                    data->moveHandler(data->windowId, x, y);
                }
                break;
                
            case WM_SIZE:
                if (data->resizeHandler) {
                    int width = LOWORD(lParam);
                    int height = HIWORD(lParam);
                    data->resizeHandler(data->windowId, 0, 0, width, height);
                }
                break;
        }
    }
    
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

ELECTROBUN_EXPORT HWND createWindowWithFrameAndStyleFromWorker(
    uint32_t windowId,
    double x, double y,
    double width, double height,
    uint32_t styleMask,
    const char* titleBarStyle,
    WindowCloseHandler zigCloseHandler,
    WindowMoveHandler zigMoveHandler,
    WindowResizeHandler zigResizeHandler) {
    
    // Register window class with our custom procedure
    static bool classRegistered = false;
    if (!classRegistered) {
        WNDCLASS wc = {0};
        wc.lpfnWndProc = CustomWindowProc;
        wc.hInstance = GetModuleHandle(NULL);
        wc.lpszClassName = "BasicWindowClass";
        RegisterClass(&wc);
        classRegistered = true;
    }
    
    // Create window data structure to store callbacks
    WindowData* data = (WindowData*)malloc(sizeof(WindowData));
    if (!data) return NULL;
    
    data->windowId = windowId;
    data->closeHandler = zigCloseHandler;
    data->moveHandler = zigMoveHandler;
    data->resizeHandler = zigResizeHandler;
    
    // Map style mask to Windows style
    DWORD windowStyle = WS_OVERLAPPEDWINDOW; // Default
    
    // Create the window
    HWND hwnd = CreateWindow(
        "BasicWindowClass",
        "",
        windowStyle,
        (int)x, (int)y,
        (int)width, (int)height,
        NULL, NULL, GetModuleHandle(NULL), NULL
    );
    
    if (hwnd) {
        // Store our data with the window
        SetWindowLongPtr(hwnd, GWLP_USERDATA, (LONG_PTR)data);
        
        // Show the window
        ShowWindow(hwnd, SW_SHOW);
        UpdateWindow(hwnd);
    } else {
        // Clean up if window creation failed
        free(data);
    }
    
    return hwnd;
}

ELECTROBUN_EXPORT void makeNSWindowKeyAndOrderFront(NSWindow *window) {
    // Stub implementation
}

ELECTROBUN_EXPORT void setNSWindowTitle(NSWindow *window, const char *title) {
    // Stub implementation
}

ELECTROBUN_EXPORT void closeNSWindow(NSWindow *window) {
    // Stub implementation
    delete window;
}

ELECTROBUN_EXPORT void resizeWebview(AbstractView *abstractView, double x, double y, double width, double height, const char *masksJson) {
    // Stub implementation
}

ELECTROBUN_EXPORT void stopWindowMove() {
    // Stub implementation
}

ELECTROBUN_EXPORT void startWindowMove(NSWindow *window) {
    // Stub implementation
}

ELECTROBUN_EXPORT BOOL moveToTrash(char *pathString) {
    // Stub implementation
    return FALSE;
}

ELECTROBUN_EXPORT void showItemInFolder(char *path) {
    // Stub implementation
}

ELECTROBUN_EXPORT const char* openFileDialog(const char *startingFolder,
                          const char *allowedFileTypes,
                          BOOL canChooseFiles,
                          BOOL canChooseDirectories,
                          BOOL allowsMultipleSelection) {
    // Stub implementation
    return nullptr;
}

ELECTROBUN_EXPORT NSStatusItem* createTray(uint32_t trayId, const char *title, const char *pathToImage, bool isTemplate,
                        uint32_t width, uint32_t height, ZigStatusItemHandler zigTrayItemHandler) {
    // Stub implementation
    return new NSStatusItem();
}

ELECTROBUN_EXPORT void setTrayTitle(NSStatusItem *statusItem, const char *title) {
    // Stub implementation
}

ELECTROBUN_EXPORT void setTrayImage(NSStatusItem *statusItem, const char *image) {
    // Stub implementation
}

ELECTROBUN_EXPORT void setTrayMenuFromJSON(NSStatusItem *statusItem, const char *jsonString) {
    // Stub implementation
}

ELECTROBUN_EXPORT void setTrayMenu(NSStatusItem *statusItem, const char *menuConfig) {
    // Stub implementation
}

ELECTROBUN_EXPORT void setApplicationMenu(const char *jsonString, ZigStatusItemHandler zigTrayItemHandler) {
    // Stub implementation
}

ELECTROBUN_EXPORT void showContextMenu(const char *jsonString, ZigStatusItemHandler contextMenuHandler) {
    // Stub implementation
}

ELECTROBUN_EXPORT void getWebviewSnapshot(uint32_t hostId, uint32_t webviewId,
                       WKWebView *webView,
                       zigSnapshotCallback callback) {
    // Stub implementation
    if (callback) {
        static const char* emptyDataUrl = "data:image/png;base64,";
        callback(hostId, webviewId, emptyDataUrl);
    }
}

ELECTROBUN_EXPORT void setJSUtils(GetMimeType getMimeType, GetHTMLForWebviewSync getHTMLForWebviewSync) {
    // Stub implementation
}

// Adding a few Windows-specific functions for interop if needed
ELECTROBUN_EXPORT uint32_t getNSWindowStyleMask(
    bool Borderless,
    bool Titled,
    bool Closable,
    bool Miniaturizable,
    bool Resizable,
    bool UnifiedTitleAndToolbar,
    bool FullScreen,
    bool FullSizeContentView,
    bool UtilityWindow,
    bool DocModalWindow,
    bool NonactivatingPanel,
    bool HUDWindow) {
    // Stub implementation that returns a composite style mask
    uint32_t mask = 0;
    if (Borderless) mask |= 1;
    if (Titled) mask |= 2;
    if (Closable) mask |= 4;
    if (Resizable) mask |= 8;
    return mask;
}

} // extern "C"
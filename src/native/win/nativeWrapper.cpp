#include <Windows.h>
#include <string>
#include <cstring>
#include <functional>
#include <vector>

#include <iostream>
#include <fstream>
#include <string>
#include <ctime>

#include <functional>
#include <future>
#include <memory>

#include <windows.h>
#include <wrl.h>
#include <WebView2.h>
#include <string>

using namespace Microsoft::WRL;


#define WM_EXECUTE_SYNC_BLOCK (WM_USER + 1)

void log(const std::string& message) {
    // Get current time
    std::time_t now = std::time(0);
    std::string timeStr = std::ctime(&now);
    timeStr.pop_back(); // Remove newline character
    
    // Print to console
    std::cout << "[" << timeStr << "] " << message << std::endl;
    
    // Optionally write to file
    std::ofstream logFile("app.log", std::ios::app);
    if (logFile.is_open()) {
        logFile << "[" << timeStr << "] " << message << std::endl;
        logFile.close();
    }
}

class MainThreadDispatcher {
private:
    static HWND g_messageWindow;

public:
    static void initialize(HWND hwnd) {
        g_messageWindow = hwnd;
    }
    
    template<typename Func>
    static auto dispatch_sync(Func&& func) -> decltype(func()) {
        using ReturnType = decltype(func());
        
        if constexpr (std::is_void_v<ReturnType>) {
            auto promise = std::make_shared<std::promise<void>>();
            auto future = promise->get_future();
            
            auto task = new std::function<void()>([func = std::forward<Func>(func), promise]() {
                try {
                    func();
                    promise->set_value();
                } catch (...) {
                    promise->set_exception(std::current_exception());
                }
            });
            
            PostMessage(g_messageWindow, WM_EXECUTE_SYNC_BLOCK, 0, (LPARAM)task);
            future.get(); // Will re-throw any exceptions
        } else {
            auto promise = std::make_shared<std::promise<ReturnType>>();
            auto future = promise->get_future();
            
            auto task = new std::function<void()>([func = std::forward<Func>(func), promise]() {
                try {
                    promise->set_value(func());
                } catch (...) {
                    promise->set_exception(std::current_exception());
                }
            });
            
            PostMessage(g_messageWindow, WM_EXECUTE_SYNC_BLOCK, 0, (LPARAM)task);
            return future.get();
        }
    }
    
    static void handleSyncTask(LPARAM lParam) {
        auto task = (std::function<void()>*)lParam;
        (*task)();
        delete task;
    }
};

HWND MainThreadDispatcher::g_messageWindow = NULL;



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

// ELECTROBUN_EXPORT void runNSApplication() {
//     // printf("runNSApplication in native code");
//     MSG msg;
//     while (GetMessage(&msg, NULL, 0, 0)) {
//         TranslateMessage(&msg);
//         DispatchMessage(&msg);
//     }
    
// }

// handles window things on Windows
LRESULT CALLBACK MessageWindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_EXECUTE_SYNC_BLOCK:
            MainThreadDispatcher::handleSyncTask(lParam);
            return 0;
        default:
            return DefWindowProc(hwnd, msg, wParam, lParam);
    }
}
ELECTROBUN_EXPORT void runNSApplication() {
    // Create a hidden message-only window for dispatching
    WNDCLASS wc = {0};
    wc.lpfnWndProc = MessageWindowProc;
    wc.hInstance = GetModuleHandle(NULL);
    wc.lpszClassName = "MessageWindowClass";
    RegisterClass(&wc);
    
    HWND messageWindow = CreateWindow(
        "MessageWindowClass", 
        "", 
        0, 0, 0, 0, 0,
        HWND_MESSAGE, // This makes it a message-only window
        NULL, 
        GetModuleHandle(NULL), 
        NULL
    );
    
    // Initialize the dispatcher
    MainThreadDispatcher::initialize(messageWindow);
    
    // Start the message loop - process messages for ALL windows, not just the message window
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) { // NULL means process messages for all windows in this thread
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




// Global static variables to keep WebView2 alive
static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2> g_webview;


ELECTROBUN_EXPORT AbstractView* initWebview(uint32_t webviewId,
                         NSWindow *window,  // Actually HWND on Windows
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
    
    log("=== Starting WebView2 Creation ===");
    
    // Cast the window pointer to HWND (Windows window handle)
    HWND hwnd = reinterpret_cast<HWND>(window);
    
    AbstractView* view = new AbstractView();
    view->webviewId = webviewId;
    
    if (!IsWindow(hwnd)) {
        log("ERROR: Invalid window handle provided");
        return view;
    }
    
    // Copy parameters that might be destroyed when this function returns
    std::string urlStr = url ? std::string(url) : "";
    std::string electrobunScriptStr = electrobunPreloadScript ? std::string(electrobunPreloadScript) : "";
    std::string customScriptStr = customPreloadScript ? std::string(customPreloadScript) : "";
    
    // Dispatch WebView2 creation to main thread
    MainThreadDispatcher::dispatch_sync([=, urlStr = urlStr, electrobunScriptStr = electrobunScriptStr, customScriptStr = customScriptStr]() {
        log("Creating WebView2 on main thread");
        
        // Initialize COM on main thread
        CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
        
        // Create WebView2 environment
        HRESULT hr = CreateCoreWebView2Environment(
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [=](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                    if (SUCCEEDED(result)) {
                        log("WebView2 environment created successfully");
                        
                        // Create WebView2 controller
                        env->CreateCoreWebView2Controller(hwnd,
                            Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                                [=](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                                    if (SUCCEEDED(result)) {
                                        log("WebView2 controller created successfully");
                                        
                                        // Store in global variables to keep alive
                                        g_controller = controller;
                                        
                                        // Get the WebView2 core
                                        HRESULT webviewResult = controller->get_CoreWebView2(&g_webview);
                                        if (FAILED(webviewResult)) {
                                            log("ERROR: Failed to get CoreWebView2");
                                            return S_OK;
                                        }
                                        
                                        // Get window client area and set bounds
                                        RECT clientRect;
                                        GetClientRect(hwnd, &clientRect);
                                        RECT bounds = {0, 0, clientRect.right, clientRect.bottom};
                                        controller->put_Bounds(bounds);
                                        
                                        // Make webview visible
                                        controller->put_IsVisible(TRUE);
                                        controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                                        
                                        // Set up navigation event handler
                                        if (navigationCallback) {
                                            EventRegistrationToken navigationToken;
                                            g_webview->add_NavigationStarting(
                                                Callback<ICoreWebView2NavigationStartingEventHandler>(
                                                    [navigationCallback, webviewId](ICoreWebView2* sender, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                                                        LPWSTR uri;
                                                        args->get_Uri(&uri);
                                                        
                                                        // Convert to char* and call callback
                                                        int size = WideCharToMultiByte(CP_UTF8, 0, uri, -1, NULL, 0, NULL, NULL);
                                                        char* url_char = new char[size];
                                                        WideCharToMultiByte(CP_UTF8, 0, uri, -1, url_char, size, NULL, NULL);
                                                        
                                                        bool allow = navigationCallback(webviewId, url_char);
                                                        args->put_Cancel(!allow);
                                                        
                                                        delete[] url_char;
                                                        CoTaskMemFree(uri);
                                                        return S_OK;
                                                    }).Get(), 
                                                &navigationToken);
                                        }
                                        
                                        // Set up navigation completion handler
                                        EventRegistrationToken navCompletedToken;
                                        g_webview->add_NavigationCompleted(
                                            Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                                [](ICoreWebView2* sender, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                                                    BOOL success;
                                                    args->get_IsSuccess(&success);
                                                    if (success) {
                                                        log("Navigation completed successfully");
                                                    } else {
                                                        log("Navigation failed");
                                                        COREWEBVIEW2_WEB_ERROR_STATUS error;
                                                        args->get_WebErrorStatus(&error);
                                                        char errorMsg[256];
                                                        sprintf_s(errorMsg, "Navigation error: %d", error);
                                                        log(errorMsg);
                                                    }
                                                    return S_OK;
                                                }).Get(),
                                            &navCompletedToken);
                                        
                                        // Set up message handlers
                                        if (bunBridgeHandler || internalBridgeHandler) {
                                            EventRegistrationToken messageToken;
                                            g_webview->add_WebMessageReceived(
                                                Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                                    [bunBridgeHandler, internalBridgeHandler, webviewId](ICoreWebView2* sender, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                                                        LPWSTR message;
                                                        args->TryGetWebMessageAsString(&message);
                                                        
                                                        // Convert to char*
                                                        int size = WideCharToMultiByte(CP_UTF8, 0, message, -1, NULL, 0, NULL, NULL);
                                                        char* message_char = new char[size];
                                                        WideCharToMultiByte(CP_UTF8, 0, message, -1, message_char, size, NULL, NULL);
                                                        
                                                        // Call appropriate handlers
                                                        if (bunBridgeHandler) {
                                                            bunBridgeHandler(webviewId, message_char);
                                                        }
                                                        if (internalBridgeHandler) {
                                                            internalBridgeHandler(webviewId, message_char);
                                                        }
                                                        
                                                        delete[] message_char;
                                                        CoTaskMemFree(message);
                                                        return S_OK;
                                                    }).Get(), 
                                                &messageToken);
                                        }
                                        
                                        // Add preload scripts
                                        std::string combinedScript = "";
                                        if (!electrobunScriptStr.empty()) {
                                            combinedScript += electrobunScriptStr;
                                            combinedScript += "\n";
                                        }
                                        if (!customScriptStr.empty()) {
                                            combinedScript += customScriptStr;
                                        }
                                        
                                        if (!combinedScript.empty()) {
                                            // Convert to wstring
                                            int size = MultiByteToWideChar(CP_UTF8, 0, combinedScript.c_str(), -1, NULL, 0);
                                            std::wstring wScript(size - 1, 0);
                                            MultiByteToWideChar(CP_UTF8, 0, combinedScript.c_str(), -1, &wScript[0], size);
                                            
                                            g_webview->AddScriptToExecuteOnDocumentCreated(wScript.c_str(), nullptr);
                                        }
                                        
                                        // Navigate to URL if provided
                                        if (!urlStr.empty()) {
                                            // Convert URL to wstring
                                            int size = MultiByteToWideChar(CP_UTF8, 0, urlStr.c_str(), -1, NULL, 0);
                                            std::wstring wUrl(size - 1, 0);
                                            MultiByteToWideChar(CP_UTF8, 0, urlStr.c_str(), -1, &wUrl[0], size);
                                            
                                            log("Navigating to requested URL");
                                            g_webview->Navigate(wUrl.c_str());
                                        } else {
                                            log("No URL provided, loading about:blank");
                                            g_webview->Navigate(L"about:blank");
                                        }
                                        
                                    } else {
                                        log("Failed to create WebView2 controller");
                                    }
                                    return S_OK;
                                }).Get());
                    } else {
                        log("Failed to create WebView2 environment");
                    }
                    return S_OK;
                }).Get());
        
        if (FAILED(hr)) {
            log("Failed to create WebView2 environment");
        }
    });
    
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
    
    switch (msg) {
        case WM_CLOSE:
            if (data && data->closeHandler) {
                data->closeHandler(data->windowId);
            }
            return 0; // Don't close the window yet, let the handler decide
            
        case WM_MOVE:
            if (data && data->moveHandler) {
                int x = LOWORD(lParam);
                int y = HIWORD(lParam);
                data->moveHandler(data->windowId, x, y);
            }
            break;
            
        case WM_SIZE:
            if (data && data->resizeHandler) {
                int width = LOWORD(lParam);
                int height = HIWORD(lParam);
                data->resizeHandler(data->windowId, 0, 0, width, height);
            }
            break;
            
        case WM_PAINT:
            {
                PAINTSTRUCT ps;
                HDC hdc = BeginPaint(hwnd, &ps);
                // Don't need to do anything here, just validate the paint region
                EndPaint(hwnd, &ps);
            }
            return 0;
            
        case WM_TIMER:
            if (wParam == 1) {
                KillTimer(hwnd, 1);
                log("Timer fired - forcing window refresh");
                InvalidateRect(hwnd, NULL, TRUE);
                UpdateWindow(hwnd);
            }
            return 0;
            
        case WM_DESTROY:
            // Clean up window data
            if (data) {
                free(data);
                SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
            }
            break;
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
    
    // Everything GUI-related needs to be dispatched to main thread
    HWND hwnd = MainThreadDispatcher::dispatch_sync([=]() -> HWND {
        
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
    });
    
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
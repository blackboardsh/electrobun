#include <Windows.h>
#include <windowsx.h>  // For GET_X_LPARAM and GET_Y_LPARAM
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
#include <WebView2EnvironmentOptions.h>
#include <string>
#include <map>
#include <algorithm>
#include <stdint.h>

// Link required Windows libraries
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")

using namespace Microsoft::WRL;

// Ensure the exported functions have appropriate visibility
#define ELECTROBUN_EXPORT __declspec(dllexport)
#define WM_EXECUTE_SYNC_BLOCK (WM_USER + 1)

// Forward declarations
class AbstractView;
class ContainerView;
class NSWindow;
class NSStatusItem;
class WKWebView;
class MyScriptMessageHandlerWithReply;

// Type definitions to match macOS types
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

// Global map to store container views by window handle
static std::map<HWND, std::unique_ptr<ContainerView>> g_containerViews;
static GetMimeType g_getMimeType = nullptr;
static GetHTMLForWebviewSync g_getHTMLForWebviewSync = nullptr;

// Global WebView2 instances - moved to global scope
static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2> g_webview;
static ComPtr<ICoreWebView2Environment> g_environment;  // Add global environment
static ComPtr<ICoreWebView2CustomSchemeRegistration> g_customScheme;
static ComPtr<ICoreWebView2EnvironmentOptions> g_envOptions;

// Forward declare helper functions
void setupViewsSchemeHandler(ICoreWebView2* webview, uint32_t webviewId);
void handleViewsSchemeRequest(ICoreWebView2WebResourceRequestedEventArgs* args, 
                             const std::wstring& uri, 
                             uint32_t webviewId);
std::string loadViewsFile(const std::string& path);
std::string getMimeTypeForFile(const std::string& path);

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

// AbstractView class definition
class AbstractView {
public:
    uint32_t webviewId;
    bool isMousePassthroughEnabled = false;
    bool mirrorModeEnabled = false;
    bool fullSize = false;
    
    // WebView2 specific members
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> webview;
    
    virtual ~AbstractView() = default;
};

// ContainerView class definition
class ContainerView {
private:
    HWND m_hwnd;
    HWND m_parentWindow;
    std::vector<std::shared_ptr<AbstractView>> m_abstractViews;
    
    // Window procedure for the container
    static LRESULT CALLBACK ContainerWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        ContainerView* container = nullptr;
        
        if (msg == WM_NCCREATE) {
            CREATESTRUCT* cs = (CREATESTRUCT*)lParam;
            container = (ContainerView*)cs->lpCreateParams;
            SetWindowLongPtr(hwnd, GWLP_USERDATA, (LONG_PTR)container);
        } else {
            container = (ContainerView*)GetWindowLongPtr(hwnd, GWLP_USERDATA);
        }
        
        if (container) {
            return container->HandleMessage(msg, wParam, lParam);
        }
        
        return DefWindowProc(hwnd, msg, wParam, lParam);
    }
    
    LRESULT HandleMessage(UINT msg, WPARAM wParam, LPARAM lParam) {
        switch (msg) {
            case WM_SIZE: {
                // Resize all full-size webviews when container resizes
                int width = LOWORD(lParam);
                int height = HIWORD(lParam);
                
                for (auto& view : m_abstractViews) {
                    if (view->fullSize) {
                        // Resize the webview to match container
                        if (view->controller) {
                            RECT bounds = {0, 0, width, height};
                            view->controller->put_Bounds(bounds);
                        }
                    }
                }
                break;
            }
            
            case WM_MOUSEMOVE: {
                // Handle mouse movement for determining active webview
                POINT mousePos = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
                UpdateActiveWebviewForMousePosition(mousePos);
                break;
            }
            
            case WM_PAINT: {
                PAINTSTRUCT ps;
                HDC hdc = BeginPaint(m_hwnd, &ps);
                // Don't draw anything - let child windows handle their own painting
                EndPaint(m_hwnd, &ps);
                return 0;
            }
        }
        
        return DefWindowProc(m_hwnd, msg, wParam, lParam);
    }
    
    void UpdateActiveWebviewForMousePosition(POINT mousePos) {
        bool stillSearching = true;
        
        // Iterate through webviews in reverse order (top-most first)
        for (auto it = m_abstractViews.rbegin(); it != m_abstractViews.rend(); ++it) {
            auto& view = *it;
            
            if (view->isMousePassthroughEnabled) {
                // Set to mirror mode (invisible/non-interactive)
                SetWebViewMirrorMode(view.get(), true);
                continue;
            }
            
            if (stillSearching) {
                // Check if mouse is over this webview's bounds
                RECT viewBounds;
                if (view->controller) {
                    view->controller->get_Bounds(&viewBounds);
                    
                    if (PtInRect(&viewBounds, mousePos)) {
                        // Mouse is over this webview, make it active
                        SetWebViewMirrorMode(view.get(), false);
                        stillSearching = false;
                        continue;
                    }
                }
            }
            
            // Set to mirror mode
            SetWebViewMirrorMode(view.get(), true);
        }
    }
    
    void SetWebViewMirrorMode(AbstractView* view, bool mirror) {
        if (!view->controller) return;
        
        if (view->mirrorModeEnabled == mirror) return;
        
        view->mirrorModeEnabled = mirror;
        
        if (mirror) {
            // Move webview offscreen or make it non-interactive
            view->controller->put_IsVisible(FALSE);
        } else {
            // Make webview visible and interactive
            view->controller->put_IsVisible(TRUE);
            view->controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        }
    }

public:
    ContainerView(HWND parentWindow) : m_parentWindow(parentWindow), m_hwnd(NULL) {
        // Double-check parent window is valid
        if (!IsWindow(parentWindow)) {
            log("ERROR: Parent window handle is invalid in ContainerView constructor");
            return;
        }
        
        // Get parent window client area
        RECT clientRect;
        if (!GetClientRect(parentWindow, &clientRect)) {
            DWORD error = GetLastError();
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Failed to get parent window client rect, error: %lu", error);
            log(errorMsg);
            return;
        }
        
        // Validate that we have a reasonable client area
        int width = clientRect.right - clientRect.left;
        int height = clientRect.bottom - clientRect.top;
        
        if (width <= 0 || height <= 0) {
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Parent window has invalid client area: %dx%d", width, height);
            log(errorMsg);
            return;
        }
        
        // Register our custom window class for proper event handling
        static bool classRegistered = false;
        if (!classRegistered) {
            WNDCLASSA wc = {0};
            wc.lpfnWndProc = ContainerWndProc;
            wc.hInstance = GetModuleHandle(NULL);
            wc.lpszClassName = "ContainerViewClass";
            wc.hbrBackground = NULL; // Transparent background
            wc.hCursor = LoadCursor(NULL, IDC_ARROW);
            wc.style = CS_HREDRAW | CS_VREDRAW;
            
            if (!RegisterClassA(&wc)) {
                DWORD error = GetLastError();
                if (error != ERROR_CLASS_ALREADY_EXISTS) {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "ERROR: Failed to register ContainerViewClass, error: %lu", error);
                    log(errorMsg);
                    // Fall back to STATIC class
                    goto use_static_class;
                }
            }
            classRegistered = true;
        }
        
        // Try creating with our custom class first
        log("Creating container window with custom ContainerViewClass");
        m_hwnd = CreateWindowExA(
            0,
            "ContainerViewClass",
            "",  // No title text
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            0, 0, width, height,
            parentWindow,
            NULL,
            GetModuleHandle(NULL),
            this   // Pass this pointer for message handling
        );
        
        if (!m_hwnd) {
            log("Custom class failed, falling back to STATIC class");
            
            use_static_class:
            // Fallback to STATIC class
            m_hwnd = CreateWindowExA(
                0,
                "STATIC",
                "",  // No title text  
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                0, 0, width, height,
                parentWindow,
                NULL,
                GetModuleHandle(NULL),
                NULL
            );
            
            if (!m_hwnd) {
                DWORD error = GetLastError();
                char errorMsg[256];
                sprintf_s(errorMsg, "ERROR: Failed to create container window even with STATIC class, error: %lu", error);
                log(errorMsg);
                return;
            } else {
                log("Container window created successfully with STATIC class (limited functionality)");
            }
        } else {
            log("Container window created successfully with custom ContainerViewClass");
        }
        
        if (m_hwnd) {
            // Verify the container window is valid
            if (!IsWindow(m_hwnd)) {
                log("ERROR: Container window creation returned handle but window is not valid");
                m_hwnd = NULL;
                return;
            }
            
            char successMsg[256];
            sprintf_s(successMsg, "Container window setup completed: HWND=%p", m_hwnd);
            log(successMsg);
        }
    }
    
    ~ContainerView() {
        if (m_hwnd) {
            DestroyWindow(m_hwnd);
        }
    }
    
    HWND GetHwnd() const { return m_hwnd; }
    
    void AddAbstractView(std::shared_ptr<AbstractView> view) {
        // Add to front of vector so it's top-most first
        m_abstractViews.insert(m_abstractViews.begin(), view);
    }
    
    void RemoveAbstractViewWithId(uint32_t webviewId) {
        m_abstractViews.erase(
            std::remove_if(m_abstractViews.begin(), m_abstractViews.end(),
                [webviewId](const std::shared_ptr<AbstractView>& view) {
                    return view->webviewId == webviewId;
                }),
            m_abstractViews.end());
    }
};

// Helper function to get or create container for a window
ContainerView* GetOrCreateContainer(HWND parentWindow) {
    // Validate the parent window handle
    if (!IsWindow(parentWindow)) {
        log("ERROR: Parent window handle is invalid");
        return nullptr;
    }
    
    auto it = g_containerViews.find(parentWindow);
    if (it == g_containerViews.end()) {
        log("Creating new container for window");
        
        auto container = std::make_unique<ContainerView>(parentWindow);
        ContainerView* containerPtr = container.get();
        
        // Only store if creation was successful
        if (containerPtr->GetHwnd() != NULL) {
            g_containerViews[parentWindow] = std::move(container);
            log("Container created and stored successfully");
            return containerPtr;
        } else {
            log("ERROR: Container creation failed, not storing");
            return nullptr;
        }
    }
    
    log("Using existing container for window");
    return it->second.get();
}

// Stub classes for compatibility
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
            {
                // Resize container to match window client area
                auto containerIt = g_containerViews.find(hwnd);
                if (containerIt != g_containerViews.end()) {
                    RECT clientRect;
                    GetClientRect(hwnd, &clientRect);
                    SetWindowPos(containerIt->second->GetHwnd(), NULL, 
                        0, 0, 
                        clientRect.right - clientRect.left,
                        clientRect.bottom - clientRect.top,
                        SWP_NOZORDER | SWP_NOACTIVATE);
                }
                
                if (data && data->resizeHandler) {
                    int width = LOWORD(lParam);
                    int height = HIWORD(lParam);
                    data->resizeHandler(data->windowId, 0, 0, width, height);
                }
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
            // Clean up container view
            g_containerViews.erase(hwnd);
            
            // Clean up window data
            if (data) {
                free(data);
                SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
            }
            break;
    }
    
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

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

extern "C" {

ELECTROBUN_EXPORT void runNSApplication() {
    // Create a hidden message-only window for dispatching
    WNDCLASSA wc = {0};  // Use ANSI version
    wc.lpfnWndProc = MessageWindowProc;
    wc.hInstance = GetModuleHandle(NULL);
    wc.lpszClassName = "MessageWindowClass";  // Use ANSI string
    RegisterClassA(&wc);  // Use ANSI version
    
    HWND messageWindow = CreateWindowA(  // Use ANSI version
        "MessageWindowClass",  // Use ANSI string
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
    ExitProcess(1);
}

ELECTROBUN_EXPORT void shutdownApplication() {
    // Stub implementation
}

// Modified initWebview function with proper custom scheme registration
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
    
    log("=== Starting WebView2 Creation with views:// Custom Scheme ===");
    
    HWND hwnd = reinterpret_cast<HWND>(window);
    
    auto view = std::make_shared<AbstractView>();
    view->webviewId = webviewId;
    view->fullSize = autoResize;
    
    if (!IsWindow(hwnd)) {
        log("ERROR: Invalid window handle provided");
        return view.get();
    }
    
    // Copy parameters that might be destroyed when this function returns
    std::string urlStr = url ? std::string(url) : "";
    std::string electrobunScriptStr = electrobunPreloadScript ? std::string(electrobunPreloadScript) : "";
    std::string customScriptStr = customPreloadScript ? std::string(customPreloadScript) : "";
    
    // Dispatch WebView2 creation to main thread
    MainThreadDispatcher::dispatch_sync([=, urlStr = urlStr, electrobunScriptStr = electrobunScriptStr, customScriptStr = customScriptStr]() {
        log("Creating WebView2 with views:// custom scheme on main thread");
        
        // Get or create container for this window
        ContainerView* container = GetOrCreateContainer(hwnd);
        if (!container) {
            log("ERROR: Failed to get or create container");
            return;
        }
        
        HWND containerHwnd = container->GetHwnd();
        
        // Initialize COM on main thread
        CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
        
        // Create environment options with custom scheme registration
        auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
        
        // Get the interface that supports custom scheme registration  
        Microsoft::WRL::ComPtr<ICoreWebView2EnvironmentOptions4> options4;
        if (SUCCEEDED(options.As(&options4))) {
            log("Setting up views:// custom scheme registration");
            
            // Set allowed origins for the custom scheme
            const WCHAR* allowedOrigins[1] = {L"*"};
            
            // Create custom scheme registration for "views"
            auto viewsSchemeRegistration = Microsoft::WRL::Make<CoreWebView2CustomSchemeRegistration>(L"views");
            viewsSchemeRegistration->put_TreatAsSecure(TRUE);
            viewsSchemeRegistration->put_HasAuthorityComponent(TRUE); // This allows views://host/path format
            viewsSchemeRegistration->SetAllowedOrigins(1, allowedOrigins);
            
            // Set the custom scheme registrations
            ICoreWebView2CustomSchemeRegistration* registrations[1] = {
                viewsSchemeRegistration.Get()
            };
            
            HRESULT schemeResult = options4->SetCustomSchemeRegistrations(1, registrations);
            
            if (SUCCEEDED(schemeResult)) {
                log("views:// custom scheme registration set successfully");
            } else {
                char errorMsg[256];
                sprintf_s(errorMsg, "Failed to set views:// custom scheme registration: 0x%lx", schemeResult);
                log(errorMsg);
            }
        } else {
            log("ERROR: Failed to get ICoreWebView2EnvironmentOptions4 interface for custom scheme registration");
        }
        
        // Create WebView2 environment with custom scheme registration
        HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
            nullptr,  // browser folder (use default)
            nullptr,  // user data folder (use default)
            options.Get(),  // environment options with custom scheme
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [=](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                    if (SUCCEEDED(result)) {
                        log("WebView2 environment created successfully with views:// scheme support");
                        
                        // Store environment globally
                        g_environment = env;
                        
                        // Create WebView2 controller
                        env->CreateCoreWebView2Controller(containerHwnd,
                            Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                                [=](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                                    if (SUCCEEDED(result)) {
                                        log("WebView2 controller created successfully");
                                        
                                        // Store controller in the view
                                        view->controller = controller;
                                        
                                        // Get the WebView2 core
                                        HRESULT webviewResult = controller->get_CoreWebView2(&view->webview);
                                        if (FAILED(webviewResult)) {
                                            log("ERROR: Failed to get CoreWebView2");
                                            return S_OK;
                                        }

                                        // Store in global
                                        g_webview = view->webview;

                                        // Set up resource request handler for views:// scheme
                                        setupViewsSchemeHandler(view->webview.Get(), webviewId);
                                        
                                        // Set bounds within container
                                        RECT bounds;
                                        if (autoResize) {
                                            GetClientRect(containerHwnd, &bounds);
                                        } else {
                                            bounds = {(LONG)x, (LONG)y, (LONG)(x + width), (LONG)(y + height)};
                                        }
                                        controller->put_Bounds(bounds);
                                        
                                        // Make webview visible
                                        controller->put_IsVisible(TRUE);
                                        controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                                        
                                        // Add view to container
                                        container->AddAbstractView(view);
                                        
                                        // Set up navigation event handlers
                                        if (navigationCallback) {
                                            EventRegistrationToken navigationToken;
                                            view->webview->add_NavigationStarting(
                                                Callback<ICoreWebView2NavigationStartingEventHandler>(
                                                    [navigationCallback, webviewId](ICoreWebView2* sender, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                                                        LPWSTR uri;
                                                        args->get_Uri(&uri);
                                                        
                                                        // Convert to char* and call callback
                                                        int size = WideCharToMultiByte(CP_UTF8, 0, uri, -1, NULL, 0, NULL, NULL);
                                                        char* url_char = new char[size];
                                                        WideCharToMultiByte(CP_UTF8, 0, uri, -1, url_char, size, NULL, NULL);

                                                        char logMsg[512];
                                                        sprintf_s(logMsg, "Navigation starting to: %s", url_char);
                                                        log(logMsg);
                                                        
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
                                        view->webview->add_NavigationCompleted(
                                            Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                                [webviewEventHandler, webviewId](ICoreWebView2* sender, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                                                    BOOL success;
                                                    args->get_IsSuccess(&success);
                                                    if (success) {
                                                        log("Navigation completed successfully");
                                                        if (webviewEventHandler) {
                                                            // Get current URL
                                                            LPWSTR uri;
                                                            sender->get_Source(&uri);
                                                            
                                                            int size = WideCharToMultiByte(CP_UTF8, 0, uri, -1, NULL, 0, NULL, NULL);
                                                            char* url_char = new char[size];
                                                            WideCharToMultiByte(CP_UTF8, 0, uri, -1, url_char, size, NULL, NULL);
                                                            
                                                            webviewEventHandler(webviewId, "did-navigate", url_char);
                                                            
                                                            delete[] url_char;
                                                            CoTaskMemFree(uri);
                                                        }
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
                                            view->webview->add_WebMessageReceived(
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
                                            
                                            view->webview->AddScriptToExecuteOnDocumentCreated(wScript.c_str(), nullptr);
                                        }
                                        
                                        // Navigate to URL if provided
                                        if (!urlStr.empty()) {
                                            // Convert URL to wstring
                                            int size = MultiByteToWideChar(CP_UTF8, 0, urlStr.c_str(), -1, NULL, 0);
                                            std::wstring wUrl(size - 1, 0);
                                            MultiByteToWideChar(CP_UTF8, 0, urlStr.c_str(), -1, &wUrl[0], size);
                                            
                                            char logMsg[512];
                                            sprintf_s(logMsg, "Navigating to: %s", urlStr.c_str());
                                            log(logMsg);
                                            
                                            view->webview->Navigate(wUrl.c_str());
                                        } else {
                                            log("No URL provided, loading about:blank");
                                            view->webview->Navigate(L"about:blank");
                                        }
                                        
                                    } else {
                                        log("Failed to create WebView2 controller");
                                    }
                                    return S_OK;
                                }).Get());
                    } else {
                        char errorMsg[256];
                        sprintf_s(errorMsg, "Failed to create WebView2 environment: 0x%lx", result);
                        log(errorMsg);
                    }
                    return S_OK;
                }).Get());
        
        if (FAILED(hr)) {
            char errorMsg[256];
            sprintf_s(errorMsg, "Failed to create WebView2 environment with options: 0x%lx", hr);
            log(errorMsg);
        }
    });
    
    return view.get();
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
            WNDCLASSA wc = {0};  // Use ANSI version
            wc.lpfnWndProc = CustomWindowProc;
            wc.hInstance = GetModuleHandle(NULL);
            wc.lpszClassName = "BasicWindowClass";  // Use ANSI string
            RegisterClassA(&wc);  // Use ANSI version
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
        HWND hwnd = CreateWindowA(  // Use ANSI version
            "BasicWindowClass",  // Use ANSI string
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
    g_getMimeType = getMimeType;
    g_getHTMLForWebviewSync = getHTMLForWebviewSync;
    log("JS utility callbacks stored successfully");
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

// New function for handling views:// scheme requests
void setupViewsSchemeHandler(ICoreWebView2* webview, uint32_t webviewId) {
    log("Setting up WebView2 resource request handler for views:// scheme");
    
    // Add web resource request filter for views:// scheme
    EventRegistrationToken resourceToken;
    HRESULT hr = webview->add_WebResourceRequested(
        Callback<ICoreWebView2WebResourceRequestedEventHandler>(
            [webviewId](ICoreWebView2* sender, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                ComPtr<ICoreWebView2WebResourceRequest> request;
                args->get_Request(&request);
                
                LPWSTR uri;
                request->get_Uri(&uri);
                
                std::wstring wUri(uri);
                
                // Convert to string for logging
                int size = WideCharToMultiByte(CP_UTF8, 0, uri, -1, NULL, 0, NULL, NULL);
                std::string uriStr(size - 1, 0);
                WideCharToMultiByte(CP_UTF8, 0, uri, -1, &uriStr[0], size, NULL, NULL);
                
                char logMsg[512];
                sprintf_s(logMsg, "Resource request intercepted: %s", uriStr.c_str());
                log(logMsg);
                
                // Check if this is a views:// URL
                if (wUri.find(L"views://") == 0) {
                    log("Processing views:// request");
                    handleViewsSchemeRequest(args, wUri, webviewId);
                }
                
                CoTaskMemFree(uri);
                return S_OK;
            }).Get(), 
        &resourceToken);
    
    if (FAILED(hr)) {
        char errorMsg[256];
        sprintf_s(errorMsg, "Failed to add WebResourceRequested handler: 0x%lx", hr);
        log(errorMsg);
        return;
    }
    
    // Add filter for views:// scheme
    hr = webview->AddWebResourceRequestedFilter(L"views://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    if (FAILED(hr)) {
        char errorMsg[256];
        sprintf_s(errorMsg, "Failed to add resource filter for views://: 0x%lx", hr);
        log(errorMsg);
    } else {
        log("Added resource filter for views:// scheme successfully");
    }
}

// Updated function to handle views:// scheme requests
void handleViewsSchemeRequest(ICoreWebView2WebResourceRequestedEventArgs* args, 
                             const std::wstring& uri, 
                             uint32_t webviewId) {
    
    log("=== HANDLING VIEWS:// REQUEST ===");
    
    // Convert URI to std::string for processing
    int size = WideCharToMultiByte(CP_UTF8, 0, uri.c_str(), -1, NULL, 0, NULL, NULL);
    std::string uriStr(size - 1, 0);
    WideCharToMultiByte(CP_UTF8, 0, uri.c_str(), -1, &uriStr[0], size, NULL, NULL);

    
    char logMsg[512];
    sprintf_s(logMsg, "Processing views:// URL: %s", uriStr.c_str());
    log(logMsg);
    
    // Extract the path after "views://"
    std::string path;
    if (uriStr.length() > 8) {
        path = uriStr.substr(8); // Remove "views://" prefix
    } else {
        path = "index.html"; // Default
    }
    
    std::string responseData;
    std::string mimeType = "text/html";
    
    if (path == "internal/index.html") {
        // Handle internal HTML content using your JS callback
        if (g_getHTMLForWebviewSync) {
            log("Calling g_getHTMLForWebviewSync...");
            const char* htmlContent = g_getHTMLForWebviewSync(webviewId);
            if (htmlContent && strlen(htmlContent) > 0) {
                responseData = std::string(htmlContent);
                sprintf_s(logMsg, "Got HTML content from JS callback: %zu bytes", responseData.length());
                log(logMsg);
            } else {
                responseData = "<html><body><h1>Empty HTML content from callback!</h1></body></html>";
                log("JS callback returned empty or null content");
            }
        } else {
            responseData = "<html><body><h1>JS callback not available</h1><p>g_getHTMLForWebviewSync is null</p></body></html>";
            log("JS callback (g_getHTMLForWebviewSync) is not set");
        }
        mimeType = "text/html";
    } else {
        // Handle other file requests
        responseData = loadViewsFile(path);
        mimeType = getMimeTypeForFile(path);
        
        if (responseData.empty()) {
            responseData = "<html><body><h1>404 - Views file not found</h1><p>Path: " + path + "</p></body></html>";
            mimeType = "text/html";
            log("Views file not found, returning 404");
        }
    }
    
    sprintf_s(logMsg, "Response data length: %zu bytes, MIME type: %s", responseData.length(), mimeType.c_str());
    log(logMsg);
    
    // Create the response using the global environment
    if (!g_environment) {
        log("ERROR: No global environment available for creating response");
        return;
    }
    
    try {
        // Create memory stream first
        ComPtr<IStream> stream;
        HGLOBAL hGlobal = GlobalAlloc(GMEM_MOVEABLE, responseData.length());
        if (!hGlobal) {
            log("ERROR: Failed to allocate global memory");
            return;
        }
        
        void* pData = GlobalLock(hGlobal);
        if (!pData) {
            GlobalFree(hGlobal);
            log("ERROR: Failed to lock global memory");
            return;
        }
        
        memcpy(pData, responseData.c_str(), responseData.length());
        GlobalUnlock(hGlobal);
        
        HRESULT streamResult = CreateStreamOnHGlobal(hGlobal, TRUE, &stream);
        if (FAILED(streamResult)) {
            GlobalFree(hGlobal);
            sprintf_s(logMsg, "ERROR: Failed to create stream on global: 0x%lx", streamResult);
            log(logMsg);
            return;
        }
        
        // Create the response
        ComPtr<ICoreWebView2WebResourceResponse> response;
        std::wstring mimeTypeW(mimeType.begin(), mimeType.end());
        std::wstring headers = L"Content-Type: " + mimeTypeW + L"\r\nAccess-Control-Allow-Origin: *";
        
        HRESULT responseResult = g_environment->CreateWebResourceResponse(
            stream.Get(),               // content stream
            200,                       // status code
            L"OK",                     // reason phrase
            headers.c_str(),           // headers
            &response);
        
        if (FAILED(responseResult)) {
            sprintf_s(logMsg, "ERROR: Failed to create web resource response: 0x%lx", responseResult);
            log(logMsg);
            return;
        }
        
        // Set the response
        HRESULT setResult = args->put_Response(response.Get());
        if (FAILED(setResult)) {
            sprintf_s(logMsg, "ERROR: Failed to set response: 0x%lx", setResult);
            log(logMsg);
            return;
        }
        
        log("Successfully created and set views:// response");
        
    } catch (...) {
        log("ERROR: Exception occurred while creating response");
    }
}

// Helper functions
std::string loadViewsFile(const std::string& path) {
    // Get the current working directory instead of executable directory
    char currentDir[MAX_PATH];
    DWORD result = GetCurrentDirectoryA(MAX_PATH, currentDir);
    
    if (result == 0 || result > MAX_PATH) {
        log("ERROR: Failed to get current working directory");
        return "";
    }
    
    // Build full path to views file from current working directory
    std::string fullPath = std::string(currentDir) + "\\..\\Resources\\app\\views\\" + path;
    
    char logMsg[512];
    sprintf_s(logMsg, "Attempting to load views file: %s", fullPath.c_str());
    log(logMsg);
    
    // Try to read the file
    std::ifstream file(fullPath, std::ios::binary);
    if (!file.is_open()) {
        sprintf_s(logMsg, "Could not open views file: %s", fullPath.c_str());
        log(logMsg);
        return "";
    }
    
    // Read file contents
    std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    file.close();
    
    sprintf_s(logMsg, "Loaded views file: %s (%zu bytes)", fullPath.c_str(), content.length());
    log(logMsg);
    
    return content;
}

std::string getMimeTypeForFile(const std::string& path) {
    // Extract file extension and return appropriate MIME type
    size_t dotPos = path.find_last_of('.');
    if (dotPos != std::string::npos) {
        std::string ext = path.substr(dotPos + 1);
        std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
        if (ext == "html" || ext == "htm") return "text/html";
        if (ext == "js") return "application/javascript";
        if (ext == "css") return "text/css";
        if (ext == "json") return "application/json";
        if (ext == "png") return "image/png";
        if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
        if (ext == "svg") return "image/svg+xml";
    }
    return "text/plain";
}
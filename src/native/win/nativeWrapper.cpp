#include <Windows.h>
#include <windowsx.h>  // For GET_X_LPARAM and GET_Y_LPARAM
#include <string>
#include <cstring>
#include <functional>
#include <vector>
#include <iostream>
#include <fstream>
#include <sstream>
#include <ctime>
#include <chrono>
#include <functional>
#include <future>
#include <memory>
#include <windows.h>
#include <wrl.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>
#include <map>
#include <algorithm>
#include <stdint.h>
#include <shellapi.h>
#include <commctrl.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/base.h>
#include <shobjidl.h>  // For IFileOpenDialog
#include <shlguid.h>   // For CLSID_FileOpenDialog
#include <commdlg.h>   // For COMDLG_FILTERSPEC
#include <dcomp.h>     // For DirectComposition
#include <locale>      // For string conversion
#include <codecvt>     // For UTF-8 to wide string conversion
#include <d2d1.h>      // For Direct2D
#include <direct.h>    // For _getcwd
#include <tlhelp32.h>  // For process enumeration

// Push macro definitions to avoid conflicts with Windows headers
#pragma push_macro("GetNextSibling")
#pragma push_macro("GetFirstChild")
#undef GetNextSibling
#undef GetFirstChild

// CEF includes - always include for runtime detection
#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_browser.h"
#include "include/cef_command_line.h"
#include "include/cef_scheme.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_permission_handler.h"
#include "include/cef_dialog_handler.h"
#include "include/wrapper/cef_helpers.h"

// Restore macro definitions
#pragma pop_macro("GetFirstChild")
#pragma pop_macro("GetNextSibling")

// Link required Windows libraries
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "dcomp.lib")
#pragma comment(lib, "d2d1.lib")


using namespace Microsoft::WRL;


// Ensure the exported functions have appropriate visibility
#define ELECTROBUN_EXPORT __declspec(dllexport)
#define WM_EXECUTE_SYNC_BLOCK (WM_USER + 1)
#define WM_EXECUTE_ASYNC_BLOCK (WM_USER + 2)

// Forward declarations
class AbstractView;
class ContainerView;
class NSWindow;
class NSStatusItem;
class WKWebView;
class MyScriptMessageHandlerWithReply;
class StatusItemTarget;

// CEF function declarations
ELECTROBUN_EXPORT bool isCEFAvailable();

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

// Webview content storage (replaces JSCallback approach)
static std::map<uint32_t, std::string> webviewHTMLContent;
static std::mutex webviewHTMLMutex;

// Forward declarations for HTML content management
extern "C" const char* getWebviewHTMLContent(uint32_t webviewId);
extern "C" void setWebviewHTMLContent(uint32_t webviewId, const char* htmlContent);

// Global mutex to serialize webview creation
static std::mutex g_webviewCreationMutex;

// Global map to store preload scripts by browser ID (needs to be early for load handler)
static std::map<int, std::string> g_preloadScripts;

// Global map to store CEFViews by container window handle (using void* to avoid forward declaration issues)
static std::map<HWND, void*> g_cefViews;
// Global map to store WebView2Views by container window handle (using void* to avoid forward declaration issues)
static std::map<HWND, void*> g_webview2Views;

// Global map to store pending CEF navigations for timing workaround - use browser ID instead of pointer
static std::map<int, std::string> g_pendingCefNavigations;
// Global map to store browser references by ID for safe access
static std::map<int, CefRefPtr<CefBrowser>> g_cefBrowsers;
// Global browser counter (moved from class static to global)
static int g_browser_count = 0;
// Global map to store pending URLs for async browser creation
static std::map<HWND, std::string> g_pendingUrls;

// Global WebView2 instances - moved to global scope
static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2> g_webview;

// Permission cache for user media requests
enum class PermissionType {
    USER_MEDIA,
    GEOLOCATION,
    NOTIFICATIONS,
    OTHER
};

enum class PermissionStatus {
    UNKNOWN,
    ALLOWED,
    DENIED
};

struct PermissionCacheEntry {
    PermissionStatus status;
    std::chrono::system_clock::time_point expiry;
};

static std::map<std::pair<std::string, PermissionType>, PermissionCacheEntry> g_permissionCache;

// Helper functions for permission management
std::string getOriginFromUrl(const std::string& url) {
    // For views:// scheme, use a constant origin since these are local files
    if (url.find("views://") == 0) {
        return "views://";
    }
    
    // For other schemes, extract origin from URL
    size_t protocolEnd = url.find("://");
    if (protocolEnd == std::string::npos) return url;
    
    size_t domainStart = protocolEnd + 3;
    size_t pathStart = url.find('/', domainStart);
    
    if (pathStart == std::string::npos) {
        return url;
    }
    
    return url.substr(0, pathStart);
}

PermissionStatus getPermissionFromCache(const std::string& origin, PermissionType type) {
    auto key = std::make_pair(origin, type);
    auto it = g_permissionCache.find(key);
    
    if (it != g_permissionCache.end()) {
        // Check if permission hasn't expired
        auto now = std::chrono::system_clock::now();
        if (now < it->second.expiry) {
            return it->second.status;
        } else {
            // Permission expired, remove from cache
            g_permissionCache.erase(it);
        }
    }
    
    return PermissionStatus::UNKNOWN;
}

void cachePermission(const std::string& origin, PermissionType type, PermissionStatus status) {
    auto key = std::make_pair(origin, type);
    
    // Cache permission for 24 hours
    auto expiry = std::chrono::system_clock::now() + std::chrono::hours(24);
    
    g_permissionCache[key] = {status, expiry};
}
static ComPtr<ICoreWebView2Environment> g_environment;  // Add global environment
static ComPtr<ICoreWebView2CustomSchemeRegistration> g_customScheme;
static ComPtr<ICoreWebView2EnvironmentOptions> g_envOptions;

static HMENU g_applicationMenu = NULL;
static std::unique_ptr<StatusItemTarget> g_appMenuTarget = nullptr;

// Global map to store menu item actions by menu ID
static std::map<UINT, std::string> g_menuItemActions;
static UINT g_nextMenuId = WM_USER + 1000;  // Start menu IDs from a safe range

// Global state for custom window dragging
static BOOL g_isMovingWindow = FALSE;
static HWND g_targetWindow = NULL;
static POINT g_initialCursorPos = {};
static POINT g_initialWindowPos = {};

// WebView positioning constants
static const int OFFSCREEN_OFFSET = -20000;

// CEF global variables
static bool g_cef_initialized = false;
static CefRefPtr<CefApp> g_cef_app;
static HANDLE g_job_object = nullptr;  // Job object to track all child processes

// Simple CEF App class for minimal implementation
class ElectrobunCefApp : public CefApp, public CefBrowserProcessHandler {
public:
    CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
        return this;
    }

    void OnBeforeCommandLineProcessing(const CefString& process_type, CefRefPtr<CefCommandLine> command_line) override {
        // Disable features for minimal implementation
        command_line->AppendSwitch("disable-web-security");
        command_line->AppendSwitch("disable-features=VizDisplayCompositor");
    }

    void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
        // Register views:// scheme
        registrar->AddCustomScheme("views",
            CEF_SCHEME_OPTION_STANDARD |
            CEF_SCHEME_OPTION_CORS_ENABLED |
            CEF_SCHEME_OPTION_SECURE |
            CEF_SCHEME_OPTION_CSP_BYPASSING |
            CEF_SCHEME_OPTION_FETCH_ENABLED);
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunCefApp);
};

// CEF Load Handler for debugging navigation
class ElectrobunLoadHandler : public CefLoadHandler {
public:
    void OnLoadStart(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, TransitionType transition_type) override {
        
        // Execute preload scripts immediately at load start for main frame
        if (frame->IsMain()) {
            int browserId = browser->GetIdentifier();
            auto scriptIt = g_preloadScripts.find(browserId);
            if (scriptIt != g_preloadScripts.end() && !scriptIt->second.empty()) {
                // Execute with very high priority and immediate execution
                frame->ExecuteJavaScript(scriptIt->second, "", 0);
            }
        }
    }
    
    void OnLoadEnd(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, int httpStatusCode) override {
        
        // Also execute preload scripts at load end to ensure they're available
        if (frame->IsMain()) {
            int browserId = browser->GetIdentifier();
            auto scriptIt = g_preloadScripts.find(browserId);
            if (scriptIt != g_preloadScripts.end() && !scriptIt->second.empty()) {
                frame->ExecuteJavaScript(scriptIt->second, "", 0);
            }
        }
    }
    
    void OnLoadError(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, ErrorCode errorCode, const CefString& errorText, const CefString& failedUrl) override {
        std::cout << "[CEF] LoadError: " << static_cast<int>(errorCode) 
                  << " - " << errorText.ToString() 
                  << " for URL: " << failedUrl.ToString() << std::endl;
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunLoadHandler);
};

// Forward declaration for CEF client (needed for global map)
class ElectrobunCefClient;

// Global map to store CEF clients for browser connection
static std::map<HWND, CefRefPtr<ElectrobunCefClient>> g_cefClients;

// Forward declaration for helper functions (defined after class definitions)
void SetBrowserOnClient(CefRefPtr<ElectrobunCefClient> client, CefRefPtr<CefBrowser> browser);
void SetBrowserOnCEFView(HWND parentWindow, CefRefPtr<CefBrowser> browser);
void SetWebViewOnWebView2View(HWND containerWindow, void* webview);

// CEF Life Span Handler for async browser creation
class ElectrobunLifeSpanHandler : public CefLifeSpanHandler {
public:
    void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
        // Note: Browser setup is now handled synchronously during CreateBrowserSync
    }

    void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
        std::cout << "[CEF] OnBeforeClose: Browser ID " << browser->GetIdentifier() << " closing" << std::endl;
        
        // Remove browser from global tracking
        g_cefBrowsers.erase(browser->GetIdentifier());
        g_browser_count--;
        
        std::cout << "[CEF] Remaining browsers: " << g_browser_count << std::endl;
        
        // If this was the last browser, quit the CEF message loop
        if (g_browser_count == 0) {
            std::cout << "[CEF] Last browser closed, quitting message loop" << std::endl;
            CefQuitMessageLoop();
        }
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunLifeSpanHandler);
};

// Forward declarations for functions defined later in the file
std::string loadViewsFile(const std::string& path);
std::string getMimeTypeForFile(const std::string& path);

// CEF Resource Handler for views:// scheme (based on Mac implementation)
class ElectrobunSchemeHandler : public CefResourceHandler {
public:
    ElectrobunSchemeHandler() : offset_(0), hasResponse_(false) {}

    bool Open(CefRefPtr<CefRequest> request, bool& handle_request, CefRefPtr<CefCallback> callback) override {
        handle_request = true;
        
        std::string url = request->GetURL();
        std::string path = url.substr(8); // Remove "views://" prefix
        if (path.empty()) path = "index.html";
        
        // Load file content using existing function
        std::string content = loadViewsFile(path);
        mimeType_ = getMimeTypeForFile(path);
        
        if (!content.empty()) {
            responseData_.assign(content.begin(), content.end());
            hasResponse_ = true;
        } else {
            hasResponse_ = false;
        }
        
        return hasResponse_;
    }

    void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length, CefString& redirectUrl) override {
        response->SetStatus(200);
        response->SetMimeType(mimeType_);
        response_length = static_cast<int64_t>(responseData_.size());
    }

    bool Read(void* data_out, int bytes_to_read, int& bytes_read, CefRefPtr<CefResourceReadCallback> callback) override {
        bytes_read = 0;
        if (!hasResponse_ || offset_ >= responseData_.size()) {
            return false;
        }
        size_t remaining = responseData_.size() - offset_;
        bytes_read = (bytes_to_read < static_cast<int>(remaining)) ? 
                     bytes_to_read : static_cast<int>(remaining);
        memcpy(data_out, responseData_.data() + offset_, bytes_read);
        offset_ += bytes_read;
        return true;
    }

    void Cancel() override {}

private:
    std::string mimeType_;
    std::vector<char> responseData_;
    bool hasResponse_;
    size_t offset_;
    IMPLEMENT_REFCOUNTING(ElectrobunSchemeHandler);
};

// CEF Scheme Handler Factory
class ElectrobunSchemeHandlerFactory : public CefSchemeHandlerFactory {
public:
    CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> browser,
                                       CefRefPtr<CefFrame> frame,
                                       const CefString& scheme_name,
                                       CefRefPtr<CefRequest> request) override {
        return new ElectrobunSchemeHandler();
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunSchemeHandlerFactory);
};

// CEF Response Filter for script injection
class ElectrobunResponseFilter : public CefResponseFilter {
public:
    ElectrobunResponseFilter(const std::string& script) : script_(script) {}

    bool InitFilter() override {
        return true;
    }

    FilterStatus Filter(void* data_in, size_t data_in_size, size_t& data_in_read,
                       void* data_out, size_t data_out_size, size_t& data_out_written) override {
        // Read all input data
        if (data_in_size > 0) {
            data_buffer_.append(static_cast<char*>(data_in), data_in_size);
            data_in_read = data_in_size;
        } else {
            data_in_read = 0;
        }
        
        // If no input data (end of stream), process the accumulated data
        if (data_in_size == 0 && !processed_) {
            ProcessAccumulatedData();
            processed_ = true;
        }
        
        // Output processed data
        data_out_written = 0;
        if (processed_ && output_offset_ < processed_data_.size()) {
            size_t remaining = processed_data_.size() - output_offset_;
            size_t copy_size = (data_out_size < remaining) ? data_out_size : remaining;
            memcpy(data_out, processed_data_.data() + output_offset_, copy_size);
            output_offset_ += copy_size;
            data_out_written = copy_size;
        }
        
        // Return status based on whether we have more data to output
        if (data_in_size == 0 && output_offset_ >= processed_data_.size()) {
            return RESPONSE_FILTER_DONE;
        } else {
            return RESPONSE_FILTER_NEED_MORE_DATA;
        }
    }

    void ProcessAccumulatedData() {
        // Process accumulated data and inject script
        processed_data_ = data_buffer_;
        
        // Look for </head> tag and inject script before it
        size_t head_pos = processed_data_.find("</head>");
        if (head_pos != std::string::npos && !script_.empty()) {
            std::string script_tag = "<script>" + script_ + "</script>";
            processed_data_.insert(head_pos, script_tag);
        }
    }

private:
    std::string script_;
    std::string data_buffer_;
    std::string processed_data_;
    size_t output_offset_ = 0;
    bool processed_ = false;
    IMPLEMENT_REFCOUNTING(ElectrobunResponseFilter);
};

// CEF Request Handler for views:// scheme support
class ElectrobunRequestHandler : public CefRequestHandler {
public:
    ElectrobunRequestHandler() {}

    // Script injection will be handled via render process context creation

private:
    IMPLEMENT_REFCOUNTING(ElectrobunRequestHandler);
};

// CEF Context Menu Handler for devtools support
class ElectrobunContextMenuHandler : public CefContextMenuHandler {
public:
    ElectrobunContextMenuHandler() {}
    
    void OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefFrame> frame,
                           CefRefPtr<CefContextMenuParams> params,
                           CefRefPtr<CefMenuModel> model) override {
        // Add "Inspect Element" menu item
        model->AddSeparator();
        model->AddItem(26501, "Inspect Element");
    }
    
    bool OnContextMenuCommand(CefRefPtr<CefBrowser> browser,
                            CefRefPtr<CefFrame> frame,
                            CefRefPtr<CefContextMenuParams> params,
                            int command_id,
                            EventFlags event_flags) override {
        if (command_id == 26501) {
            // Show devtools
            CefWindowInfo windowInfo;
            CefBrowserSettings settings;
            CefPoint point(params->GetXCoord(), params->GetYCoord());
            
            browser->GetHost()->ShowDevTools(windowInfo, nullptr, settings, point);
            return true;
        }
        return false;
    }
    
private:
    IMPLEMENT_REFCOUNTING(ElectrobunContextMenuHandler);
};

// CEF Permission Handler for user media and other permissions
class ElectrobunPermissionHandler : public CefPermissionHandler {
public:
    bool OnRequestMediaAccessPermission(
        CefRefPtr<CefBrowser> browser,
        CefRefPtr<CefFrame> frame,
        const CefString& requesting_origin,
        uint32_t requested_permissions,
        CefRefPtr<CefMediaAccessCallback> callback) override {
        
        std::string origin = requesting_origin.ToString();
        printf("CEF: Media access permission requested for %s (permissions: %u)\n", origin.c_str(), requested_permissions);
        
        // Check cache first
        PermissionStatus cachedStatus = getPermissionFromCache(origin, PermissionType::USER_MEDIA);
        
        if (cachedStatus == PermissionStatus::ALLOWED) {
            printf("CEF: Using cached permission: User previously allowed media access for %s\n", origin.c_str());
            callback->Continue(requested_permissions); // Allow all requested permissions
            return true;
        } else if (cachedStatus == PermissionStatus::DENIED) {
            printf("CEF: Using cached permission: User previously blocked media access for %s\n", origin.c_str());
            callback->Cancel();
            return true;
        }
        
        // No cached permission, show dialog
        printf("CEF: No cached permission found for %s, showing dialog\n", origin.c_str());
        
        // Show Windows message box
        std::string message = "This page wants to access your camera and/or microphone.\n\nDo you want to allow this?";
        std::string title = "Camera & Microphone Access";
        
        int result = MessageBoxA(
            nullptr,
            message.c_str(),
            title.c_str(),
            MB_YESNO | MB_ICONQUESTION | MB_TOPMOST
        );
        
        // Handle response and cache the decision
        if (result == IDYES) {
            callback->Continue(requested_permissions); // Allow all requested permissions
            cachePermission(origin, PermissionType::USER_MEDIA, PermissionStatus::ALLOWED);
            printf("CEF: User allowed media access for %s (cached)\n", origin.c_str());
        } else {
            callback->Cancel();
            cachePermission(origin, PermissionType::USER_MEDIA, PermissionStatus::DENIED);
            printf("CEF: User blocked media access for %s (cached)\n", origin.c_str());
        }
        
        return true; // We handled the permission request
    }
    
    bool OnShowPermissionPrompt(
        CefRefPtr<CefBrowser> browser,
        uint64_t prompt_id,
        const CefString& requesting_origin,
        uint32_t requested_permissions,
        CefRefPtr<CefPermissionPromptCallback> callback) override {
        
        std::string origin = requesting_origin.ToString();
        printf("CEF: Permission prompt requested for %s (permissions: %u)\n", origin.c_str(), requested_permissions);
        
        // Handle different permission types
        PermissionType permType = PermissionType::OTHER;
        std::string message = "This page is requesting additional permissions.\n\nDo you want to allow this?";
        std::string title = "Permission Request";
        
        // Check for specific permission types
        if (requested_permissions & CEF_PERMISSION_TYPE_CAMERA_STREAM ||
            requested_permissions & CEF_PERMISSION_TYPE_MIC_STREAM) {
            permType = PermissionType::USER_MEDIA;
            message = "This page wants to access your camera and/or microphone.\n\nDo you want to allow this?";
            title = "Camera & Microphone Access";
        } else if (requested_permissions & CEF_PERMISSION_TYPE_GEOLOCATION) {
            permType = PermissionType::GEOLOCATION;
            message = "This page wants to access your location.\n\nDo you want to allow this?";
            title = "Location Access";
        } else if (requested_permissions & CEF_PERMISSION_TYPE_NOTIFICATIONS) {
            permType = PermissionType::NOTIFICATIONS;
            message = "This page wants to show notifications.\n\nDo you want to allow this?";
            title = "Notification Permission";
        }
        
        // Check cache first
        PermissionStatus cachedStatus = getPermissionFromCache(origin, permType);
        
        if (cachedStatus == PermissionStatus::ALLOWED) {
            printf("CEF: Using cached permission: User previously allowed %s for %s\n", title.c_str(), origin.c_str());
            callback->Continue(CEF_PERMISSION_RESULT_ACCEPT);
            return true;
        } else if (cachedStatus == PermissionStatus::DENIED) {
            printf("CEF: Using cached permission: User previously blocked %s for %s\n", title.c_str(), origin.c_str());
            callback->Continue(CEF_PERMISSION_RESULT_DENY);
            return true;
        }
        
        // No cached permission, show dialog
        printf("CEF: No cached permission found for %s, showing dialog\n", origin.c_str());
        
        // Show Windows message box
        int result = MessageBoxA(
            nullptr,
            message.c_str(),
            title.c_str(),
            MB_YESNO | MB_ICONQUESTION | MB_TOPMOST
        );
        
        // Handle response and cache the decision
        if (result == IDYES) {
            callback->Continue(CEF_PERMISSION_RESULT_ACCEPT);
            cachePermission(origin, permType, PermissionStatus::ALLOWED);
            printf("CEF: User allowed %s for %s (cached)\n", title.c_str(), origin.c_str());
        } else {
            callback->Continue(CEF_PERMISSION_RESULT_DENY);
            cachePermission(origin, permType, PermissionStatus::DENIED);
            printf("CEF: User blocked %s for %s (cached)\n", title.c_str(), origin.c_str());
        }
        
        return true; // We handled the permission request
    }
    
    void OnDismissPermissionPrompt(
        CefRefPtr<CefBrowser> browser,
        uint64_t prompt_id,
        cef_permission_request_result_t result) override {
        
        printf("CEF: Permission prompt %I64u dismissed with result %d\n", prompt_id, result);
        // Optional: Handle prompt dismissal if needed
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunPermissionHandler);
};

// Helper functions for string conversion
std::wstring StringToWString(const std::string& str) {
    if (str.empty()) return std::wstring();
    
    int sizeRequired = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, nullptr, 0);
    if (sizeRequired <= 0) {
        // Fallback to simple conversion (ASCII safe)
        std::wstring result;
        result.reserve(str.length());
        for (char c : str) {
            result.push_back(static_cast<wchar_t>(static_cast<unsigned char>(c)));
        }
        return result;
    }
    
    std::wstring wstr(sizeRequired, 0);
    MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, &wstr[0], sizeRequired);
    wstr.pop_back(); // Remove null terminator
    return wstr;
}

std::string WStringToString(const std::wstring& wstr) {
    if (wstr.empty()) return std::string();
    
    int sizeRequired = WideCharToMultiByte(CP_UTF8, 0, wstr.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (sizeRequired <= 0) {
        // Fallback to simple conversion (ASCII safe)
        std::string result;
        result.reserve(wstr.length());
        for (wchar_t wc : wstr) {
            if (wc <= 127) { // ASCII range
                result.push_back(static_cast<char>(wc));
            } else {
                result.push_back('?'); // Replace non-ASCII with ?
            }
        }
        return result;
    }
    
    std::string str(sizeRequired, 0);
    WideCharToMultiByte(CP_UTF8, 0, wstr.c_str(), -1, &str[0], sizeRequired, nullptr, nullptr);
    str.pop_back(); // Remove null terminator
    return str;
}

// CEF Dialog Handler for file dialogs
class ElectrobunDialogHandler : public CefDialogHandler {
public:
    bool OnFileDialog(CefRefPtr<CefBrowser> browser,
                      FileDialogMode mode,
                      const CefString& title,
                      const CefString& default_file_path,
                      const std::vector<CefString>& accept_filters,
                      CefRefPtr<CefFileDialogCallback> callback) override {
        
        printf("CEF Windows: File dialog requested - mode: %d\n", static_cast<int>(mode));
        
        // Run file dialog on main thread using Windows native dialog
        HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        if (FAILED(hr)) {
            callback->Continue(std::vector<CefString>());
            return true;
        }
        
        IFileOpenDialog* pFileDialog = nullptr;
        hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_ALL, IID_IFileOpenDialog, (void**)&pFileDialog);
        if (FAILED(hr)) {
            CoUninitialize();
            callback->Continue(std::vector<CefString>());
            return true;
        }
        
        // Set dialog options based on mode
        DWORD dwFlags = 0;
        pFileDialog->GetOptions(&dwFlags);
        
        if (mode == FILE_DIALOG_OPEN_MULTIPLE) {
            dwFlags |= FOS_ALLOWMULTISELECT;
        } else if (mode == FILE_DIALOG_OPEN_FOLDER) {
            dwFlags |= FOS_PICKFOLDERS;
        }
        
        pFileDialog->SetOptions(dwFlags);
        
        // Set title if provided
        if (!title.empty()) {
            std::wstring wTitle = StringToWString(title.ToString());
            pFileDialog->SetTitle(wTitle.c_str());
        }
        
        // Set default file path if provided
        if (!default_file_path.empty()) {
            std::wstring wPath = StringToWString(default_file_path.ToString());
            
            IShellItem* pDefaultFolder = nullptr;
            hr = SHCreateItemFromParsingName(wPath.c_str(), nullptr, IID_IShellItem, (void**)&pDefaultFolder);
            if (SUCCEEDED(hr)) {
                if (mode == FILE_DIALOG_SAVE) {
                    pFileDialog->SetDefaultFolder(pDefaultFolder);
                } else {
                    pFileDialog->SetFolder(pDefaultFolder);
                }
                pDefaultFolder->Release();
            }
        }
        
        // Set file filters
        if (!accept_filters.empty()) {
            std::vector<COMDLG_FILTERSPEC> filterSpecs;
            std::vector<std::wstring> filterNames;
            std::vector<std::wstring> filterPatterns;
            
            for (const auto& filter : accept_filters) {
                std::wstring wFilter = StringToWString(filter.ToString());
                
                if (wFilter.find(L".") != 0 && wFilter != L"*" && wFilter != L"*.*") {
                    wFilter = L"." + wFilter;
                }
                
                std::wstring pattern = (wFilter == L"*" || wFilter == L"*.*") ? L"*.*" : L"*" + wFilter;
                std::wstring name = (wFilter == L"*" || wFilter == L"*.*") ? L"All files" : wFilter.substr(1) + L" files";
                
                filterNames.push_back(name);
                filterPatterns.push_back(pattern);
                
                COMDLG_FILTERSPEC spec;
                spec.pszName = filterNames.back().c_str();
                spec.pszSpec = filterPatterns.back().c_str();
                filterSpecs.push_back(spec);
            }
            
            pFileDialog->SetFileTypes(static_cast<UINT>(filterSpecs.size()), filterSpecs.data());
        }
        
        // Show the dialog
        hr = pFileDialog->Show(nullptr);
        
        std::vector<CefString> file_paths;
        if (SUCCEEDED(hr)) {
            if (mode == FILE_DIALOG_OPEN_MULTIPLE) {
                IShellItemArray* pShellItemArray = nullptr;
                hr = pFileDialog->GetResults(&pShellItemArray);
                if (SUCCEEDED(hr)) {
                    DWORD count = 0;
                    pShellItemArray->GetCount(&count);
                    
                    for (DWORD i = 0; i < count; i++) {
                        IShellItem* pShellItem = nullptr;
                        hr = pShellItemArray->GetItemAt(i, &pShellItem);
                        if (SUCCEEDED(hr)) {
                            PWSTR pszFilePath = nullptr;
                            hr = pShellItem->GetDisplayName(SIGDN_FILESYSPATH, &pszFilePath);
                            if (SUCCEEDED(hr)) {
                                // Convert wide string to regular string
                                std::string path = WStringToString(pszFilePath);
                                file_paths.push_back(path);
                                CoTaskMemFree(pszFilePath);
                            }
                            pShellItem->Release();
                        }
                    }
                    pShellItemArray->Release();
                }
            } else {
                IShellItem* pShellItem = nullptr;
                hr = pFileDialog->GetResult(&pShellItem);
                if (SUCCEEDED(hr)) {
                    PWSTR pszFilePath = nullptr;
                    hr = pShellItem->GetDisplayName(SIGDN_FILESYSPATH, &pszFilePath);
                    if (SUCCEEDED(hr)) {
                        // Convert wide string to regular string
                        std::string path = WStringToString(pszFilePath);
                        file_paths.push_back(path);
                        CoTaskMemFree(pszFilePath);
                    }
                    pShellItem->Release();
                }
            }
        }
        
        pFileDialog->Release();
        CoUninitialize();
        
        // Call the callback with results
        callback->Continue(file_paths);
        
        printf("CEF Windows: File dialog completed with %zu files selected\n", file_paths.size());
        return true; // We handled the dialog
    }
    
private:
    IMPLEMENT_REFCOUNTING(ElectrobunDialogHandler);
};

// CEF Client class with load and life span handlers
class ElectrobunCefClient : public CefClient {
public:
    ElectrobunCefClient(uint32_t webviewId,
                       HandlePostMessage bunBridgeHandler,
                       HandlePostMessage internalBridgeHandler) 
        : webview_id_(webviewId), 
          bun_bridge_handler_(bunBridgeHandler),
          webview_tag_handler_(internalBridgeHandler) {
        m_loadHandler = new ElectrobunLoadHandler();
        m_lifeSpanHandler = new ElectrobunLifeSpanHandler();
        m_requestHandler = new ElectrobunRequestHandler();
        m_contextMenuHandler = new ElectrobunContextMenuHandler();
        m_permissionHandler = new ElectrobunPermissionHandler();
        m_dialogHandler = new ElectrobunDialogHandler();
    }

    void AddPreloadScript(const std::string& script) {
        electrobun_script_ = script;
    }

    void UpdateCustomPreloadScript(const std::string& script) {
        custom_script_ = script;
    }
    
    CefRefPtr<CefLoadHandler> GetLoadHandler() override {
        return m_loadHandler;
    }
    
    CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override {
        return m_lifeSpanHandler;
    }
    
    CefRefPtr<CefRequestHandler> GetRequestHandler() override {
        return m_requestHandler;
    }
    
    CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override {
        return m_contextMenuHandler;
    }
    
    CefRefPtr<CefPermissionHandler> GetPermissionHandler() override {
        return m_permissionHandler;
    }
    
    CefRefPtr<CefDialogHandler> GetDialogHandler() override {
        return m_dialogHandler;
    }

    bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                 CefRefPtr<CefFrame> frame,
                                 CefProcessId source_process,
                                 CefRefPtr<CefProcessMessage> message) override {
        std::string messageName = message->GetName().ToString();
        std::string messageContent = message->GetArgumentList()->GetString(0).ToString();
        
        char* contentCopy = strdup(messageContent.c_str());
        
        if (messageName == "BunBridgeMessage") {
            if (bun_bridge_handler_) {
                bun_bridge_handler_(webview_id_, contentCopy);
            }
            return true;
        } else if (messageName == "internalMessage") {
            if (webview_tag_handler_) {
                webview_tag_handler_(webview_id_, contentCopy);
            }
            return true;
        }
        
        return false;
    }


    std::string GetCombinedScript() const {
        // Inject webviewId into global scope before other scripts
        std::string combined_script = "window.webviewId = " + std::to_string(webview_id_) + ";\n";
        combined_script += electrobun_script_;
        if (!custom_script_.empty()) {
            combined_script += "\n" + custom_script_;
        }
        return combined_script;
    }

    void SetBrowser(CefRefPtr<CefBrowser> browser) {
        browser_ = browser;
        // Don't execute scripts here - they should execute on each navigation
    }

    void ExecutePreloadScripts() {
        std::string script = GetCombinedScript();
        if (!script.empty() && browser_ && browser_->GetMainFrame()) {
            browser_->GetMainFrame()->ExecuteJavaScript(script, "", 0);
        }
    }

private:
    uint32_t webview_id_;
    HandlePostMessage bun_bridge_handler_;
    HandlePostMessage webview_tag_handler_;
    std::string electrobun_script_;
    std::string custom_script_;
    CefRefPtr<CefBrowser> browser_;
    CefRefPtr<ElectrobunLoadHandler> m_loadHandler;
    CefRefPtr<ElectrobunLifeSpanHandler> m_lifeSpanHandler;
    CefRefPtr<ElectrobunRequestHandler> m_requestHandler;
    CefRefPtr<ElectrobunContextMenuHandler> m_contextMenuHandler;
    CefRefPtr<ElectrobunPermissionHandler> m_permissionHandler;
    CefRefPtr<ElectrobunDialogHandler> m_dialogHandler;
    IMPLEMENT_REFCOUNTING(ElectrobunCefClient);
};

// Helper function implementation (defined after ElectrobunCefClient class)
void SetBrowserOnClient(CefRefPtr<ElectrobunCefClient> client, CefRefPtr<CefBrowser> browser) {
    if (client && browser) {
        client->SetBrowser(browser);
        // Store preload scripts for this browser ID so load handler can access them
        std::string script = client->GetCombinedScript();
        if (!script.empty()) {
            g_preloadScripts[browser->GetIdentifier()] = script;
        }
    }
}

// Runtime CEF availability detection - Windows equivalent of macOS isCEFAvailable()
bool isCEFAvailable() {
    char exePath[MAX_PATH];
    GetModuleFileNameA(NULL, exePath, MAX_PATH);
    char* lastSlash = strrchr(exePath, '\\');
    if (lastSlash) {
        *lastSlash = '\0';
    }
    
    // Check for essential CEF files
    std::string cefLibPath = std::string(exePath) + "\\libcef.dll";
    std::string icuDataPath = std::string(exePath) + "\\icudtl.dat";
    
    DWORD libAttributes = GetFileAttributesA(cefLibPath.c_str());
    DWORD icuAttributes = GetFileAttributesA(icuDataPath.c_str());
    
    bool libExists = (libAttributes != INVALID_FILE_ATTRIBUTES && !(libAttributes & FILE_ATTRIBUTE_DIRECTORY));
    bool icuExists = (icuAttributes != INVALID_FILE_ATTRIBUTES && !(icuAttributes & FILE_ATTRIBUTE_DIRECTORY));
    
    return libExists && icuExists;
}

class StatusItemTarget {
public:
    ZigStatusItemHandler zigHandler;
    uint32_t trayId;
    
    StatusItemTarget() : zigHandler(nullptr), trayId(0) {}
};



// Forward declare helper functions
void setupViewsSchemeHandler(ICoreWebView2* webview, uint32_t webviewId);
void handleViewsSchemeRequest(ICoreWebView2WebResourceRequestedEventArgs* args, 
                             const std::wstring& uri, 
                             uint32_t webviewId);
std::string loadViewsFile(const std::string& path);
std::string getMimeTypeForFile(const std::string& path);
void updateActiveWebviewForMousePosition(ContainerView* container, POINT mousePos);

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

// Generic Bridge Handler COM Object - can be used for any bridge type
class BridgeHandler : public IDispatch {
private:
    long m_refCount;
    HandlePostMessage m_callback;
    uint32_t m_webviewId;
    std::string m_bridgeName;

public:
    BridgeHandler(const std::string& bridgeName, HandlePostMessage callback, uint32_t webviewId) 
        : m_refCount(1), m_callback(callback), m_webviewId(webviewId), m_bridgeName(bridgeName) {
        
    }

    // IUnknown implementation
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
        if (riid == IID_IUnknown || riid == IID_IDispatch) {
            *ppvObject = static_cast<IDispatch*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return InterlockedIncrement(&m_refCount);
    }

    ULONG STDMETHODCALLTYPE Release() override {
        long refCount = InterlockedDecrement(&m_refCount);
        if (refCount == 0) {
            delete this;
        }
        return refCount;
    }

    // IDispatch implementation
    HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT* pctinfo) override {
        *pctinfo = 0;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT iTInfo, LCID lcid, ITypeInfo** ppTInfo) override {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID riid, LPOLESTR* rgszNames, UINT cNames, LCID lcid, DISPID* rgDispId) override {
        if (cNames == 1 && wcscmp(rgszNames[0], L"postMessage") == 0) {
            rgDispId[0] = 1; // DISPID for postMessage method
            return S_OK;
        }
        return DISP_E_UNKNOWNNAME;
    }

    HRESULT STDMETHODCALLTYPE Invoke(DISPID dispIdMember, REFIID riid, LCID lcid, WORD wFlags, DISPPARAMS* pDispParams, VARIANT* pVarResult, EXCEPINFO* pExcepInfo, UINT* puArgErr) override {
        if (dispIdMember == 1 && (wFlags & DISPATCH_METHOD)) { // postMessage method
            if (pDispParams->cArgs == 1 && pDispParams->rgvarg[0].vt == VT_BSTR) {
                return PostMessage(pDispParams->rgvarg[0].bstrVal);
            }
            return DISP_E_BADPARAMCOUNT;
        }
        return DISP_E_MEMBERNOTFOUND;
    }

    // Bridge-specific method for posting messages
    HRESULT PostMessage(BSTR message) {
        if (!m_callback) {
            ::log("ERROR: Bridge callback is null");
            return E_FAIL;
        }

        // Convert BSTR to char*
        int size = WideCharToMultiByte(CP_UTF8, 0, message, -1, NULL, 0, NULL, NULL);
        if (size <= 0) {
            ::log("ERROR: Failed to get required buffer size for message conversion");
            return E_FAIL;
        }

        char* message_char = new char[size];
        int result = WideCharToMultiByte(CP_UTF8, 0, message, -1, message_char, size, NULL, NULL);
        if (result == 0) {
            delete[] message_char;
            ::log("ERROR: Failed to convert message to UTF-8");
            return E_FAIL;
        }

        

        // Create a copy for the callback to avoid memory issues
        char* messageCopy = new char[strlen(message_char) + 1];
        strcpy_s(messageCopy, strlen(message_char) + 1, message_char);

        // Call the callback
        try {
            m_callback(m_webviewId, messageCopy);
        } catch (...) {
            ::log("ERROR: Exception in bridge callback");
            delete[] message_char;
            delete[] messageCopy;
            return E_FAIL;
        }

        // Schedule cleanup after a delay to avoid premature deallocation
        // (similar to the original delay-based cleanup)
        std::thread([messageCopy, message_char]() {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            delete[] messageCopy;
            delete[] message_char;
        }).detach();

        return S_OK;
    }
};

// Dispatch IDs for the bridge methods
#define DISPID_POSTMESSAGE 1

// Dispatch interface for BunBridge
class BunBridgeDispatch : public IDispatch {
private:
    long m_refCount;
    ComPtr<BridgeHandler> m_bridgeHandler;

public:
    BunBridgeDispatch(ComPtr<BridgeHandler> bridgeHandler) 
        : m_refCount(1), m_bridgeHandler(bridgeHandler) {}

    // IUnknown implementation
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
        if (riid == IID_IUnknown || riid == IID_IDispatch) {
            *ppvObject = static_cast<IDispatch*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return InterlockedIncrement(&m_refCount);
    }

    ULONG STDMETHODCALLTYPE Release() override {
        long refCount = InterlockedDecrement(&m_refCount);
        if (refCount == 0) {
            delete this;
        }
        return refCount;
    }

    // IDispatch implementation
    HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT* pctinfo) override {
        *pctinfo = 0;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT iTInfo, LCID lcid, ITypeInfo** ppTInfo) override {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID riid, LPOLESTR* rgszNames, UINT cNames, LCID lcid, DISPID* rgDispId) override {
        if (cNames != 1) return E_INVALIDARG;
        
        std::wstring name(rgszNames[0]);
        if (name == L"postMessage") {
            rgDispId[0] = DISPID_POSTMESSAGE;
            return S_OK;
        }
        
        return DISP_E_UNKNOWNNAME;
    }

    HRESULT STDMETHODCALLTYPE Invoke(DISPID dispIdMember, REFIID riid, LCID lcid, WORD wFlags, 
                                   DISPPARAMS* pDispParams, VARIANT* pVarResult, 
                                   EXCEPINFO* pExcepInfo, UINT* puArgErr) override {
        if (dispIdMember == DISPID_POSTMESSAGE) {
            if (pDispParams->cArgs != 1) {
                return DISP_E_BADPARAMCOUNT;
            }
            
            VARIANT* arg = &pDispParams->rgvarg[0];
            if (arg->vt != VT_BSTR) {
                return DISP_E_TYPEMISMATCH;
            }
            
            return m_bridgeHandler->PostMessage(arg->bstrVal);
        }
        
        return DISP_E_MEMBERNOTFOUND;
    }
};

// Dispatch interface for InternalBridge (same implementation, different name for clarity)
class InternalBridgeDispatch : public IDispatch {
private:
    long m_refCount;
    ComPtr<BridgeHandler> m_bridgeHandler;

public:
    InternalBridgeDispatch(ComPtr<BridgeHandler> bridgeHandler) 
        : m_refCount(1), m_bridgeHandler(bridgeHandler) {}

    // IUnknown implementation
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
        if (riid == IID_IUnknown || riid == IID_IDispatch) {
            *ppvObject = static_cast<IDispatch*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return InterlockedIncrement(&m_refCount);
    }

    ULONG STDMETHODCALLTYPE Release() override {
        long refCount = InterlockedDecrement(&m_refCount);
        if (refCount == 0) {
            delete this;
        }
        return refCount;
    }

    // IDispatch implementation (identical to BunBridgeDispatch)
    HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT* pctinfo) override {
        *pctinfo = 0;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT iTInfo, LCID lcid, ITypeInfo** ppTInfo) override {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID riid, LPOLESTR* rgszNames, UINT cNames, LCID lcid, DISPID* rgDispId) override {
        if (cNames != 1) return E_INVALIDARG;
        
        std::wstring name(rgszNames[0]);
        if (name == L"postMessage") {
            rgDispId[0] = DISPID_POSTMESSAGE;
            return S_OK;
        }
        
        return DISP_E_UNKNOWNNAME;
    }

    HRESULT STDMETHODCALLTYPE Invoke(DISPID dispIdMember, REFIID riid, LCID lcid, WORD wFlags, 
                                   DISPPARAMS* pDispParams, VARIANT* pVarResult, 
                                   EXCEPINFO* pExcepInfo, UINT* puArgErr) override {
        if (dispIdMember == DISPID_POSTMESSAGE) {
            if (pDispParams->cArgs != 1) {
                return DISP_E_BADPARAMCOUNT;
            }
            
            VARIANT* arg = &pDispParams->rgvarg[0];
            if (arg->vt != VT_BSTR) {
                return DISP_E_TYPEMISMATCH;
            }
            
            return m_bridgeHandler->PostMessage(arg->bstrVal);
        }
        
        return DISP_E_MEMBERNOTFOUND;
    }
};





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
    
    template<typename Func>
    static void dispatch_async(Func&& func) {
        auto task = new std::function<void()>(std::forward<Func>(func));
        PostMessage(g_messageWindow, WM_EXECUTE_ASYNC_BLOCK, 0, (LPARAM)task);
    }
};

HWND MainThreadDispatcher::g_messageWindow = NULL;

// AbstractView base class - Windows implementation matching Mac pattern
class AbstractView {
public:
    uint32_t webviewId;
    HWND hwnd = NULL;
    bool isMousePassthroughEnabled = false;
    bool mirrorModeEnabled = false;
    bool fullSize = false;
    
    // Common state
    bool isReceivingInput = true;
    std::string maskJSON;
    RECT visualBounds = {};
    bool creationFailed = false;
    
    // Bridge handlers
    ComPtr<BridgeHandler> bunBridgeHandler;
    ComPtr<BridgeHandler> internalBridgeHandler;
    ComPtr<BunBridgeDispatch> bunBridgeDispatch;
    ComPtr<InternalBridgeDispatch> internalBridgeDispatch;
    
    virtual ~AbstractView() = default;
    
    // Pure virtual methods - must be implemented by subclasses
    virtual void loadURL(const char* urlString) = 0;
    virtual void goBack() = 0;
    virtual void goForward() = 0;
    virtual void reload() = 0;
    virtual void remove() = 0;
    virtual bool canGoBack() = 0;
    virtual bool canGoForward() = 0;
    virtual void evaluateJavaScriptWithNoCompletion(const char* jsString) = 0;
    virtual void callAsyncJavascript(const char* messageId, const char* jsString, uint32_t webviewId, uint32_t hostWebviewId, void* completionHandler) = 0;
    virtual void addPreloadScriptToWebView(const char* jsString) = 0;
    virtual void updateCustomPreloadScript(const char* jsString) = 0;
    virtual void resize(const RECT& frame, const char* masksJson) = 0;
    
    // Common implementations
    virtual void setTransparent(bool transparent) {
        // Default implementation - can be overridden
    }
    
    virtual void setPassthrough(bool enable) {
        isMousePassthroughEnabled = enable;
    }
    
    virtual void setHidden(bool hidden) {
        if (hwnd) {
            ShowWindow(hwnd, hidden ? SW_HIDE : SW_SHOW);
        }
    }
    
    virtual void setCreationFailed(bool failed) {
        creationFailed = failed;
    }
    
    virtual bool hasCreationFailed() const {
        return creationFailed;
    }
    
    // Check if point is in a masked (cut-out) area based on maskJSON
    bool isPointInMask(POINT localPoint) {
        if (maskJSON.empty()) {
            return false;
        }
        
        // Simple JSON parsing for mask rectangles
        // Expected format: [{"x":10,"y":20,"width":100,"height":50},...]
        size_t pos = 0;
        while ((pos = maskJSON.find("\"x\":", pos)) != std::string::npos) {
            try {
                // Extract x, y, width, height from JSON
                size_t xStart = maskJSON.find(":", pos) + 1;
                size_t xEnd = maskJSON.find(",", xStart);
                int x = std::stoi(maskJSON.substr(xStart, xEnd - xStart));
                
                size_t yPos = maskJSON.find("\"y\":", pos);
                size_t yStart = maskJSON.find(":", yPos) + 1;
                size_t yEnd = maskJSON.find(",", yStart);
                int y = std::stoi(maskJSON.substr(yStart, yEnd - yStart));
                
                size_t wPos = maskJSON.find("\"width\":", pos);
                size_t wStart = maskJSON.find(":", wPos) + 1;
                size_t wEnd = maskJSON.find(",", wStart);
                if (wEnd == std::string::npos) wEnd = maskJSON.find("}", wStart);
                int width = std::stoi(maskJSON.substr(wStart, wEnd - wStart));
                
                size_t hPos = maskJSON.find("\"height\":", pos);
                size_t hStart = maskJSON.find(":", hPos) + 1;
                size_t hEnd = maskJSON.find("}", hStart);
                int height = std::stoi(maskJSON.substr(hStart, hEnd - hStart));
                
                // Check if point is within this mask rectangle
                if (localPoint.x >= x && localPoint.x < x + width &&
                    localPoint.y >= y && localPoint.y < y + height) {
                    return true;  // Point is in a masked area
                }
                
                pos = hEnd;
            } catch (...) {
                // JSON parsing error, skip this mask
                pos++;
            }
        }
        
        return false;  // Point is not in any masked area
    }
    
    // Virtual methods for subclass-specific functionality
    virtual void applyVisualMask() = 0;
    virtual void removeMasks() = 0;
    virtual void toggleMirrorMode(bool enable) = 0;
};

// WebView2View class - implements AbstractView for WebView2
class WebView2View : public AbstractView {
private:
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2CompositionController> compositionController;
    ComPtr<ICoreWebView2> webview;
    HandlePostMessage bunBridgeCallbackHandler;
    HandlePostMessage internalBridgeCallbackHandler;
    
public:
    std::string pendingUrl;
    std::string electrobunScript;
    std::string customScript;
    bool isCreationComplete = false;
    
    WebView2View(uint32_t webviewId, HandlePostMessage bunBridgeHandler, HandlePostMessage internalBridgeHandler) 
        : bunBridgeCallbackHandler(bunBridgeHandler), internalBridgeCallbackHandler(internalBridgeHandler) {
        this->webviewId = webviewId;
    }
    
    // Setter methods for COM objects (called from async creation callbacks)
    void setController(ComPtr<ICoreWebView2Controller> ctrl) {
        controller = ctrl;
    }
    
    void setCompositionController(ComPtr<ICoreWebView2CompositionController> compCtrl) {
        compositionController = compCtrl;
    }
    
    void setWebView(ComPtr<ICoreWebView2> wv) {
        webview = wv;
    }
    
    void setCreationComplete(bool complete) {
        isCreationComplete = complete;
    }
    
    bool isReady() const {
        return isCreationComplete && !creationFailed;
    }
    
    // Set up the JavaScript bridge objects in the WebView2 context using hostObjects
    void setupJavaScriptBridges() {
        if (!webview) return;
        
        // Create COM objects for the bridge handlers
        bunBridgeHandler = ComPtr<BridgeHandler>(new BridgeHandler("bunBridge", bunBridgeCallbackHandler, webviewId));
        internalBridgeHandler = ComPtr<BridgeHandler>(new BridgeHandler("internalBridge", internalBridgeCallbackHandler, webviewId));
        
        // Convert COM objects to VARIANT for AddHostObjectToScript
        VARIANT bunBridgeVariant = {};
        VariantInit(&bunBridgeVariant);
        bunBridgeVariant.vt = VT_DISPATCH;
        bunBridgeVariant.pdispVal = static_cast<IDispatch*>(bunBridgeHandler.Get());
        
        VARIANT internalBridgeVariant = {};
        VariantInit(&internalBridgeVariant);
        internalBridgeVariant.vt = VT_DISPATCH;
        internalBridgeVariant.pdispVal = static_cast<IDispatch*>(internalBridgeHandler.Get());
        
        // Add the bridge objects to hostObjects
        webview->AddHostObjectToScript(L"bunBridge", &bunBridgeVariant);
        webview->AddHostObjectToScript(L"internalBridge", &internalBridgeVariant);
        
        // Clean up VARIANTs
        VariantClear(&bunBridgeVariant);
        VariantClear(&internalBridgeVariant);
        
    }
    
    void loadURL(const char* urlString) override {
        if (webview) {
            std::wstring url = std::wstring(urlString, urlString + strlen(urlString));
            webview->Navigate(url.c_str());
        }
    }
    
    void goBack() override {
        if (webview) {
            webview->GoBack();
        }
    }
    
    void goForward() override {
        if (webview) {
            webview->GoForward();
        }
    }
    
    void reload() override {
        if (webview) {
            webview->Reload();
        }
    }
    
    void remove() override {
        if (controller) {
            controller->Close();
            controller = nullptr;
        }
        webview = nullptr;
    }
    
    bool canGoBack() override {
        if (webview) {
            BOOL canGoBack = FALSE;
            webview->get_CanGoBack(&canGoBack);
            return canGoBack;
        }
        return false;
    }
    
    bool canGoForward() override {
        if (webview) {
            BOOL canGoForward = FALSE;
            webview->get_CanGoForward(&canGoForward);
            return canGoForward;
        }
        return false;
    }
    
    void evaluateJavaScriptWithNoCompletion(const char* jsString) override {
        if (webview) {
            // Copy string to avoid lifetime issues in lambda
            std::string jsStringCopy = jsString;
            MainThreadDispatcher::dispatch_sync([this, jsStringCopy]() {
                std::wstring js = std::wstring(jsStringCopy.begin(), jsStringCopy.end());
                HRESULT hr = webview->ExecuteScript(js.c_str(), nullptr);
                if (FAILED(hr)) {
                    char logMsg[256];
                    sprintf_s(logMsg, "WebView2: ExecuteScript failed with HRESULT: 0x%08lX", hr);
                    ::log(logMsg);
                } else {
                }
            });
        } else {
            ::log("WebView2: webview is NULL, cannot execute JavaScript");
        }
    }
    
    void callAsyncJavascript(const char* messageId, const char* jsString, uint32_t webviewId, uint32_t hostWebviewId, void* completionHandler) override {
        if (webview) {
            std::wstring js = std::wstring(jsString, jsString + strlen(jsString));
            webview->ExecuteScript(js.c_str(), (ICoreWebView2ExecuteScriptCompletedHandler*)completionHandler);
        }
    }
    
    void addPreloadScriptToWebView(const char* jsString) override {
        if (webview && jsString) {
            std::wstring js = std::wstring(jsString, jsString + strlen(jsString));
            webview->AddScriptToExecuteOnDocumentCreated(js.c_str(), nullptr);
            std::cout << "[WebView2] Added preload script to execute on document created (length: " << strlen(jsString) << ")" << std::endl;
        }
    }
    
    void updateCustomPreloadScript(const char* jsString) override {
        // Implementation for updating custom preload script
    }
    
    void resize(const RECT& frame, const char* masksJson) override {
        
        if (controller) {
            // WebView2 operations must be called from main thread to avoid TYPE_E_BADVARTYPE
            MainThreadDispatcher::dispatch_async([this, frame]() {
                HRESULT result = controller->put_Bounds(frame);
                if (FAILED(result)) {
                    char errorLog[256];
                    sprintf_s(errorLog, "[WebView2] put_Bounds failed for webview %u, HRESULT: 0x%08X", webviewId, result);
                    ::log(errorLog);
                }
            });
            
            visualBounds = frame;
            bool maskChanged = false;
            if (masksJson) {
                std::string newMaskJSON = masksJson;
                if (newMaskJSON != maskJSON) {
                    maskJSON = newMaskJSON;
                    maskChanged = true;
                }
            } else if (!maskJSON.empty()) {
                maskJSON = "";
                maskChanged = true;
            }
            
            // Only apply visual mask if mask data changed
            if (maskChanged) {
                applyVisualMask();
            }
        } else {
            ::log("[WebView2] ERROR: Controller is NULL, cannot resize");
        }
    }
    
    ComPtr<ICoreWebView2Controller> getController() {
        return controller;
    }
    
    ComPtr<ICoreWebView2> getWebView() {
        return webview;
    }
    
    // WebView2-specific implementation of mask functionality
    void applyVisualMask() override {        
        if (!controller) {
            ::log("applyVisualMask: controller is null, returning");
            return;
        }
        
        if (maskJSON.empty()) {
            // ::log("applyVisualMask: maskJSON empty, removing masks");
            removeMasks();
            return;
        }
        
        // Use composition controller if available, otherwise fallback to window masking
        if (compositionController) {
            // ::log("applyVisualMask: using composition controller approach");
            applyCompositionMask();
        } else {
            // ::log("applyVisualMask: using window region fallback approach");
            applyWindowMask();
        }
    }
    
    void removeMasks() override {
        if (compositionController) {
            // Clear composition mask
            compositionController->put_RootVisualTarget(nullptr);
            // ::log("removeMasks: cleared composition mask");
        } else {
            // For fallback approach, clear window region from specific WebView2 window
            HWND webview2Hwnd = getWebView2WindowHandle();
            if (webview2Hwnd) {
                // Clear the window region by setting it to nullptr
                if (SetWindowRgn(webview2Hwnd, nullptr, TRUE) != 0) {
                    // ::log("removeMasks: window region cleared successfully from WebView2");
                } else {
                    // ::log("removeMasks: failed to clear window region from WebView2");
                }
            } else {
                ::log("removeMasks: could not find WebView2 window handle");
            }
            // ::log("removeMasks: cleared fallback mask");
        }
    }
    
    void toggleMirrorMode(bool enable) override {
        if (!controller) return;
        
        if (enable && !mirrorModeEnabled) {
            mirrorModeEnabled = true;
            // Disable input for WebView2
        } else if (!enable && mirrorModeEnabled) {
            mirrorModeEnabled = false;
            controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        }
    }
    
    // Helper function to find the actual WebView2 child window handle
    HWND getWebView2WindowHandle() {
        if (!hwnd) return nullptr;
        
        // Find the container window first
        HWND containerHwnd = FindWindowEx(hwnd, nullptr, nullptr, nullptr);
        if (!containerHwnd) return nullptr;
        
        // Structure to pass data to the enum callback
        struct EnumData {
            HWND webview2Hwnd;
            uint32_t targetWebviewId;
        } enumData = { nullptr, webviewId };
        
        // Enumerate child windows of the container to find the WebView2 window
        EnumChildWindows(containerHwnd, [](HWND hwnd, LPARAM lParam) -> BOOL {
            EnumData* data = reinterpret_cast<EnumData*>(lParam);
            
            // Check if this is a WebView2 window by checking class name
            char className[256];
            if (GetClassNameA(hwnd, className, sizeof(className)) > 0) {
                // WebView2 typically creates windows with Chrome-related class names
                if (strstr(className, "Chrome") || strstr(className, "WebView") || 
                    strstr(className, "Edge") || strstr(className, "Browser")) {
                    data->webview2Hwnd = hwnd;
                    return FALSE; // Stop enumeration
                }
            }
            return TRUE; // Continue enumeration
        }, reinterpret_cast<LPARAM>(&enumData));
        
        return enumData.webview2Hwnd;
    }

private:
    // WebView2-specific helper for composition-based masking
    void applyCompositionMask() {
        if (!compositionController || maskJSON.empty()) {
            return;
        }
        
        try {
            // Create Windows composition visual with mask geometry
            // This requires Direct Composition integration with WebView2
            // For now, use the simpler approach of creating a mask region
            HRGN maskRegion = CreateRectRgn(0, 0, 0, 0);
            
            // Parse maskJSON and build combined mask region
            size_t pos = 0;
            int maskCount = 0;
            while ((pos = maskJSON.find("\"x\":", pos)) != std::string::npos) {
                try {
                    // Extract mask rectangle coordinates  
                    size_t xStart = maskJSON.find(":", pos) + 1;
                    size_t xEnd = maskJSON.find(",", xStart);
                    int x = std::stoi(maskJSON.substr(xStart, xEnd - xStart));
                    
                    size_t yPos = maskJSON.find("\"y\":", pos);
                    size_t yStart = maskJSON.find(":", yPos) + 1;
                    size_t yEnd = maskJSON.find(",", yStart);
                    int y = std::stoi(maskJSON.substr(yStart, yEnd - yStart));
                    
                    size_t wPos = maskJSON.find("\"width\":", pos);
                    size_t wStart = maskJSON.find(":", wPos) + 1;
                    size_t wEnd = maskJSON.find(",", wStart);
                    if (wEnd == std::string::npos) wEnd = maskJSON.find("}", wStart);
                    int width = std::stoi(maskJSON.substr(wStart, wEnd - wStart));
                    
                    size_t hPos = maskJSON.find("\"height\":", pos);
                    size_t hStart = maskJSON.find(":", hPos) + 1;
                    size_t hEnd = maskJSON.find("}", hStart);
                    int height = std::stoi(maskJSON.substr(hStart, hEnd - hStart));
                    
                    // Create region for this mask rectangle
                    HRGN rectRegion = CreateRectRgn(x, y, x + width, y + height);
                    if (rectRegion) {
                        CombineRgn(maskRegion, maskRegion, rectRegion, RGN_OR);
                        DeleteObject(rectRegion);
                        maskCount++;
                    }
                    
                    pos = hEnd;
                } catch (...) {
                    pos++;
                }
            }
            
            if (maskCount > 0) {
                
                
                // For WebView2, we need to implement visual hosting approach
                // This is a simplified version - full implementation would use DirectComposition
                // TODO: Implement proper DirectComposition visual tree masking
                
                DeleteObject(maskRegion);
            } else {
                ::log("applyCompositionMask: no valid mask rectangles found");
                DeleteObject(maskRegion);
            }
            
        } catch (...) {
            ::log("applyCompositionMask: exception occurred during mask creation");
        }
    }
    
    // Fallback window-based masking for when composition controller is not available
    void applyWindowMask() {
        if (!controller || maskJSON.empty()) {
            return;
        }
        
        
        try {
            // Get the WebView2 window bounds
            RECT bounds;
            HRESULT boundsResult = controller->get_Bounds(&bounds);
            int width = bounds.right - bounds.left;
            int height = bounds.bottom - bounds.top;
            
           
            
            if (width <= 0 || height <= 0) {
                ::log("applyWindowMask: invalid WebView2 bounds - using visual bounds fallback");
                // Use the stored visual bounds instead
                RECT visualRect = visualBounds;
                width = visualRect.right - visualRect.left;
                height = visualRect.bottom - visualRect.top;
                
                
                
                if (width <= 0 || height <= 0) {
                    ::log("applyWindowMask: visual bounds also invalid, cannot apply mask");
                    return;
                }
            }
            
            // Create base region covering entire webview
            HRGN webviewRegion = CreateRectRgn(0, 0, width, height);
            
            // Parse maskJSON and subtract mask regions (holes)
            size_t pos = 0;
            int maskCount = 0;
            while ((pos = maskJSON.find("\"x\":", pos)) != std::string::npos) {
                try {
                    // Extract mask rectangle coordinates  
                    size_t xStart = maskJSON.find(":", pos) + 1;
                    size_t xEnd = maskJSON.find(",", xStart);
                    int x = std::stoi(maskJSON.substr(xStart, xEnd - xStart));
                    
                    size_t yPos = maskJSON.find("\"y\":", pos);
                    size_t yStart = maskJSON.find(":", yPos) + 1;
                    size_t yEnd = maskJSON.find(",", yStart);
                    int y = std::stoi(maskJSON.substr(yStart, yEnd - yStart));
                    
                    size_t wPos = maskJSON.find("\"width\":", pos);
                    size_t wStart = maskJSON.find(":", wPos) + 1;
                    size_t wEnd = maskJSON.find(",", wStart);
                    if (wEnd == std::string::npos) wEnd = maskJSON.find("}", wStart);
                    int maskWidth = std::stoi(maskJSON.substr(wStart, wEnd - wStart));
                    
                    size_t hPos = maskJSON.find("\"height\":", pos);
                    size_t hStart = maskJSON.find(":", hPos) + 1;
                    size_t hEnd = maskJSON.find("}", hStart);
                    int maskHeight = std::stoi(maskJSON.substr(hStart, hEnd - hStart));
                    
                    // Create hole region and subtract from webview region
                    HRGN holeRegion = CreateRectRgn(x, y, x + maskWidth, y + maskHeight);
                    if (holeRegion) {
                        CombineRgn(webviewRegion, webviewRegion, holeRegion, RGN_DIFF);
                        DeleteObject(holeRegion);
                        maskCount++;
                    }
                    
                    pos = hEnd;
                } catch (...) {
                    pos++;
                }
            }
            
            if (maskCount > 0) {
                
                
                // Apply the region to the specific WebView2 child window
                HWND webview2Hwnd = getWebView2WindowHandle();
                if (webview2Hwnd) {
                    
                    
                    // Apply the region to the specific WebView2 window
                    if (SetWindowRgn(webview2Hwnd, webviewRegion, TRUE) != 0) {
                        // ::log("applyWindowMask: window region applied successfully to WebView2");
                        // Don't delete the region - SetWindowRgn takes ownership
                        return;
                    } else {
                        ::log("applyWindowMask: failed to apply window region to WebView2");
                    }
                } else {
                    ::log("applyWindowMask: could not find WebView2 window handle");
                }
            }
            
            DeleteObject(webviewRegion);
            
        } catch (...) {
            ::log("applyWindowMask: exception occurred during mask creation");
        }
    }
};

// CEFView class - implements AbstractView for CEF
class CEFView : public AbstractView {
private:
    CefRefPtr<CefBrowser> browser;
    CefRefPtr<ElectrobunCefClient> client;
    
public:
    CEFView(uint32_t webviewId) {
        this->webviewId = webviewId;
    }
    
    void loadURL(const char* urlString) override {
        if (browser) {
            browser->GetMainFrame()->LoadURL(urlString);
        }
    }
    
    void goBack() override {
        if (browser) {
            browser->GoBack();
        }
    }
    
    void goForward() override {
        if (browser) {
            browser->GoForward();
        }
    }
    
    void reload() override {
        if (browser) {
            browser->Reload();
        }
    }
    
    void remove() override {
        if (browser) {
            browser->GetHost()->CloseBrowser(true);
            browser = nullptr;
        }
    }
    
    bool canGoBack() override {
        if (browser) {
            return browser->CanGoBack();
        }
        return false;
    }
    
    bool canGoForward() override {
        if (browser) {
            return browser->CanGoForward();
        }
        return false;
    }
    
    void evaluateJavaScriptWithNoCompletion(const char* jsString) override {
        if (browser) {
            // Copy string to avoid lifetime issues in lambda
            std::string jsStringCopy = jsString;
            MainThreadDispatcher::dispatch_sync([this, jsStringCopy]() {
                browser->GetMainFrame()->ExecuteJavaScript(jsStringCopy.c_str(), "", 0);
            });
        }
    }
    
    void callAsyncJavascript(const char* messageId, const char* jsString, uint32_t webviewId, uint32_t hostWebviewId, void* completionHandler) override {
        if (browser) {
            // CEF async JavaScript execution would need additional implementation
            browser->GetMainFrame()->ExecuteJavaScript(jsString, "", 0);
        }
    }
    
    void addPreloadScriptToWebView(const char* jsString) override {
        if (!jsString) return;
        
        // For CEF, preload scripts are typically handled via CefClient::OnContextCreated
        // For now, store the script to be injected when the context is created
        if (browser) {
            browser->GetMainFrame()->ExecuteJavaScript(jsString, browser->GetMainFrame()->GetURL(), 0);
        }
    }
    
    void updateCustomPreloadScript(const char* jsString) override {
        if (!jsString) return;
        
        // Check if this is a views:// URL for a script file
        if (strncmp(jsString, "views://", 8) == 0) {
            // Read the script file using existing WebView2 logic
            std::string scriptContent = loadViewsFile(std::string(jsString + 8)); // Remove "views://" prefix
            if (!scriptContent.empty()) {
                if (browser) {
                    browser->GetMainFrame()->ExecuteJavaScript(scriptContent.c_str(), browser->GetMainFrame()->GetURL(), 0);
                }
            } else {
                log(std::string("CEFView: Could not read preload script from: ") + std::string(jsString));
            }
        } else {
            // Inline JavaScript
            if (browser) {
                browser->GetMainFrame()->ExecuteJavaScript(jsString, browser->GetMainFrame()->GetURL(), 0);
            }
        }
    }
    
    // CEF-specific methods
    void setBrowser(CefRefPtr<CefBrowser> br) {
        browser = br;
    }
    
    void setClient(CefRefPtr<ElectrobunCefClient> cl) {
        client = cl;
    }
    
    CefRefPtr<CefBrowser> getBrowser() {
        return browser;
    }
    
    CefRefPtr<ElectrobunCefClient> getClient() {
        return client;
    }
    
    void resize(const RECT& frame, const char* masksJson) override {
        if (browser) {
            // Get the CEF browser's window handle and update its position/size
            HWND browserHwnd = browser->GetHost()->GetWindowHandle();
            if (browserHwnd) {
                int width = frame.right - frame.left;
                int height = frame.bottom - frame.top;
                
                
                // Move and resize the CEF browser window, bringing it to front
                SetWindowPos(browserHwnd, HWND_TOP, frame.left, frame.top, width, height,
                           SWP_NOACTIVATE | SWP_SHOWWINDOW);
            }
            
            // Notify CEF that the browser was resized
            browser->GetHost()->WasResized();
            visualBounds = frame;
            
            bool maskChanged = false;
            if (masksJson) {
                std::string newMaskJSON = masksJson;
                if (newMaskJSON != maskJSON) {
                    maskJSON = newMaskJSON;
                    maskChanged = true;
                }
            } else if (!maskJSON.empty()) {
                maskJSON = "";
                maskChanged = true;
            }
            
            // Only apply visual mask if mask data changed
            if (maskChanged) {
                applyVisualMask();
            }
        }
    }
    
    // CEF-specific implementation of mask functionality
    void applyVisualMask() override {
        if (!browser) {
            return;
        }
        
        HWND browserHwnd = browser->GetHost()->GetWindowHandle();
        if (!browserHwnd) {
            return;
        }
        
        if (maskJSON.empty()) {
            // Remove any existing mask by setting full window region
            RECT windowRect;
            GetClientRect(browserHwnd, &windowRect);
            HRGN fullRegion = CreateRectRgn(0, 0, windowRect.right, windowRect.bottom);
            SetWindowRgn(browserHwnd, fullRegion, TRUE);
            return;
        }
        
        try {
            // Get the CEF browser window bounds
            RECT bounds = visualBounds;
            int width = bounds.right - bounds.left;
            int height = bounds.bottom - bounds.top;
            
            if (width <= 0 || height <= 0) {
                return;
            }
            
            // Create base region covering entire browser window
            HRGN browserRegion = CreateRectRgn(0, 0, width, height);
            
            // Parse maskJSON and subtract mask regions (holes)
            size_t pos = 0;
            int maskCount = 0;
            while ((pos = maskJSON.find("\"x\":", pos)) != std::string::npos) {
                try {
                    // Extract mask rectangle coordinates  
                    size_t xStart = maskJSON.find(":", pos) + 1;
                    size_t xEnd = maskJSON.find(",", xStart);
                    int x = std::stoi(maskJSON.substr(xStart, xEnd - xStart));
                    
                    size_t yPos = maskJSON.find("\"y\":", pos);
                    size_t yStart = maskJSON.find(":", yPos) + 1;
                    size_t yEnd = maskJSON.find(",", yStart);
                    int y = std::stoi(maskJSON.substr(yStart, yEnd - yStart));
                    
                    size_t wPos = maskJSON.find("\"width\":", pos);
                    size_t wStart = maskJSON.find(":", wPos) + 1;
                    size_t wEnd = maskJSON.find(",", wStart);
                    if (wEnd == std::string::npos) wEnd = maskJSON.find("}", wStart);
                    int maskWidth = std::stoi(maskJSON.substr(wStart, wEnd - wStart));
                    
                    size_t hPos = maskJSON.find("\"height\":", pos);
                    size_t hStart = maskJSON.find(":", hPos) + 1;
                    size_t hEnd = maskJSON.find("}", hStart);
                    int maskHeight = std::stoi(maskJSON.substr(hStart, hEnd - hStart));
                    
                    // Create hole region and subtract from browser region
                    HRGN holeRegion = CreateRectRgn(x, y, x + maskWidth, y + maskHeight);
                    if (holeRegion) {
                        CombineRgn(browserRegion, browserRegion, holeRegion, RGN_DIFF);
                        DeleteObject(holeRegion);
                        maskCount++;
                    }
                    
                    pos = hEnd;
                } catch (const std::exception& e) {
                    pos++;
                }
            }
            
            if (maskCount > 0) {
                // Apply the region with holes to the CEF browser window
                SetWindowRgn(browserHwnd, browserRegion, TRUE);
            } else {
                // No valid masks found, clean up
                DeleteObject(browserRegion);
            }
            
        } catch (const std::exception& e) {
            // Silent error handling
        }
    }
    
    void removeMasks() override {
        if (!browser) {
            return;
        }
        
        HWND browserHwnd = browser->GetHost()->GetWindowHandle();
        if (!browserHwnd) {
            return;
        }
        
        // Remove window region to restore full visibility
        SetWindowRgn(browserHwnd, NULL, TRUE);
    }
    
    void toggleMirrorMode(bool enable) override {
        if (enable && !mirrorModeEnabled) {
            mirrorModeEnabled = true;
            // CEF-specific input disabling
            if (browser) {
                HWND browserHwnd = browser->GetHost()->GetWindowHandle();
                if (browserHwnd) {
                    // Disable input by making the window non-interactive
                    EnableWindow(browserHwnd, FALSE);
                    // char logMsg[128];
                    // sprintf_s(logMsg, "CEF mirror mode: Disabled input for browser HWND=%p", browserHwnd);
                    // ::log(logMsg);
                }
            }
        } else if (!enable && mirrorModeEnabled) {
            mirrorModeEnabled = false;
            // CEF-specific input enabling
            if (browser) {
                HWND browserHwnd = browser->GetHost()->GetWindowHandle();
                if (browserHwnd) {
                    // Enable input by making the window interactive again
                    EnableWindow(browserHwnd, TRUE);
                    // char logMsg[128];
                    // sprintf_s(logMsg, "CEF mirror mode: Enabled input for browser HWND=%p", browserHwnd);
                    // ::log(logMsg);
                }
            }
        }
    }
    
    // Override transparency implementation for CEF
    // On Windows, transparency for CEF is implemented as hiding/showing since SetLayeredWindowAttributes often fails on child windows
    void setTransparent(bool transparent) override {
        if (!browser) {
            return;
        }
        
        HWND browserHwnd = browser->GetHost()->GetWindowHandle();
        if (!browserHwnd) {
            return;
        }
        
        if (transparent) {
            // For transparency, hide the window completely
            ShowWindow(browserHwnd, SW_HIDE);
        } else {
            // For opacity, show the window
            ShowWindow(browserHwnd, SW_SHOW);
        }
    }
    
    // Override passthrough implementation for CEF
    void setPassthrough(bool enable) override {
        AbstractView::setPassthrough(enable); // Call base implementation to set the flag
        
        if (!browser) {
            return;
        }
        
        HWND browserHwnd = browser->GetHost()->GetWindowHandle();
        if (!browserHwnd) {
            return;
        }
        
        LONG exStyle = GetWindowLong(browserHwnd, GWL_EXSTYLE);
        if (enable) {
            // Make the window transparent to mouse clicks
            SetWindowLong(browserHwnd, GWL_EXSTYLE, exStyle | WS_EX_TRANSPARENT);
        } else {
            // Remove mouse transparency
            SetWindowLong(browserHwnd, GWL_EXSTYLE, exStyle & ~WS_EX_TRANSPARENT);
        }
    }
    
    // Override hidden implementation for CEF
    // On Windows, setHidden is an alias for setTransparent since transparency provides the desired hide + passthrough behavior
    void setHidden(bool hidden) override {
        // Use the working transparency implementation which provides hide + passthrough behavior
        setTransparent(hidden);
        
        // Also handle the container window using base implementation
        AbstractView::setHidden(hidden);
    }
};

// Helper function to set browser on CEFView (defined after CEFView class)
void SetBrowserOnCEFView(HWND parentWindow, CefRefPtr<CefBrowser> browser) {
    auto viewIt = g_cefViews.find(parentWindow);
    if (viewIt != g_cefViews.end()) {
        auto view = static_cast<CEFView*>(viewIt->second);
        if (view) {
            view->setBrowser(browser);
            
            // Trigger an immediate resize to bring CEF browser to front
            // The resize method will handle the z-ordering
            RECT currentBounds = view->visualBounds;
            view->resize(currentBounds, nullptr);
        }
    }
}

// Helper function to set webview on WebView2View (defined after WebView2View class)
void SetWebViewOnWebView2View(HWND containerWindow, void* webview) {
    std::cout << "[WebView2] Looking for WebView2View with containerWindow: " << containerWindow << std::endl;
    auto viewIt = g_webview2Views.find(containerWindow);
    if (viewIt != g_webview2Views.end()) {
        auto view = static_cast<WebView2View*>(viewIt->second);
        if (view) {
            // WebView2 is already set in the controller creation callback
            std::cout << "[WebView2] Found WebView2View for webview ID: " << view->webviewId << std::endl;
        } else {
            std::cout << "[WebView2] Found WebView2View entry but view is null" << std::endl;
        }
    } else {
        std::cout << "[WebView2] No WebView2View found for containerWindow: " << containerWindow << std::endl;
    }
}

// ContainerView class definition
class ContainerView {
private:
    HWND m_hwnd;
    HWND m_parentWindow;
    std::vector<std::shared_ptr<AbstractView>> m_abstractViews;
    
    // Input management
    AbstractView* m_activeWebView = nullptr;  // Currently active webview for input
    
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
                // // Resize all full-size webviews when container resizes
                // int width = LOWORD(lParam);
                // int height = HIWORD(lParam);
                
                // for (auto& view : m_abstractViews) {
                //     if (view->fullSize) {
                //         // Resize the webview to match container
                //         if (view->controller) {
                //             RECT bounds = {0, 0, width, height};
                //             view->controller->put_Bounds(bounds);
                //         }
                //     }
                // }
                int width = LOWORD(lParam);
                int height = HIWORD(lParam);
                
                ResizeAutoSizingViews(width, height);
                
                break;
            }
            
            case WM_MOUSEMOVE: {
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
        AbstractView* newActiveView = nullptr;
        
        // Iterate through webviews in reverse order (top-most first)
        for (auto it = m_abstractViews.rbegin(); it != m_abstractViews.rend(); ++it) {
            auto& view = *it;
            
            if (view->isMousePassthroughEnabled) {
                // Skip passthrough webviews
                view->toggleMirrorMode(true);
                continue;
            }
            
            if (!newActiveView) {
                // Check if mouse is over this webview's bounds
                RECT viewBounds = view->visualBounds;
                
                // For WebView2, try to get actual bounds
                auto webview2 = std::dynamic_pointer_cast<WebView2View>(view);
                auto cefView = std::dynamic_pointer_cast<CEFView>(view);
                
                if (webview2 && webview2->getController()) {
                    webview2->getController()->get_Bounds(&viewBounds);
                } else if (cefView && cefView->getBrowser()) {
                    // For CEF, use the visualBounds which are set by resize
                    viewBounds = view->visualBounds;
                }
                
                if (PtInRect(&viewBounds, mousePos)) {
                    // Convert to local coordinates for mask checking
                    POINT localPoint = {
                        mousePos.x - viewBounds.left,
                        mousePos.y - viewBounds.top
                    };
                    
                    // Check if point is in a masked (cut-out) area
                    if (view->isPointInMask(localPoint)) {
                        // Point is in masked area, don't make this webview active
                        // Continue to check lower webviews
                        view->toggleMirrorMode(true);
                        continue;
                    }
                    
                    // Point is in unmasked area, make this webview active
                    newActiveView = view.get();
                    view->toggleMirrorMode(false);
                    continue;
                }
            }
            
            // All other webviews are non-interactive
            view->toggleMirrorMode(true);
        }
        
        // Update active webview for input routing
        m_activeWebView = newActiveView;
    }
    

    struct EnumChildData {
        RECT targetBounds;
        HWND containerHwnd;
    };
    
    static BOOL CALLBACK EnumChildCallback(HWND child, LPARAM lParam) {
        EnumChildData* data = (EnumChildData*)lParam;
        
        char className[256];
        GetClassNameA(child, className, sizeof(className));
        
        // Look for WebView2/Chrome child windows
        if (strstr(className, "Chrome_WidgetWin") || 
            strstr(className, "Chrome_RenderWidgetHostHWND")) {
            
            RECT childRect;
            GetWindowRect(child, &childRect);
            
            // Convert to container coordinates
            POINT topLeft = {childRect.left, childRect.top};
            POINT bottomRight = {childRect.right, childRect.bottom};
            ScreenToClient(data->containerHwnd, &topLeft);
            ScreenToClient(data->containerHwnd, &bottomRight);
            
            // Check if this matches our WebView's bounds (with some tolerance)
            if (abs(topLeft.x - data->targetBounds.left) < 5 && 
                abs(topLeft.y - data->targetBounds.top) < 5) {
                // This is likely our WebView's child window
                SetWindowPos(child, HWND_TOP, 0, 0, 0, 0,
                           SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                return FALSE; // Stop enumeration
            }
        }
        return TRUE; // Continue enumeration
    }
    
    void BringWebView2ChildWindowToFront(AbstractView* view) {
        // Cast to WebView2View to access controller
        auto webview2 = dynamic_cast<WebView2View*>(view);
        if (!webview2 || !webview2->getController()) return;
        
        // Get the bounds of this WebView to identify its child window
        RECT viewBounds;
        webview2->getController()->get_Bounds(&viewBounds);
        
        EnumChildData enumData;
        enumData.targetBounds = viewBounds;
        enumData.containerHwnd = m_hwnd;
        
        // Find and bring the WebView2's child window to front
        EnumChildWindows(m_hwnd, EnumChildCallback, (LPARAM)&enumData);
    }
    
    void BringCEFChildWindowToFront(AbstractView* view) {
        // Cast to CEFView to access browser
        auto cefView = dynamic_cast<CEFView*>(view);
        if (!cefView || !cefView->getBrowser()) return;
        
        CefRefPtr<CefBrowser> browser = cefView->getBrowser();
        if (!browser) return;
        
        // Get the CEF browser's window handle
        HWND browserHwnd = browser->GetHost()->GetWindowHandle();
        if (!browserHwnd) return;
        
        // char logMsg[256];
        // sprintf_s(logMsg, "BringCEFChildWindowToFront: Bringing CEF browser HWND=%p to front", browserHwnd);
        // ::log(logMsg);
        
        // Bring the CEF browser window to front
        SetWindowPos(browserHwnd, HWND_TOP, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

public:
    ContainerView(HWND parentWindow) : m_parentWindow(parentWindow), m_hwnd(NULL) {
        // Double-check parent window is valid
        if (!IsWindow(parentWindow)) {
            ::log("ERROR: Parent window handle is invalid in ContainerView constructor");
            return;
        }
        
        // Get parent window client area
        RECT clientRect;
        if (!GetClientRect(parentWindow, &clientRect)) {
            DWORD error = GetLastError();
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Failed to get parent window client rect, error: %lu", error);
            ::log(errorMsg);
            return;
        }
        
        // Validate that we have a reasonable client area
        int width = clientRect.right - clientRect.left;
        int height = clientRect.bottom - clientRect.top;
        
        if (width <= 0 || height <= 0) {
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Parent window has invalid client area: %dx%d", width, height);
            ::log(errorMsg);
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
                    ::log(errorMsg);
                    // Fall back to STATIC class
                    goto use_static_class;
                }
            }
            classRegistered = true;
        }
        
        // Try creating with our custom class first
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
            ::log("Custom class failed, falling back to STATIC class");
            
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
                ::log(errorMsg);
                return;
            } else {
            }
        } else {
        }
        
        if (m_hwnd) {
            // Verify the container window is valid
            if (!IsWindow(m_hwnd)) {
                ::log("ERROR: Container window creation returned handle but window is not valid");
                m_hwnd = NULL;
                return;
            }
            
            char successMsg[256];
        }
    }

    void ResizeAutoSizingViews(int width, int height) {
        for (auto& view : m_abstractViews) {
            if (view->fullSize) {
                // Resize the webview to match container
                RECT bounds = {0, 0, width, height};
                view->resize(bounds, nullptr);
                
                // char logMsg[256];
                // sprintf_s(logMsg, "Resized auto-sizing WebView %u to %dx%d", 
                //         view->webviewId, width, height);
                // ::log(logMsg);
            }
        }
    }

    void BringViewToFront(uint32_t webviewId) {
        auto it = std::find_if(m_abstractViews.begin(), m_abstractViews.end(),
            [webviewId](const std::shared_ptr<AbstractView>& view) {
                return view->webviewId == webviewId;
            });
        
        if (it != m_abstractViews.end()) {
            auto view = *it;
            // Move to front of vector (most recent first)
            m_abstractViews.erase(it);
            m_abstractViews.insert(m_abstractViews.begin(), view);
            
            // Bring the appropriate child window to front
            auto webview2 = dynamic_cast<WebView2View*>(view.get());
            auto cefView = dynamic_cast<CEFView*>(view.get());
            
            if (webview2) {
                BringWebView2ChildWindowToFront(view.get());
            } else if (cefView) {
                BringCEFChildWindowToFront(view.get());
            }
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
        BringViewToFront(view->webviewId);
        
        // TODO: Temporarily disable mirror mode for CEF testing
        // Start new webviews in mirror mode (input disabled)
        // They will be made interactive when mouse hovers over them
        // view->toggleMirrorMode(true);
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
        ::log("ERROR: Parent window handle is invalid");
        return nullptr;
    }
    
    auto it = g_containerViews.find(parentWindow);
    if (it == g_containerViews.end()) {
        
        auto container = std::make_unique<ContainerView>(parentWindow);
        ContainerView* containerPtr = container.get();
        
        // Only store if creation was successful
        if (containerPtr->GetHwnd() != NULL) {
            g_containerViews[parentWindow] = std::move(container);
            return containerPtr;
        } else {
            ::log("ERROR: Container creation failed, not storing");
            return nullptr;
        }
    }
    
    // log("Using existing container for window");
    return it->second.get();
}

// Stub classes for compatibility
class NSWindow {
public:
    void* contentView;
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


// Handle application menu item selection
void handleApplicationMenuSelection(UINT menuId) {
    auto it = g_menuItemActions.find(menuId);
    if (it != g_menuItemActions.end()) {
        const std::string& action = it->second;
        
        // char logMsg[256];
        // sprintf_s(logMsg, "Application menu action: %s", action.c_str());
        // ::log(logMsg);
        
        if (g_appMenuTarget && g_appMenuTarget->zigHandler) {
            if (action == "__quit__") {
                PostQuitMessage(0);
            } else if (action == "__undo__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, WM_UNDO, 0, 0);
                }
            } else if (action == "__cut__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, WM_CUT, 0, 0);
                }
            } else if (action == "__copy__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, WM_COPY, 0, 0);
                }
            } else if (action == "__paste__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, WM_PASTE, 0, 0);
                }
            } else if (action == "__selectAll__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, EM_SETSEL, 0, -1);
                }
            } else if (action == "__minimize__") {
                HWND activeWindow = GetActiveWindow();
                if (activeWindow) {
                    ShowWindow(activeWindow, SW_MINIMIZE);
                }
            } else if (action == "__close__") {
                HWND activeWindow = GetActiveWindow();
                if (activeWindow) {
                    PostMessage(activeWindow, WM_CLOSE, 0, 0);
                }
            } else {
                g_appMenuTarget->zigHandler(g_appMenuTarget->trayId, action.c_str());
            }
        }
    }
}


// Window procedure that will handle events and call your handlers
LRESULT CALLBACK WindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    // Get our custom data
    WindowData* data = (WindowData*)GetWindowLongPtr(hwnd, GWLP_USERDATA);
    
    switch (msg) {
        
        case WM_INPUT: {
            if (g_isMovingWindow && g_targetWindow) {
                UINT dwSize = 0;
                GetRawInputData((HRAWINPUT)lParam, RID_INPUT, NULL, &dwSize, sizeof(RAWINPUTHEADER));
                
                LPBYTE lpb = new BYTE[dwSize];
                if (GetRawInputData((HRAWINPUT)lParam, RID_INPUT, lpb, &dwSize, sizeof(RAWINPUTHEADER)) == dwSize) {
                    RAWINPUT* raw = (RAWINPUT*)lpb;
                    
                    if (raw->header.dwType == RIM_TYPEMOUSE) {
                        // Check for mouse button release
                        if (raw->data.mouse.usButtonFlags & RI_MOUSE_LEFT_BUTTON_UP) {
                            // Stop window move
                            RAWINPUTDEVICE rid;
                            rid.usUsagePage = 0x01;
                            rid.usUsage = 0x02;
                            rid.dwFlags = RIDEV_REMOVE;
                            rid.hwndTarget = NULL;
                            
                            RegisterRawInputDevices(&rid, 1, sizeof(RAWINPUTDEVICE));
                            g_isMovingWindow = FALSE;
                            g_targetWindow = NULL;
                        }
                        
                        // Handle mouse movement using cursor position tracking
                        else if (raw->data.mouse.lLastX != 0 || raw->data.mouse.lLastY != 0) {
                            POINT currentCursor;
                            GetCursorPos(&currentCursor);
                            
                            // Calculate delta from initial cursor position when drag started
                            int deltaX = currentCursor.x - g_initialCursorPos.x;
                            int deltaY = currentCursor.y - g_initialCursorPos.y;
                            
                            // Calculate new window position
                            int newX = g_initialWindowPos.x + deltaX;
                            int newY = g_initialWindowPos.y + deltaY;
                            
                            SetWindowPos(g_targetWindow, NULL, newX, newY, 0, 0, 
                                       SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                        }
                    }
                }
                delete[] lpb;
            }
            break;
        }
        case WM_COMMAND:
            // Check if this is an application menu command
            if (HIWORD(wParam) == 0) { // Menu item selected
                UINT menuId = LOWORD(wParam);
                handleApplicationMenuSelection(menuId);
                return 0;
            }
            break;
            
        case WM_CLOSE:
            if (data && data->closeHandler) {
                data->closeHandler(data->windowId);
            }
            break;
            
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
                    int width = clientRect.right - clientRect.left;
                    int height = clientRect.bottom - clientRect.top;
                    
                    // Resize the container window itself
                    SetWindowPos(containerIt->second->GetHwnd(), NULL, 
                        0, 0, width, height,
                        SWP_NOZORDER | SWP_NOACTIVATE);
                    
                    // Resize all auto-resizing webviews in this container
                    containerIt->second->ResizeAutoSizingViews(width, height);
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
                ::log("Timer fired - forcing window refresh");
                InvalidateRect(hwnd, NULL, TRUE);
                UpdateWindow(hwnd);
            }
            return 0;
            
        case WM_DESTROY:
            // Clean up application menu when main window is destroyed
            if (g_applicationMenu) {
                DestroyMenu(g_applicationMenu);
                g_applicationMenu = NULL;
            }
            g_appMenuTarget.reset();
            
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
        case WM_EXECUTE_ASYNC_BLOCK:
            MainThreadDispatcher::handleSyncTask(lParam);
            return 0;
        default:
            return DefWindowProc(hwnd, msg, wParam, lParam);
    }
}


class NSStatusItem {
public:
    NOTIFYICONDATA nid;
    HWND hwnd;
    uint32_t trayId;
    ZigStatusItemHandler handler;
    HMENU contextMenu;
    std::string title;
    std::string imagePath;
    
    NSStatusItem() {
        memset(&nid, 0, sizeof(NOTIFYICONDATA));
        hwnd = NULL;
        trayId = 0;
        handler = nullptr;
        contextMenu = NULL;
    }
    
    ~NSStatusItem() {
        if (contextMenu) {
            DestroyMenu(contextMenu);
        }
        // Remove from system tray
        Shell_NotifyIcon(NIM_DELETE, &nid);
    }
};

// Global map to store tray items by their window handle
static std::map<HWND, NSStatusItem*> g_trayItems;
static UINT g_trayMessageId = WM_USER + 100;

struct SimpleJsonValue {
    enum Type { STRING, BOOL, ARRAY, OBJECT, UNKNOWN };
    Type type = UNKNOWN;
    std::string stringValue;
    bool boolValue = false;
    std::vector<SimpleJsonValue> arrayValue;
    std::map<std::string, SimpleJsonValue> objectValue;
};

// Simple JSON parsing functions
std::string trimWhitespace(const std::string& str) {
    size_t start = str.find_first_not_of(" \t\n\r");
    if (start == std::string::npos) return "";
    size_t end = str.find_last_not_of(" \t\n\r");
    return str.substr(start, end - start + 1);
}

std::string extractQuotedString(const std::string& json, size_t& pos) {
    if (pos >= json.length() || json[pos] != '"') return "";
    pos++; // Skip opening quote
    
    std::string result;
    while (pos < json.length() && json[pos] != '"') {
        if (json[pos] == '\\' && pos + 1 < json.length()) {
            pos++; // Skip escape character
            switch (json[pos]) {
                case 'n': result += '\n'; break;
                case 't': result += '\t'; break;
                case 'r': result += '\r'; break;
                case '\\': result += '\\'; break;
                case '"': result += '"'; break;
                default: result += json[pos]; break;
            }
        } else {
            result += json[pos];
        }
        pos++;
    }
    
    if (pos < json.length() && json[pos] == '"') {
        pos++; // Skip closing quote
    }
    
    return result;
}

SimpleJsonValue parseJsonValue(const std::string& json, size_t& pos);

SimpleJsonValue parseJsonObject(const std::string& json, size_t& pos) {
    SimpleJsonValue obj;
    obj.type = SimpleJsonValue::OBJECT;
    
    if (pos >= json.length() || json[pos] != '{') return obj;
    pos++; // Skip '{'
    
    while (pos < json.length()) {
        // Skip whitespace
        while (pos < json.length() && isspace(json[pos])) pos++;
        
        if (pos >= json.length()) break;
        if (json[pos] == '}') {
            pos++; // Skip '}'
            break;
        }
        
        // Parse key
        std::string key = extractQuotedString(json, pos);
        
        // Skip whitespace and ':'
        while (pos < json.length() && (isspace(json[pos]) || json[pos] == ':')) pos++;
        
        // Parse value
        SimpleJsonValue value = parseJsonValue(json, pos);
        obj.objectValue[key] = value;
        
        // Skip whitespace and optional ','
        while (pos < json.length() && (isspace(json[pos]) || json[pos] == ',')) pos++;
    }
    
    return obj;
}

SimpleJsonValue parseJsonArray(const std::string& json, size_t& pos) {
    SimpleJsonValue arr;
    arr.type = SimpleJsonValue::ARRAY;
    
    if (pos >= json.length() || json[pos] != '[') return arr;
    pos++; // Skip '['
    
    while (pos < json.length()) {
        // Skip whitespace
        while (pos < json.length() && isspace(json[pos])) pos++;
        
        if (pos >= json.length()) break;
        if (json[pos] == ']') {
            pos++; // Skip ']'
            break;
        }
        
        // Parse value
        SimpleJsonValue value = parseJsonValue(json, pos);
        arr.arrayValue.push_back(value);
        
        // Skip whitespace and optional ','
        while (pos < json.length() && (isspace(json[pos]) || json[pos] == ',')) pos++;
    }
    
    return arr;
}

SimpleJsonValue parseJsonValue(const std::string& json, size_t& pos) {
    SimpleJsonValue value;
    
    // Skip whitespace
    while (pos < json.length() && isspace(json[pos])) pos++;
    
    if (pos >= json.length()) return value;
    
    if (json[pos] == '"') {
        // String value
        value.type = SimpleJsonValue::STRING;
        value.stringValue = extractQuotedString(json, pos);
    } else if (json[pos] == '{') {
        // Object value
        value = parseJsonObject(json, pos);
    } else if (json[pos] == '[') {
        // Array value
        value = parseJsonArray(json, pos);
    } else if (json.substr(pos, 4) == "true") {
        // Boolean true
        value.type = SimpleJsonValue::BOOL;
        value.boolValue = true;
        pos += 4;
    } else if (json.substr(pos, 5) == "false") {
        // Boolean false
        value.type = SimpleJsonValue::BOOL;
        value.boolValue = false;
        pos += 5;
    } else {
        // Skip unknown values
        while (pos < json.length() && json[pos] != ',' && json[pos] != '}' && json[pos] != ']') pos++;
    }
    
    return value;
}

SimpleJsonValue parseJson(const std::string& json) {
    size_t pos = 0;
    return parseJsonValue(json, pos);
}



// Function to create Windows menu from JSON config (equivalent to createMenuFromConfig)
HMENU createMenuFromConfig(const SimpleJsonValue& menuConfig, NSStatusItem* statusItem) {
    HMENU menu = CreatePopupMenu();
    if (!menu) {
        ::log("ERROR: Failed to create popup menu");
        return NULL;
    }
    
    if (menuConfig.type != SimpleJsonValue::ARRAY) {
        ::log("ERROR: Menu config is not an array");
        return menu;
    }
    
    for (const auto& itemValue : menuConfig.arrayValue) {
        if (itemValue.type != SimpleJsonValue::OBJECT) continue;
        
        const auto& itemData = itemValue.objectValue;
        
        // Helper lambda to get string value
        auto getString = [&](const std::string& key, const std::string& defaultVal = "") -> std::string {
            auto it = itemData.find(key);
            if (it != itemData.end() && it->second.type == SimpleJsonValue::STRING) {
                return it->second.stringValue;
            }
            return defaultVal;
        };
        
        // Helper lambda to get bool value
        auto getBool = [&](const std::string& key, bool defaultVal = false) -> bool {
            auto it = itemData.find(key);
            if (it != itemData.end() && it->second.type == SimpleJsonValue::BOOL) {
                return it->second.boolValue;
            }
            return defaultVal;
        };
        
        std::string type = getString("type");
        std::string label = getString("label");
        std::string action = getString("action");
        std::string role = getString("role");
        std::string accelerator = getString("accelerator");
        
        bool enabled = getBool("enabled", true);
        bool checked = getBool("checked", false);
        bool hidden = getBool("hidden", false);
        std::string tooltip = getString("tooltip");
        
        if (hidden) {
            continue;
        } else if (type == "divider") {
            AppendMenuA(menu, MF_SEPARATOR, 0, NULL);
        } else {
            UINT flags = MF_STRING;
            if (!enabled) flags |= MF_GRAYED;
            
            UINT menuId = g_nextMenuId++;
            
            // Store the action for this menu ID
            if (!action.empty()) {
                g_menuItemActions[menuId] = action;
            }
            
            // Handle system roles (similar to macOS implementation)
            if (!role.empty()) {
                if (role == "quit") {
                    // For quit, we'll handle it specially in the menu callback
                    g_menuItemActions[menuId] = "__quit__";
                }
                // TODO: fill in other roles
            }
            
            // Append the menu item
            AppendMenuA(menu, flags, menuId, label.c_str());

            if (checked) {
                CheckMenuItem(menu, menuId, MF_BYCOMMAND | MF_CHECKED);
            }
            
            // Handle submenus
            auto submenuIt = itemData.find("submenu");
            if (submenuIt != itemData.end() && submenuIt->second.type == SimpleJsonValue::ARRAY) {
                HMENU submenu = createMenuFromConfig(submenuIt->second, statusItem);
                if (submenu) {
                    ModifyMenuA(menu, menuId, MF_BYCOMMAND | MF_POPUP, (UINT_PTR)submenu, label.c_str());
                }
            }
        }
    }
    
    return menu;
}

// Function to handle menu item selection
void handleMenuItemSelection(UINT menuId, NSStatusItem* statusItem) {
    auto it = g_menuItemActions.find(menuId);
    if (it != g_menuItemActions.end()) {
        const std::string& action = it->second;
        
        if (statusItem && statusItem->handler) {
            if (action == "__quit__") {
                // Handle quit specially
                PostQuitMessage(0);
            } else {
                statusItem->handler(statusItem->trayId, action.c_str());
            }
        }
    }
}



// Function to set accelerator keys for menu items
void setMenuItemAccelerator(HMENU menu, UINT menuId, const std::string& accelerator, UINT modifierMask = 0) {
    if (accelerator.empty()) return;
    
    UINT key = 0;
    UINT modifiers = 0;
    
    // Parse simple accelerators like "Ctrl+C", "Ctrl+V", etc.
    if (accelerator.length() == 1) {
        key = VkKeyScan(accelerator[0]) & 0xFF;
        modifiers = FCONTROL;
    } else if (accelerator.find("Ctrl+") == 0 && accelerator.length() == 6) {
        char keyChar = accelerator[5];
        key = VkKeyScan(keyChar) & 0xFF;
        modifiers = FCONTROL;
    } else if (accelerator.find("Alt+") == 0 && accelerator.length() == 5) {
        char keyChar = accelerator[4];
        key = VkKeyScan(keyChar) & 0xFF;
        modifiers = FALT;
    } else if (accelerator.find("Shift+") == 0 && accelerator.length() == 7) {
        char keyChar = accelerator[6];
        key = VkKeyScan(keyChar) & 0xFF;
        modifiers = FSHIFT;
    }
    
    if (modifierMask > 0) {
        modifiers = 0;
        if (modifierMask & 1) modifiers |= FCONTROL;
        if (modifierMask & 2) modifiers |= FSHIFT;
        if (modifierMask & 4) modifiers |= FALT;
    }
    
    if (key > 0) {
        // char logMsg[256];
        // sprintf_s(logMsg, "Setting accelerator for menu item %u: key=%u, modifiers=%u", menuId, key, modifiers);
        // ::log(logMsg);
    }
}

// Enhanced createMenuFromConfig for application menu
HMENU createApplicationMenuFromConfig(const SimpleJsonValue& menuConfig, StatusItemTarget* target) {
    HMENU menuBar = CreateMenu();
    if (!menuBar) {
        ::log("ERROR: Failed to create menu bar");
        return NULL;
    }
    
    if (menuConfig.type != SimpleJsonValue::ARRAY) {
        ::log("ERROR: Application menu config is not an array");
        DestroyMenu(menuBar);
        return NULL;
    }
    
    for (const auto& topLevelItem : menuConfig.arrayValue) {
        if (topLevelItem.type != SimpleJsonValue::OBJECT) continue;
        
        const auto& itemData = topLevelItem.objectValue;
        
        // Helper lambda to get string value
        auto getString = [&](const std::string& key, const std::string& defaultVal = "") -> std::string {
            auto it = itemData.find(key);
            if (it != itemData.end() && it->second.type == SimpleJsonValue::STRING) {
                return it->second.stringValue;
            }
            return defaultVal;
        };
        
        // Helper lambda to get bool value
        auto getBool = [&](const std::string& key, bool defaultVal = false) -> bool {
            auto it = itemData.find(key);
            if (it != itemData.end() && it->second.type == SimpleJsonValue::BOOL) {
                return it->second.boolValue;
            }
            return defaultVal;
        };
        
        std::string label = getString("label");
        bool hidden = getBool("hidden", false);
        
        if (hidden) continue;
        
        // Check if this has a submenu
        auto submenuIt = itemData.find("submenu");
        if (submenuIt != itemData.end() && submenuIt->second.type == SimpleJsonValue::ARRAY) {
            HMENU popupMenu = CreatePopupMenu();
            if (!popupMenu) continue;
            
            // Process submenu items
            for (const auto& subItemValue : submenuIt->second.arrayValue) {
                if (subItemValue.type != SimpleJsonValue::OBJECT) continue;
                
                const auto& subItemData = subItemValue.objectValue;
                
                // Helper lambdas for subitem data
                auto getSubString = [&](const std::string& key, const std::string& defaultVal = "") -> std::string {
                    auto it = subItemData.find(key);
                    if (it != subItemData.end() && it->second.type == SimpleJsonValue::STRING) {
                        return it->second.stringValue;
                    }
                    return defaultVal;
                };
                
                auto getSubBool = [&](const std::string& key, bool defaultVal = false) -> bool {
                    auto it = subItemData.find(key);
                    if (it != subItemData.end() && it->second.type == SimpleJsonValue::BOOL) {
                        return it->second.boolValue;
                    }
                    return defaultVal;
                };
                
                std::string subType = getSubString("type");
                std::string subLabel = getSubString("label");
                std::string subAction = getSubString("action");
                std::string subRole = getSubString("role");
                std::string subAccelerator = getSubString("accelerator");
                
                bool subEnabled = getSubBool("enabled", true);
                bool subChecked = getSubBool("checked", false);
                bool subHidden = getSubBool("hidden", false);
                
                if (subHidden) {
                    continue;
                } else if (subType == "divider") {
                    AppendMenuA(popupMenu, MF_SEPARATOR, 0, NULL);
                } else {
                    UINT flags = MF_STRING;
                    if (!subEnabled) flags |= MF_GRAYED;
                    
                    UINT menuId = g_nextMenuId++;
                    
                    // Store the action for this menu ID
                    if (!subAction.empty()) {
                        g_menuItemActions[menuId] = subAction;
                    }
                    
                    // Handle system roles
                    if (!subRole.empty()) {
                        if (subRole == "quit") {
                            g_menuItemActions[menuId] = "__quit__";
                        } else if (subRole == "undo") {
                            g_menuItemActions[menuId] = "__undo__";
                        } else if (subRole == "redo") {
                            g_menuItemActions[menuId] = "__redo__";
                        } else if (subRole == "cut") {
                            g_menuItemActions[menuId] = "__cut__";
                        } else if (subRole == "copy") {
                            g_menuItemActions[menuId] = "__copy__";
                        } else if (subRole == "paste") {
                            g_menuItemActions[menuId] = "__paste__";
                        } else if (subRole == "selectAll") {
                            g_menuItemActions[menuId] = "__selectAll__";
                        } else if (subRole == "minimize") {
                            g_menuItemActions[menuId] = "__minimize__";
                        } else if (subRole == "close") {
                            g_menuItemActions[menuId] = "__close__";
                        }
                        
                        // Set default accelerators for common roles if not specified
                        if (subAccelerator.empty()) {
                            if (subRole == "undo") {
                                subAccelerator = "z";
                            } else if (subRole == "redo") {
                                subAccelerator = "y";
                            } else if (subRole == "cut") {
                                subAccelerator = "x";
                            } else if (subRole == "copy") {
                                subAccelerator = "c";
                            } else if (subRole == "paste") {
                                subAccelerator = "v";
                            } else if (subRole == "selectAll") {
                                subAccelerator = "a";
                            }
                        }
                    }
                    
                    // Append the menu item
                    AppendMenuA(popupMenu, flags, menuId, subLabel.c_str());
                    
                    if (subChecked) {
                        CheckMenuItem(popupMenu, menuId, MF_BYCOMMAND | MF_CHECKED);
                    }
                    
                    // Set accelerator if specified
                    if (!subAccelerator.empty()) {
                        setMenuItemAccelerator(popupMenu, menuId, subAccelerator, 1); // Default to Ctrl
                    }
                    
                    // Handle nested submenus
                    auto nestedSubmenuIt = subItemData.find("submenu");
                    if (nestedSubmenuIt != subItemData.end() && nestedSubmenuIt->second.type == SimpleJsonValue::ARRAY) {
                        HMENU nestedSubmenu = createMenuFromConfig(nestedSubmenuIt->second, reinterpret_cast<NSStatusItem*>(target));
                        if (nestedSubmenu) {
                            ModifyMenuA(popupMenu, menuId, MF_BYCOMMAND | MF_POPUP, (UINT_PTR)nestedSubmenu, subLabel.c_str());
                        }
                    }
                }
            }
            
            // Add the popup menu to the menu bar
            AppendMenuA(menuBar, MF_POPUP, (UINT_PTR)popupMenu, label.c_str());
        } else {
            // Top-level item without submenu
            UINT menuId = g_nextMenuId++;
            std::string action = getString("action");
            
            if (!action.empty()) {
                g_menuItemActions[menuId] = action;
            }
            
            UINT flags = MF_STRING;
            if (!getBool("enabled", true)) flags |= MF_GRAYED;
            
            AppendMenuA(menuBar, flags, menuId, label.c_str());
        }
    }
    
    return menuBar;
}


















// Helper function to terminate all CEF helper processes
void TerminateCEFHelperProcesses() {
    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnapshot == INVALID_HANDLE_VALUE) {
        return;
    }
    
    PROCESSENTRY32W pe32;
    pe32.dwSize = sizeof(PROCESSENTRY32W);
    
    if (Process32FirstW(hSnapshot, &pe32)) {
        do {
            // Check if this is a "bun Helper.exe" process
            if (wcsstr(pe32.szExeFile, L"bun Helper.exe") != nullptr) {
                HANDLE hProcess = OpenProcess(PROCESS_TERMINATE, FALSE, pe32.th32ProcessID);
                if (hProcess != nullptr) {
                    std::wcout << L"[CEF] Terminating helper process: " << pe32.szExeFile 
                              << L" (PID: " << pe32.th32ProcessID << L")" << std::endl;
                    TerminateProcess(hProcess, 0);
                    CloseHandle(hProcess);
                }
            }
        } while (Process32NextW(hSnapshot, &pe32));
    }
    
    CloseHandle(hSnapshot);
}

ELECTROBUN_EXPORT bool initCEF() {
    if (g_cef_initialized) {
        return true; // Already initialized
    }
    
    // Create a job object to track all child processes
    if (!g_job_object) {
        g_job_object = CreateJobObject(nullptr, nullptr);
        if (g_job_object) {
            // Configure the job object to terminate all child processes when the main process exits
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = {0};
            jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(g_job_object, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
            
            // Assign the current process to the job object
            // This ensures all child processes (CEF helpers) are part of this job
            AssignProcessToJobObject(g_job_object, GetCurrentProcess());
            std::cout << "[CEF] Created job object for process tracking" << std::endl;
        }
    }

    // Get the directory where the current executable is located
    char exePath[MAX_PATH];
    GetModuleFileNameA(NULL, exePath, MAX_PATH);
    char* lastSlash = strrchr(exePath, '\\');
    if (lastSlash) {
        *lastSlash = '\0'; // Remove the executable name
    }

    // Set up CEF paths (resources are in ./cef relative to executable)
    std::string cefResourceDir = std::string(exePath) + "\\cef";
    std::string userDataDir = std::string(exePath) + "\\cef_cache";

    // Create cache directory if it doesn't exist
    CreateDirectoryA(userDataDir.c_str(), NULL);

    // Initialize CEF
    CefMainArgs main_args(GetModuleHandle(NULL));
    
    // Create the app
    g_cef_app = new ElectrobunCefApp();

    // CEF settings
    CefSettings settings;
    settings.no_sandbox = true;
    settings.multi_threaded_message_loop = false; // Use single-threaded message loop
    
    // Set the subprocess path to the helper executable
    CefString(&settings.browser_subprocess_path) = std::string(exePath) + "\\bun Helper.exe";
    
    // Set paths - icudtl.dat and .pak files are in cef directory root
    CefString(&settings.resources_dir_path) = cefResourceDir;
    CefString(&settings.locales_dir_path) = cefResourceDir + "\\Resources\\locales";
    CefString(&settings.cache_path) = userDataDir;
    
    // Add language settings like macOS
    CefString(&settings.accept_language_list) = "en-US,en";
    
    // Set minimal logging
    settings.log_severity = LOGSEVERITY_ERROR;
    CefString(&settings.log_file) = "";
    
    
    bool success = CefInitialize(main_args, settings, g_cef_app.get(), nullptr);
    if (success) {
        g_cef_initialized = true;
        // Register the views:// scheme handler factory
        CefRegisterSchemeHandlerFactory("views", "", new ElectrobunSchemeHandlerFactory());
        
        // We'll start the message pump timer when we create the first browser
    } else {
        ::log("Failed to initialize CEF");
    }
    
    return success;
}

// Internal factory method for creating WebView2 instances
static std::shared_ptr<WebView2View> createWebView2View(uint32_t webviewId,
                                                 HWND hwnd,
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
    // Check if WebView2 runtime is available
    LPWSTR versionInfo = nullptr;
    HRESULT result = GetAvailableCoreWebView2BrowserVersionString(nullptr, &versionInfo);
    if (FAILED(result)) {
        ::log("ERROR: WebView2 runtime is not available. Please install Microsoft Edge WebView2 Runtime");
        auto view = std::make_shared<WebView2View>(webviewId, bunBridgeHandler, internalBridgeHandler);
        view->setCreationFailed(true);
        return view;
    }
    if (versionInfo) {
        CoTaskMemFree(versionInfo);
    }
    
    
    // Make safe copies of string parameters to avoid memory corruption in lambda captures
    std::string urlString = url ? std::string(url) : "";
    std::string electrobunScript = electrobunPreloadScript ? std::string(electrobunPreloadScript) : "";
    std::string customScript = customPreloadScript ? std::string(customPreloadScript) : "";
    
    auto view = std::make_shared<WebView2View>(webviewId, bunBridgeHandler, internalBridgeHandler);
    view->hwnd = hwnd;
    view->fullSize = autoResize;
    
    // Store URL and scripts in view to survive async callbacks
    view->pendingUrl = urlString;
    view->electrobunScript = electrobunScript;
    view->customScript = customScript;
    
    // Create WebView2 on main thread  
    MainThreadDispatcher::dispatch_sync([view, urlString, x, y, width, height, hwnd]() {
        // Initialize COM for this thread
        HRESULT comResult = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
        if (FAILED(comResult) && comResult != RPC_E_CHANGED_MODE) {
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Failed to initialize COM, HRESULT: 0x%08X", comResult);
            ::log(errorMsg);
            return;
        }
        
        // Get or create container
        auto container = GetOrCreateContainer(hwnd);
        if (!container) {
            ::log("ERROR: Failed to create container");
            return;
        }
        
        HWND containerHwnd = container->GetHwnd();
        // char debugMsg[256];
        // sprintf_s(debugMsg, "[WebView2] Creating controller for container HWND: %p, parent HWND: %p", containerHwnd, hwnd);
        // ::log(debugMsg);
        
        // Verify the container window is valid
        if (!IsWindow(containerHwnd)) {
            ::log("ERROR: Container window handle is invalid");
            return;
        }
        
        // Get window info for debugging
        RECT windowRect;
        GetWindowRect(containerHwnd, &windowRect);
        DWORD windowStyle = GetWindowLong(containerHwnd, GWL_STYLE);
        // char windowDebug[512];
        // sprintf_s(windowDebug, "[WebView2] Container window - Rect: (%d,%d,%d,%d), Style: 0x%08X", 
        //          windowRect.left, windowRect.top, windowRect.right, windowRect.bottom, windowStyle);
        // ::log(windowDebug);
        
        // Make sure the window is visible (WebView2 requirement)
        ShowWindow(containerHwnd, SW_SHOW);
        UpdateWindow(containerHwnd);
        
        // Create WebView2 environment
        // Store values to avoid complex object captures in lambda
        uint32_t webviewId = view->webviewId;
        HWND parentHwnd = hwnd;
        
        auto environmentCompletedHandler = Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [view, container, x, y, width, height](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                if (FAILED(result)) {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "ERROR: Failed to create WebView2 environment, HRESULT: 0x%08X", result);
                    ::log(errorMsg);
                    view->setCreationFailed(true);
                    return result;
                }
                
                // Create WebView2 controller - MINIMAL VERSION
                HWND targetHwnd = container->GetHwnd();
                
                if (!IsWindow(targetHwnd)) {
                    ::log("ERROR: Target window is no longer valid");
                    view->setCreationFailed(true);
                    return S_OK;
                }
                
                return env->CreateCoreWebView2Controller(targetHwnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [view, container, x, y, width, height, env](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                            if (FAILED(result)) {
                                char errorMsg[256];
                                sprintf_s(errorMsg, "ERROR: Failed to create WebView2 controller, HRESULT: 0x%08X", result);
                                ::log(errorMsg);
                                view->setCreationFailed(true);
                                return result;
                            }
                            
                            
                            // Controller setup with composition fallback
                            ComPtr<ICoreWebView2Controller> ctrl(controller);
                            ComPtr<ICoreWebView2> webview;
                            ctrl->get_CoreWebView2(&webview);
                            
                            view->setController(ctrl);
                            view->setWebView(webview);
                            
                            // Try to get composition controller interface if available
                            ComPtr<ICoreWebView2CompositionController> compCtrl;
                            HRESULT compResult = ctrl->QueryInterface(IID_PPV_ARGS(&compCtrl));
                            if (SUCCEEDED(compResult) && compCtrl) {
                                view->setCompositionController(compCtrl);
                                // ::log("[WebView2] Composition controller interface available");
                            } else {
                            }
                            
                            // Set up JavaScript bridge objects
                            view->setupJavaScriptBridges();
                            
                            // Set bounds and visibility
                            RECT bounds = {(LONG)x, (LONG)y, (LONG)(x + width), (LONG)(y + height)};
                            ctrl->put_Bounds(bounds);
                            
                            // Make sure the controller is visible
                            ctrl->put_IsVisible(TRUE);
                            
                            // Add views:// scheme support - TEST ADDITION
                            webview->AddWebResourceRequestedFilter(L"views://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
                            
                            // Set up WebResourceRequested event handler for views:// scheme
                            webview->add_WebResourceRequested(
                                Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                                    [env](ICoreWebView2* sender, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                                        // ::log("[WebView2] WebResourceRequested event triggered");
                                        ComPtr<ICoreWebView2WebResourceRequest> request;
                                        args->get_Request(&request);
                                        
                                        LPWSTR uri;
                                        request->get_Uri(&uri);
                                        
                                        // Safe string conversion
                                        std::string uriStr;
                                        int size = WideCharToMultiByte(CP_UTF8, 0, uri, -1, nullptr, 0, nullptr, nullptr);
                                        if (size > 0) {
                                            uriStr.resize(size - 1);
                                            WideCharToMultiByte(CP_UTF8, 0, uri, -1, &uriStr[0], size, nullptr, nullptr);
                                        }
                                        
                                        // ::log("[WebView2] Request URI converted successfully");
                                        
                                        if (uriStr.substr(0, 8) == "views://") {
                                            std::string filePath = uriStr.substr(8);
                                            std::string content = loadViewsFile(filePath);
                                            
                                            if (!content.empty()) {
                                                // ::log("[WebView2] Loaded views file content, creating response");
                                                
                                                // Create response (simplified)
                                                std::string mimeType = "text/html";
                                                if (filePath.find(".js") != std::string::npos) mimeType = "application/javascript";
                                                else if (filePath.find(".css") != std::string::npos) mimeType = "text/css";
                                                else if (filePath.find(".png") != std::string::npos) mimeType = "image/png";
                                                
                                                std::wstring wMimeType(mimeType.begin(), mimeType.end());
                                                
                                                // Create memory stream
                                                ComPtr<IStream> contentStream;
                                                HGLOBAL hGlobal = GlobalAlloc(GMEM_MOVEABLE, content.size());
                                                if (hGlobal) {
                                                    void* pData = GlobalLock(hGlobal);
                                                    memcpy(pData, content.c_str(), content.size());
                                                    GlobalUnlock(hGlobal);
                                                    CreateStreamOnHGlobal(hGlobal, TRUE, &contentStream);
                                                }
                                                
                                                std::wstring headers = L"Content-Type: " + wMimeType + L"\r\nAccess-Control-Allow-Origin: *";
                                                
                                                ComPtr<ICoreWebView2WebResourceResponse> response;
                                                env->CreateWebResourceResponse(
                                                    contentStream.Get(),
                                                    200,
                                                    L"OK",
                                                    headers.c_str(),
                                                    &response);
                                                
                                                args->put_Response(response.Get());
                                                // ::log("[WebView2] Successfully served views:// file");
                                            }
                                        }
                                        
                                        CoTaskMemFree(uri);
                                        return S_OK;
                                    }).Get(),
                                nullptr);
                            
                            
                            // Add preload scripts - TEST ADDITION
                            std::string combinedScript;
                            if (!view->electrobunScript.empty()) {
                                combinedScript += view->electrobunScript;
                            }
                            if (!view->customScript.empty()) {
                                if (!combinedScript.empty()) {
                                    combinedScript += "\n";
                                }
                                combinedScript += view->customScript;
                            }
                            
                            if (!combinedScript.empty()) {
                                std::wstring wScript(combinedScript.begin(), combinedScript.end());
                                
                                webview->AddScriptToExecuteOnDocumentCreated(wScript.c_str(), nullptr);
                                
                                webview->add_NavigationStarting(
                                    Callback<ICoreWebView2NavigationStartingEventHandler>(
                                        [combinedScript](ICoreWebView2* sender, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                                            std::wstring wScript(combinedScript.begin(), combinedScript.end());
                                            sender->ExecuteScript(wScript.c_str(), nullptr);
                                            return S_OK;
                                        }).Get(),
                                    nullptr);
                                
                                // Add permission request handler
                                webview->add_PermissionRequested(
                                    Callback<ICoreWebView2PermissionRequestedEventHandler>(
                                        [](ICoreWebView2* sender, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                                            COREWEBVIEW2_PERMISSION_KIND kind;
                                            args->get_PermissionKind(&kind);
                                            
                                            wchar_t* uriWStr = nullptr;
                                            args->get_Uri(&uriWStr);
                                            
                                            std::string uri;
                                            if (uriWStr) {
                                                int size = WideCharToMultiByte(CP_UTF8, 0, uriWStr, -1, nullptr, 0, nullptr, nullptr);
                                                if (size > 0) {
                                                    uri.resize(size - 1);
                                                    WideCharToMultiByte(CP_UTF8, 0, uriWStr, -1, &uri[0], size, nullptr, nullptr);
                                                }
                                                CoTaskMemFree(uriWStr);
                                            }
                                            
                                            std::string origin = getOriginFromUrl(uri);
                                            PermissionType permType = PermissionType::OTHER;
                                            std::string permissionName = "Permission";
                                            
                                            // Determine permission type
                                            switch (kind) {
                                                case COREWEBVIEW2_PERMISSION_KIND_CAMERA:
                                                case COREWEBVIEW2_PERMISSION_KIND_MICROPHONE:
                                                    permType = PermissionType::USER_MEDIA;
                                                    permissionName = "Camera & Microphone Access";
                                                    break;
                                                case COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION:
                                                    permType = PermissionType::GEOLOCATION;
                                                    permissionName = "Location Access";
                                                    break;
                                                case COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS:
                                                    permType = PermissionType::NOTIFICATIONS;
                                                    permissionName = "Notification Permission";
                                                    break;
                                                default:
                                                    permType = PermissionType::OTHER;
                                                    permissionName = "Permission Request";
                                                    break;
                                            }
                                            
                                            printf("WebView2: %s requested for %s\n", permissionName.c_str(), origin.c_str());
                                            
                                            // Check cache first
                                            PermissionStatus cachedStatus = getPermissionFromCache(origin, permType);
                                            
                                            if (cachedStatus == PermissionStatus::ALLOWED) {
                                                printf("WebView2: Using cached permission: User previously allowed %s for %s\n", permissionName.c_str(), origin.c_str());
                                                args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                                                return S_OK;
                                            } else if (cachedStatus == PermissionStatus::DENIED) {
                                                printf("WebView2: Using cached permission: User previously blocked %s for %s\n", permissionName.c_str(), origin.c_str());
                                                args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
                                                return S_OK;
                                            }
                                            
                                            // No cached permission, show dialog
                                            printf("WebView2: No cached permission found for %s, showing dialog\n", origin.c_str());
                                            
                                            std::string message = "This page wants to access ";
                                            switch (kind) {
                                                case COREWEBVIEW2_PERMISSION_KIND_CAMERA:
                                                    message += "your camera.\n\nDo you want to allow this?";
                                                    break;
                                                case COREWEBVIEW2_PERMISSION_KIND_MICROPHONE:
                                                    message += "your microphone.\n\nDo you want to allow this?";
                                                    break;
                                                case COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION:
                                                    message += "your location.\n\nDo you want to allow this?";
                                                    break;
                                                case COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS:
                                                    message += "show notifications.\n\nDo you want to allow this?";
                                                    break;
                                                default:
                                                    message += "additional permissions.\n\nDo you want to allow this?";
                                                    break;
                                            }
                                            
                                            // Show Windows message box
                                            int result = MessageBoxA(
                                                nullptr,
                                                message.c_str(),
                                                permissionName.c_str(),
                                                MB_YESNO | MB_ICONQUESTION | MB_TOPMOST
                                            );
                                            
                                            // Handle response and cache the decision
                                            if (result == IDYES) {
                                                args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                                                cachePermission(origin, permType, PermissionStatus::ALLOWED);
                                                printf("WebView2: User allowed %s for %s (cached)\n", permissionName.c_str(), origin.c_str());
                                            } else {
                                                args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
                                                cachePermission(origin, permType, PermissionStatus::DENIED);
                                                printf("WebView2: User blocked %s for %s (cached)\n", permissionName.c_str(), origin.c_str());
                                            }
                                            
                                            return S_OK;
                                        }).Get(),
                                    nullptr);
                                
                                // Add file dialog handler for <input type="file">
                                // Note: WebView2 generally handles file dialogs automatically,
                                // but we can enhance support by enabling the necessary permissions
                                // in the AdditionalBrowserArguments (already done above with --disable-web-security)
                                
                            } else {
                            }
                            
                            // Navigate to URL
                            if (!view->pendingUrl.empty()) {
                                view->loadURL(view->pendingUrl.c_str());
                            }
                            
                            view->setCreationComplete(true);
                            container->AddAbstractView(view);
                            
                            // Store WebView2View in global map for JavaScript execution
                            HWND containerHwnd = container->GetHwnd();
                            g_webview2Views[containerHwnd] = view.get();
                            
                            
                            return S_OK;
                        }).Get());
            });
        
        
        
        // Create WebView2 environment with custom scheme support
        try {
            auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
            options->put_AdditionalBrowserArguments(L"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --allow-insecure-localhost --disable-web-security");
            
            // Get the interface that supports custom scheme registration  
            Microsoft::WRL::ComPtr<ICoreWebView2EnvironmentOptions4> options4;
            if (SUCCEEDED(options.As(&options4))) {
                // ::log("Setting up views:// custom scheme registration");
                
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
                    // ::log("views:// custom scheme registration set successfully");
                } else {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "Failed to set views:// custom scheme registration: 0x%lx", schemeResult);
                    ::log(errorMsg);
                }
            } else {
                ::log("ERROR: Failed to get ICoreWebView2EnvironmentOptions4 interface for custom scheme registration");
            }
            
            
            HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, nullptr, options.Get(), environmentCompletedHandler.Get());
            
            
            if (FAILED(hr)) {
                char errorMsg[256];
                sprintf_s(errorMsg, "ERROR: CreateCoreWebView2EnvironmentWithOptions failed with HRESULT: 0x%08X", hr);
                ::log(errorMsg);
            } else {
                // ::log("[WebView2] CreateCoreWebView2EnvironmentWithOptions succeeded");
            }
        } catch (const std::exception& e) {
            std::cout << "[WebView2] Exception in WebView2 creation: " << e.what() << std::endl;
        } catch (...) {
            std::cout << "[WebView2] Unknown exception in WebView2 creation" << std::endl;
        }
    });
    
    return view;
}

// Internal factory method for creating CEF instances  
static std::shared_ptr<CEFView> createCEFView(uint32_t webviewId,
                                       HWND hwnd,
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
    
    auto view = std::make_shared<CEFView>(webviewId);
    view->hwnd = hwnd;
    view->fullSize = autoResize;
    
    // Initialize CEF on main thread
    bool cefInitResult = MainThreadDispatcher::dispatch_sync([=]() -> bool {
        return initCEF();
    });
    
    if (!cefInitResult) {
        ::log("ERROR: Failed to initialize CEF");
        return view;
    }
    
    // CEF browser creation logic
    MainThreadDispatcher::dispatch_sync([=]() {
        auto container = GetOrCreateContainer(hwnd);
        if (!container) {
            ::log("ERROR: Failed to create container");
            return;
        }
        
        // Create CEF browser info
        CefWindowInfo windowInfo;
        CefRect cefBounds((int)x, (int)y, (int)width, (int)height);

        windowInfo.SetAsChild(container->GetHwnd(), cefBounds);
        
        CefBrowserSettings browserSettings;
        // Note: web_security setting for CEF would need correct API
        
        // Create CEF client with bridge handlers
        auto client = new ElectrobunCefClient(webviewId, bunBridgeHandler, internalBridgeHandler);
        
        // Set up preload scripts
        if (electrobunPreloadScript && strlen(electrobunPreloadScript) > 0) {
            client->AddPreloadScript(std::string(electrobunPreloadScript));
        }
        if (customPreloadScript && strlen(customPreloadScript) > 0) {
            client->UpdateCustomPreloadScript(std::string(customPreloadScript));
        }
        
        // Note: Additional callback methods would need to be implemented if needed
        // client->SetNavigationCallback(navigationCallback);
        // client->SetWebviewEventHandler(webviewEventHandler);
        
        view->setClient(client);
        
        // Store preload scripts before browser creation so they're available during LoadStart
        std::string combinedScript = client->GetCombinedScript();
        if (!combinedScript.empty()) {
            // We need to store by browser ID, but we don't have it yet
            // Let's use a temporary approach - store by client pointer for now
            static std::map<ElectrobunCefClient*, std::string> g_tempPreloadScripts;
            g_tempPreloadScripts[client] = combinedScript;
        }
        
        // Create browser synchronously (like Mac implementation)
        CefRefPtr<CefBrowser> browser = CefBrowserHost::CreateBrowserSync(
            windowInfo, client, url ? url : "about:blank", browserSettings, nullptr, nullptr);
        
        if (browser) {
            // Now store the script with the actual browser ID
            if (!combinedScript.empty()) {
                g_preloadScripts[browser->GetIdentifier()] = combinedScript;
            }
            
            // Set browser on view immediately since we have it synchronously
            view->setBrowser(browser);
            
            // Track browser in global map
            g_cefBrowsers[browser->GetIdentifier()] = browser;
            g_browser_count++;
            
            container->AddAbstractView(view);
            // Add client to global map
            HWND containerHwnd = container->GetHwnd();
            g_cefClients[containerHwnd] = client;
                // Add CEFView to global map
            g_cefViews[containerHwnd] = view.get();
            
            // Set browser on client for script execution
            client->SetBrowser(browser);
            
            // Set initial bounds on view before calling resize
            RECT initialBounds = {(LONG)x, (LONG)y, (LONG)(x + width), (LONG)(y + height)};
            view->visualBounds = initialBounds;
            
            // Handle z-ordering immediately since browser is ready
            view->resize(initialBounds, nullptr);
            
        }
    });
    
    return view;
}

// Console control handler for graceful shutdown
BOOL WINAPI ConsoleControlHandler(DWORD dwCtrlType) {
    switch (dwCtrlType) {
        case CTRL_C_EVENT:
        case CTRL_BREAK_EVENT:
        case CTRL_CLOSE_EVENT:
        case CTRL_LOGOFF_EVENT:
        case CTRL_SHUTDOWN_EVENT:
            std::cout << "[CEF] Received shutdown signal, closing browsers..." << std::endl;
            
            if (g_cef_initialized) {
                // Close all CEF browsers first - this will trigger OnBeforeClose handlers
                // which will call CefQuitMessageLoop() when the last browser closes
                std::cout << "[CEF] Closing " << g_browser_count << " browsers..." << std::endl;
                
                // Create a copy of the map to avoid iterator invalidation
                auto browsers_copy = g_cefBrowsers;
                for (auto& pair : browsers_copy) {
                    if (pair.second) {
                        std::cout << "[CEF] Closing browser ID " << pair.first << std::endl;
                        pair.second->GetHost()->CloseBrowser(true); // Force close
                    }
                }
                
                // Give browsers time to close gracefully
                // OnBeforeClose will call CefQuitMessageLoop() when last browser closes
                Sleep(1000);  // Reduced from 3000ms for faster response
                
                // If browsers didn't close properly, force quit
                if (g_browser_count > 0) {
                    std::cout << "[CEF] Browsers didn't close, forcing CEF shutdown" << std::endl;
                    CefQuitMessageLoop();
                    Sleep(500);  // Brief wait
                }
                
                // Explicitly terminate any remaining CEF helper processes
                std::cout << "[CEF] Terminating any remaining helper processes..." << std::endl;
                TerminateCEFHelperProcesses();
            }
            
            // Close the job object to terminate any remaining child processes
            if (g_job_object) {
                std::cout << "[CEF] Closing job object to terminate all child processes" << std::endl;
                CloseHandle(g_job_object);
                g_job_object = nullptr;
            }
            
            // Force termination if still running
            std::cout << "[CEF] Forcing application exit" << std::endl;
            ExitProcess(0);
            return TRUE;
        default:
            return FALSE;
    }
}

extern "C" {

ELECTROBUN_EXPORT void runNSApplication() {
    // Set up console control handler for graceful shutdown on Ctrl+C
    if (!SetConsoleCtrlHandler(ConsoleControlHandler, TRUE)) {
        std::cout << "[CEF] Warning: Failed to set console control handler" << std::endl;
    }
    
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
    
    // Initialize CEF if available
    if (isCEFAvailable()) {
        if (initCEF()) {
            CefRunMessageLoop(); // Use CEF's message loop like macOS
            
            // Clean up after CEF shutdown
            std::cout << "[CEF] CEF message loop ended, performing cleanup..." << std::endl;
            TerminateCEFHelperProcesses();
            
            // Close job object
            if (g_job_object) {
                CloseHandle(g_job_object);
                g_job_object = nullptr;
            }
            
            CefShutdown();
        } else {
            // Fall back to Windows message loop if CEF init fails
            MSG msg;
            while (GetMessage(&msg, NULL, 0, 0)) {
                TranslateMessage(&msg);
                DispatchMessage(&msg);
            }
        }
    } else {
        // Use Windows message loop if CEF is not available
        MSG msg;
        while (GetMessage(&msg, NULL, 0, 0)) {
            TranslateMessage(&msg);
            DispatchMessage(&msg);
        }
    }
}


ELECTROBUN_EXPORT void killApp() {
    if (isCEFAvailable() && g_cef_initialized) {
        std::cout << "[CEF] Initiating graceful shutdown via CefQuitMessageLoop()" << std::endl;
        
        // Close all browsers first
        auto browsers_copy = g_cefBrowsers;
        for (auto& pair : browsers_copy) {
            if (pair.second) {
                pair.second->GetHost()->CloseBrowser(true);
            }
        }
        
        // Brief wait for browsers to close
        Sleep(500);
        
        // Quit CEF message loop
        CefQuitMessageLoop();
        
        // Terminate any remaining helper processes
        TerminateCEFHelperProcesses();
        
        // Close job object to ensure all child processes are terminated
        if (g_job_object) {
            CloseHandle(g_job_object);
            g_job_object = nullptr;
        }
        
        ::log("CEF shutdown initiated");
    } else {
        // If CEF is not running, still check for helper processes
        TerminateCEFHelperProcesses();
        
        // Close job object if it exists
        if (g_job_object) {
            CloseHandle(g_job_object);
            g_job_object = nullptr;
        }
        
        // Exit directly
        ExitProcess(1);
    }
}

ELECTROBUN_EXPORT void shutdownApplication() {
    // Stub implementation
}

// Clean, elegant initWebview function - Windows version matching Mac pattern
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
    
    // Serialize webview creation to avoid CEF/WebView2 conflicts
    std::lock_guard<std::mutex> lock(g_webviewCreationMutex);

    
    HWND hwnd = reinterpret_cast<HWND>(window);
    
    // Factory pattern - choose implementation based on renderer  
    AbstractView* view = nullptr;
    
    if (renderer && strcmp(renderer, "cef") == 0 && isCEFAvailable()) {
        auto cefView = createCEFView(webviewId, hwnd, url, x, y, width, height, autoResize,
                                    partitionIdentifier, navigationCallback, webviewEventHandler,
                                    bunBridgeHandler, internalBridgeHandler,
                                    electrobunPreloadScript, customPreloadScript);
        view = cefView.get();
    } else {
        auto webview2View = createWebView2View(webviewId, hwnd, url, x, y, width, height, autoResize,
                                              partitionIdentifier, navigationCallback, webviewEventHandler,
                                              bunBridgeHandler, internalBridgeHandler,
                                              electrobunPreloadScript, customPreloadScript);
        view = webview2View.get();
    }
    
    // Note: Object lifetime is managed by the ContainerView which holds shared_ptr references
    // The factories add the views to containers, so they remain alive after this function returns
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
    if (!abstractView || !urlString) {
        ::log("ERROR: Invalid parameters passed to loadURLInWebView");
        return;
    }
    
    // Use virtual method which handles threading and implementation details
    
    abstractView->loadURL(urlString);
}

ELECTROBUN_EXPORT void webviewGoBack(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewGoBack");
        return;
    }
    
    abstractView->goBack();
}

ELECTROBUN_EXPORT void webviewGoForward(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewGoForward");
        return;
    }
    
    abstractView->goForward();
}

ELECTROBUN_EXPORT void webviewReload(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewReload");
        return;
    }
    
    abstractView->reload();
}

ELECTROBUN_EXPORT void webviewRemove(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView in webviewRemove");
        return;
    }
    
    
    abstractView->remove();
}

ELECTROBUN_EXPORT BOOL webviewCanGoBack(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewCanGoBack");
        return FALSE;
    }
    
    return abstractView->canGoBack();
}

ELECTROBUN_EXPORT BOOL webviewCanGoForward(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewCanGoForward");
        return FALSE;
    }
    
    return abstractView->canGoForward();
}

ELECTROBUN_EXPORT void evaluateJavaScriptWithNoCompletion(AbstractView *abstractView, const char *script) {
    if (!abstractView || !script) {
        ::log("ERROR: Invalid parameters passed to evaluateJavaScriptWithNoCompletion");
        return;
    }
    
    abstractView->evaluateJavaScriptWithNoCompletion(script);
    
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
    if (abstractView) {
        // UI operations must be performed on the main thread
        MainThreadDispatcher::dispatch_sync([abstractView, transparent]() {
            abstractView->setTransparent(transparent);
        });
    }
}

ELECTROBUN_EXPORT void webviewSetPassthrough(AbstractView *abstractView, BOOL enablePassthrough) {
    if (abstractView) {
        // UI operations must be performed on the main thread
        MainThreadDispatcher::dispatch_sync([abstractView, enablePassthrough]() {
            abstractView->setPassthrough(enablePassthrough);
        });
    }
}

ELECTROBUN_EXPORT void webviewSetHidden(AbstractView *abstractView, BOOL hidden) {
    if (abstractView) {
        // UI operations must be performed on the main thread
        MainThreadDispatcher::dispatch_sync([abstractView, hidden]() {
            abstractView->setTransparent(hidden);
        });
    }
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
            wc.lpfnWndProc = WindowProc;
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

             if (g_applicationMenu) {
                if (SetMenu(hwnd, g_applicationMenu)) {
                    DrawMenuBar(hwnd);
                    // char logMsg[256];
                    // sprintf_s(logMsg, "Applied application menu to new window: HWND=%p", hwnd);
                    // ::log(logMsg);
                } else {
                    ::log("Failed to apply application menu to new window");
                }
            }
            
            
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
    // On Windows, NSWindow* is actually HWND
    HWND hwnd = reinterpret_cast<HWND>(window);
    
    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in makeNSWindowKeyAndOrderFront");
        return;
    }
    
    // Dispatch to main thread to ensure thread safety
    MainThreadDispatcher::dispatch_sync([=]() {      
        // Show the window if it's hidden
        if (!IsWindowVisible(hwnd)) {
            ShowWindow(hwnd, SW_SHOW);
        }
        
        // Bring window to foreground - this is more complex on Windows
        // due to foreground window restrictions
        
        // First, try the simple approach
        if (SetForegroundWindow(hwnd)) {
        } else {
            // If that fails, we need to work around Windows' foreground restrictions
            DWORD currentThreadId = GetCurrentThreadId();
            DWORD foregroundThreadId = GetWindowThreadProcessId(GetForegroundWindow(), NULL);
            
            if (currentThreadId != foregroundThreadId) {
                // Attach to the foreground thread's input queue temporarily
                if (AttachThreadInput(currentThreadId, foregroundThreadId, TRUE)) {
                    SetForegroundWindow(hwnd);
                    SetFocus(hwnd);
                    AttachThreadInput(currentThreadId, foregroundThreadId, FALSE);
                } else {
                    // Last resort - flash the window to get user attention
                    FLASHWINFO fwi = {0};
                    fwi.cbSize = sizeof(FLASHWINFO);
                    fwi.hwnd = hwnd;
                    fwi.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
                    fwi.uCount = 3;
                    fwi.dwTimeout = 0;
                    FlashWindowEx(&fwi);
                    
                }
            }
        }
        
        // Ensure the window is active and focused
        SetActiveWindow(hwnd);
        SetFocus(hwnd);
        
        // Bring to top of Z-order
        SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, 
                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        
    });
}

ELECTROBUN_EXPORT void setNSWindowTitle(NSWindow *window, const char *title) {
    // On Windows, NSWindow* is actually HWND
    HWND hwnd = reinterpret_cast<HWND>(window);
    
    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in setNSWindowTitle");
        return;
    }
    
    // Dispatch to main thread to ensure thread safety
    MainThreadDispatcher::dispatch_sync([=]() {
        if (title && strlen(title) > 0) {
            // Convert UTF-8 to wide string for Unicode support
            int size = MultiByteToWideChar(CP_UTF8, 0, title, -1, NULL, 0);
            if (size > 0) {
                std::wstring wTitle(size - 1, 0);
                MultiByteToWideChar(CP_UTF8, 0, title, -1, &wTitle[0], size);
                
                // Set the window title
                if (SetWindowTextW(hwnd, wTitle.c_str())) {
                    
                } else {
                    DWORD error = GetLastError();
                    char errorMsg[256];
                    sprintf_s(errorMsg, "Failed to set window title, error: %lu", error);
                    ::log(errorMsg);
                }
            } else {
                ::log("ERROR: Failed to convert title to wide string");
            }
        } else {
            // Set empty title
            if (SetWindowTextW(hwnd, L"")) {
            } else {
                DWORD error = GetLastError();
                char errorMsg[256];
                sprintf_s(errorMsg, "Failed to clear window title, error: %lu", error);
                ::log(errorMsg);
            }
        }
    });
}

ELECTROBUN_EXPORT void closeNSWindow(NSWindow *window) {
    // On Windows, NSWindow* is actually HWND
    HWND hwnd = reinterpret_cast<HWND>(window);
    
    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in closeNSWindow");
        return;
    }
    
    // Dispatch to main thread to ensure thread safety
    MainThreadDispatcher::dispatch_sync([=]() {

        
        // Clean up any associated container views before closing
        auto containerIt = g_containerViews.find(hwnd);
        if (containerIt != g_containerViews.end()) {
            g_containerViews.erase(containerIt);
        }
        
        // Send WM_CLOSE message to the window
        // This will trigger the window's close handler if one is set
        if (PostMessage(hwnd, WM_CLOSE, 0, 0)) {
        } else {
            DWORD error = GetLastError();
            char errorMsg[256];
            sprintf_s(errorMsg, "Failed to send WM_CLOSE message, error: %lu", error);
            ::log(errorMsg);
            
            // If PostMessage fails, try DestroyWindow as a fallback
            ::log("Attempting DestroyWindow as fallback");
            if (DestroyWindow(hwnd)) {
            } else {
                DWORD destroyError = GetLastError();
                char destroyErrorMsg[256];
                sprintf_s(destroyErrorMsg, "DestroyWindow also failed, error: %lu", destroyError);
                ::log(destroyErrorMsg);
            }
        }
    });
}

ELECTROBUN_EXPORT void resizeWebview(AbstractView *abstractView, double x, double y, double width, double height, const char *masksJson) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView in resizeWebview");
        return;
    }
    
    
    RECT bounds = {(LONG)x, (LONG)y, (LONG)(x + width), (LONG)(y + height)};
    abstractView->resize(bounds, masksJson);
}

// Internal function to stop window movement (without export linkage)



ELECTROBUN_EXPORT void stopWindowMove() {
    if (g_isMovingWindow) {
        // Unregister raw input device
        RAWINPUTDEVICE rid;
        rid.usUsagePage = 0x01;
        rid.usUsage = 0x02;
        rid.dwFlags = RIDEV_REMOVE;
        rid.hwndTarget = NULL;
        
        RegisterRawInputDevices(&rid, 1, sizeof(RAWINPUTDEVICE));
        g_isMovingWindow = FALSE;
        g_targetWindow = NULL;
    }
}

ELECTROBUN_EXPORT void startWindowMove(NSWindow *window) {
    // On Windows, NSWindow* is actually HWND
    HWND hwnd = reinterpret_cast<HWND>(window);
    
    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in startWindowMove");
        return;
    }
    
    // Set up window dragging state
    g_targetWindow = hwnd;
    g_isMovingWindow = TRUE;
    
    // Get initial cursor and window positions
    GetCursorPos(&g_initialCursorPos);
    RECT windowRect;
    GetWindowRect(hwnd, &windowRect);
    g_initialWindowPos.x = windowRect.left;
    g_initialWindowPos.y = windowRect.top;
    
    // Register for raw mouse input to bypass WebView2 event consumption
    RAWINPUTDEVICE rid;
    rid.usUsagePage = 0x01;  // HID_USAGE_PAGE_GENERIC
    rid.usUsage = 0x02;      // HID_USAGE_GENERIC_MOUSE
    rid.dwFlags = RIDEV_INPUTSINK; // Receive input even when not in foreground
    rid.hwndTarget = hwnd;   // Send messages to our window
    
    if (!RegisterRawInputDevices(&rid, 1, sizeof(RAWINPUTDEVICE))) {
        ::log("ERROR: Failed to register raw input device - error: " + std::to_string(GetLastError()));
        g_isMovingWindow = FALSE;
        g_targetWindow = NULL;
    }
}

ELECTROBUN_EXPORT BOOL moveToTrash(char *pathString) {
    if (!pathString) {
        ::log("ERROR: NULL path string passed to moveToTrash");
        return FALSE;
    }
    
    // Convert to wide string for Windows API
    int wideCharLen = MultiByteToWideChar(CP_UTF8, 0, pathString, -1, NULL, 0);
    if (wideCharLen == 0) {
        ::log("ERROR: Failed to convert path to wide string");
        return FALSE;
    }
    
    std::vector<wchar_t> widePath(wideCharLen + 1);  // +1 for double null terminator
    MultiByteToWideChar(CP_UTF8, 0, pathString, -1, widePath.data(), wideCharLen);
    widePath[wideCharLen] = L'\0';  // Ensure double null termination
    
    // Use SHFileOperation to move to recycle bin
    SHFILEOPSTRUCTW fileOp = {};
    fileOp.hwnd = NULL;
    fileOp.wFunc = FO_DELETE;
    fileOp.pFrom = widePath.data();
    fileOp.pTo = NULL;
    fileOp.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT;
    fileOp.fAnyOperationsAborted = FALSE;
    fileOp.hNameMappings = NULL;
    fileOp.lpszProgressTitle = NULL;
    
    int result = SHFileOperationW(&fileOp);
    
    if (result == 0 && !fileOp.fAnyOperationsAborted) {
        ::log("Successfully moved to trash: " + std::string(pathString));
        return TRUE;
    } else {
        ::log("ERROR: Failed to move to trash: " + std::string(pathString) + " (error code: " + std::to_string(result) + ")");
        return FALSE;
    }
}

ELECTROBUN_EXPORT void showItemInFolder(char *path) {
    if (!path) {
        ::log("ERROR: NULL path passed to showItemInFolder");
        return;
    }
    
    std::string pathString(path);
    if (pathString.empty()) {
        ::log("ERROR: Empty path passed to showItemInFolder");
        return;
    }
    
    // Convert to wide string for Windows API
    int wideCharLen = MultiByteToWideChar(CP_UTF8, 0, path, -1, NULL, 0);
    if (wideCharLen == 0) {
        ::log("ERROR: Failed to convert path to wide string in showItemInFolder");
        return;
    }
    
    std::vector<wchar_t> widePath(wideCharLen);
    MultiByteToWideChar(CP_UTF8, 0, path, -1, widePath.data(), wideCharLen);
    
    // Use ShellExecute to open Explorer and select the file
    std::wstring selectParam = L"/select,\"" + std::wstring(widePath.data()) + L"\"";
    
    HINSTANCE result = ShellExecuteW(
        NULL,                    // parent window
        L"open",                 // operation
        L"explorer.exe",         // executable
        selectParam.c_str(),     // parameters
        NULL,                    // working directory
        SW_SHOWNORMAL           // show command
    );
    
    // Check if the operation was successful
    if (reinterpret_cast<INT_PTR>(result) <= 32) {
        ::log("ERROR: Failed to show item in folder: " + pathString + " (error code: " + std::to_string(reinterpret_cast<INT_PTR>(result)) + ")");
    } else {
        ::log("Successfully opened folder for: " + pathString);
    }
}

ELECTROBUN_EXPORT const char* openFileDialog(const char *startingFolder,
                          const char *allowedFileTypes,
                          BOOL canChooseFiles,
                          BOOL canChooseDirectories,
                          BOOL allowsMultipleSelection) {
    if (!canChooseFiles && !canChooseDirectories) {
        ::log("ERROR: Both canChooseFiles and canChooseDirectories are false");
        return nullptr;
    }
    
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    if (FAILED(hr)) {
        ::log("ERROR: Failed to initialize COM");
        return nullptr;
    }
    
    IFileOpenDialog *pFileDialog = nullptr;
    hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_ALL, IID_IFileOpenDialog, (void**)&pFileDialog);
    if (FAILED(hr)) {
        ::log("ERROR: Failed to create file dialog");
        CoUninitialize();
        return nullptr;
    }
    
    // Set dialog options
    DWORD dwFlags = 0;
    pFileDialog->GetOptions(&dwFlags);
    
    if (canChooseDirectories) {
        dwFlags |= FOS_PICKFOLDERS;
    }
    if (allowsMultipleSelection) {
        dwFlags |= FOS_ALLOWMULTISELECT;
    }
    if (!canChooseFiles) {
        dwFlags |= FOS_PICKFOLDERS;
    }
    
    pFileDialog->SetOptions(dwFlags);
    
    // Set starting folder
    if (startingFolder && strlen(startingFolder) > 0) {
        int wideCharLen = MultiByteToWideChar(CP_UTF8, 0, startingFolder, -1, nullptr, 0);
        if (wideCharLen > 0) {
            std::vector<wchar_t> wideStartingFolder(wideCharLen);
            MultiByteToWideChar(CP_UTF8, 0, startingFolder, -1, wideStartingFolder.data(), wideCharLen);
            
            IShellItem *pStartingFolder = nullptr;
            hr = SHCreateItemFromParsingName(wideStartingFolder.data(), nullptr, IID_IShellItem, (void**)&pStartingFolder);
            if (SUCCEEDED(hr)) {
                pFileDialog->SetFolder(pStartingFolder);
                pStartingFolder->Release();
            }
        }
    }
    
    // Set file type filters
    if (allowedFileTypes && strlen(allowedFileTypes) > 0 && strcmp(allowedFileTypes, "*") != 0) {
        std::string typesStr(allowedFileTypes);
        std::vector<std::string> extensions;
        std::stringstream ss(typesStr);
        std::string extension;
        
        while (std::getline(ss, extension, ',')) {
            // Trim whitespace
            extension.erase(0, extension.find_first_not_of(" \t"));
            extension.erase(extension.find_last_not_of(" \t") + 1);
            if (!extension.empty()) {
                extensions.push_back(extension);
            }
        }
        
        if (!extensions.empty()) {
            // Create filter specification
            std::vector<COMDLG_FILTERSPEC> filterSpecs;
            std::vector<std::wstring> filterNames;
            std::vector<std::wstring> filterPatterns;
            
            for (const auto& ext : extensions) {
                std::wstring wExt = std::wstring(ext.begin(), ext.end());
                if (wExt.find(L".") != 0) {
                    wExt = L"." + wExt;
                }
                std::wstring pattern = L"*" + wExt;
                std::wstring name = wExt.substr(1) + L" files";
                
                filterNames.push_back(name);
                filterPatterns.push_back(pattern);
                
                COMDLG_FILTERSPEC spec;
                spec.pszName = filterNames.back().c_str();
                spec.pszSpec = filterPatterns.back().c_str();
                filterSpecs.push_back(spec);
            }
            
            pFileDialog->SetFileTypes(static_cast<UINT>(filterSpecs.size()), filterSpecs.data());
        }
    }
    
    // Show the dialog
    hr = pFileDialog->Show(nullptr);
    std::string result;
    
    if (SUCCEEDED(hr)) {
        if (allowsMultipleSelection) {
            IShellItemArray *pShellItemArray = nullptr;
            hr = pFileDialog->GetResults(&pShellItemArray);
            if (SUCCEEDED(hr)) {
                DWORD itemCount = 0;
                pShellItemArray->GetCount(&itemCount);
                
                std::vector<std::string> paths;
                for (DWORD i = 0; i < itemCount; i++) {
                    IShellItem *pShellItem = nullptr;
                    hr = pShellItemArray->GetItemAt(i, &pShellItem);
                    if (SUCCEEDED(hr)) {
                        PWSTR pszPath = nullptr;
                        hr = pShellItem->GetDisplayName(SIGDN_FILESYSPATH, &pszPath);
                        if (SUCCEEDED(hr)) {
                            int utf8Len = WideCharToMultiByte(CP_UTF8, 0, pszPath, -1, nullptr, 0, nullptr, nullptr);
                            if (utf8Len > 0) {
                                std::vector<char> utf8Path(utf8Len);
                                WideCharToMultiByte(CP_UTF8, 0, pszPath, -1, utf8Path.data(), utf8Len, nullptr, nullptr);
                                paths.push_back(std::string(utf8Path.data()));
                            }
                            CoTaskMemFree(pszPath);
                        }
                        pShellItem->Release();
                    }
                }
                pShellItemArray->Release();
                
                // Join paths with comma
                for (size_t i = 0; i < paths.size(); i++) {
                    if (i > 0) result += ",";
                    result += paths[i];
                }
            }
        } else {
            IShellItem *pShellItem = nullptr;
            hr = pFileDialog->GetResult(&pShellItem);
            if (SUCCEEDED(hr)) {
                PWSTR pszPath = nullptr;
                hr = pShellItem->GetDisplayName(SIGDN_FILESYSPATH, &pszPath);
                if (SUCCEEDED(hr)) {
                    int utf8Len = WideCharToMultiByte(CP_UTF8, 0, pszPath, -1, nullptr, 0, nullptr, nullptr);
                    if (utf8Len > 0) {
                        std::vector<char> utf8Path(utf8Len);
                        WideCharToMultiByte(CP_UTF8, 0, pszPath, -1, utf8Path.data(), utf8Len, nullptr, nullptr);
                        result = std::string(utf8Path.data());
                    }
                    CoTaskMemFree(pszPath);
                }
                pShellItem->Release();
            }
        }
    }
    
    pFileDialog->Release();
    CoUninitialize();
    
    if (result.empty()) {
        ::log("File dialog cancelled or no selection made");
        return nullptr;
    }
    
    return strdup(result.c_str());
}



// Window procedure for handling tray messages
LRESULT CALLBACK TrayWindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CLOSE:
        case WM_DESTROY:
            // Don't allow the tray window to be closed/destroyed by default handlers
            ::log("Preventing tray window close/destroy");
            return 0;
            
        case WM_COMMAND:
        // Handle menu item clicks
        {
            auto it = g_trayItems.find(hwnd);
            if (it != g_trayItems.end()) {
                NSStatusItem* trayItem = it->second;
                UINT menuItemId = LOWORD(wParam);
                
                // Use your existing function to handle the menu selection
                handleMenuItemSelection(menuItemId, trayItem);
            }
            return 0;
        }
            
        default:
            // Check if this is our tray message
            if (msg == g_trayMessageId) {
                // Find the tray item
                auto it = g_trayItems.find(hwnd);
                if (it != g_trayItems.end()) {
                    NSStatusItem* trayItem = it->second;
                    
                    switch (LOWORD(lParam)) {
                        case WM_LBUTTONUP:
                           
                            
                        case WM_RBUTTONUP:
                            // Right click - show context menu if it exists, otherwise call handler
                            if (trayItem->contextMenu) {
                                
                                
                                POINT pt;
                                GetCursorPos(&pt);
                                
                                // This is required for the menu to work properly
                                SetForegroundWindow(hwnd);
                                
                                // Show the menu
                                BOOL menuResult = TrackPopupMenu(
                                    trayItem->contextMenu, 
                                    TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_LEFTALIGN,
                                    pt.x, pt.y, 
                                    0, 
                                    hwnd, 
                                    NULL
                                );
                                
                                // This message helps ensure the menu closes properly
                                PostMessage(hwnd, WM_NULL, 0, 0);
                                
                                if (!menuResult) {
                                    ::log("TrackPopupMenu failed");
                                }
                            } else {
                                // No menu exists yet, call handler (this will trigger menu creation)
                                
                                
                                if (trayItem->handler) {
                                    // Use a separate thread or async call to prevent blocking
                                    std::thread([trayItem]() {
                                        try {
                                            trayItem->handler(trayItem->trayId, "");
                                        } catch (...) {
                                            ::log("Exception in tray handler");
                                        }
                                    }).detach();
                                }
                            }
                            return 0;
                            
                        default:
                            break;
                    }
                }
                return 0;
            }
            break;
    }
    
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

ELECTROBUN_EXPORT NSStatusItem* createTray(uint32_t trayId, const char *title, const char *pathToImage, bool isTemplate,
                        uint32_t width, uint32_t height, ZigStatusItemHandler zigTrayItemHandler) {
    
    return MainThreadDispatcher::dispatch_sync([=]() -> NSStatusItem* {
        // ::log("Creating system tray icon");
        
        NSStatusItem* statusItem = new NSStatusItem();
        statusItem->trayId = trayId;
        statusItem->handler = zigTrayItemHandler;
        
        if (title) {
            statusItem->title = std::string(title);
        }
        if (pathToImage) {
            statusItem->imagePath = std::string(pathToImage);
        }
        
        // Create a hidden window to receive tray messages
        static bool classRegistered = false;
        if (!classRegistered) {
            WNDCLASSA wc = {0};
            wc.lpfnWndProc = TrayWindowProc;
            wc.hInstance = GetModuleHandle(NULL);
            wc.lpszClassName = "TrayWindowClass";
            wc.hbrBackground = NULL;
            wc.hCursor = LoadCursor(NULL, IDC_ARROW);
            wc.style = 0; // No special styles
            
            if (!RegisterClassA(&wc)) {
                DWORD error = GetLastError();
                if (error != ERROR_CLASS_ALREADY_EXISTS) {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "Failed to register TrayWindowClass: %lu", error);
                    ::log(errorMsg);
                    delete statusItem;
                    return nullptr;
                }
            }
            classRegistered = true;
        }
        
        // Create message-only window (safer for tray operations)
        statusItem->hwnd = CreateWindowA(
            "TrayWindowClass", 
            "TrayWindow", 
            0,                    // No visible style
            0, 0, 0, 0,          // Position and size (ignored for message-only)
            HWND_MESSAGE,        // Message-only window
            NULL, 
            GetModuleHandle(NULL), 
            NULL
        );
        
        if (!statusItem->hwnd) {
            DWORD error = GetLastError();
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Failed to create tray window: %lu", error);
            ::log(errorMsg);
            delete statusItem;
            return nullptr;
        }
        
        
        
        // Store in global map before setting up the tray icon
        g_trayItems[statusItem->hwnd] = statusItem;
        
        // Set up NOTIFYICONDATA
        statusItem->nid.cbSize = sizeof(NOTIFYICONDATA);
        statusItem->nid.hWnd = statusItem->hwnd;
        statusItem->nid.uID = trayId;
        statusItem->nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        statusItem->nid.uCallbackMessage = g_trayMessageId;
        
        // Set title/tooltip
        if (!statusItem->title.empty()) {
            strncpy_s(statusItem->nid.szTip, sizeof(statusItem->nid.szTip), 
                     statusItem->title.c_str(), sizeof(statusItem->nid.szTip) - 1);
        }
        
        // Load icon
        if (!statusItem->imagePath.empty()) {
            // Convert to wide string for LoadImage
            int size = MultiByteToWideChar(CP_UTF8, 0, statusItem->imagePath.c_str(), -1, NULL, 0);
            if (size > 0) {
                std::wstring wImagePath(size - 1, 0);
                MultiByteToWideChar(CP_UTF8, 0, statusItem->imagePath.c_str(), -1, &wImagePath[0], size);
                
                statusItem->nid.hIcon = (HICON)LoadImageW(NULL, wImagePath.c_str(), IMAGE_ICON,
                                                         width, height, LR_LOADFROMFILE);
                
                if (!statusItem->nid.hIcon) {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "Failed to load icon from: %s", statusItem->imagePath.c_str());
                    ::log(errorMsg);
                }
            }
        }
        
        // Use default icon if loading failed
        if (!statusItem->nid.hIcon) {
            statusItem->nid.hIcon = LoadIcon(NULL, IDI_APPLICATION);
            ::log("Using default application icon");
        }
        
        // Add to system tray
        if (Shell_NotifyIcon(NIM_ADD, &statusItem->nid)) {
            // char successMsg[256];
            // sprintf_s(successMsg, "System tray icon created successfully: ID=%u, HWND=%p", trayId, statusItem->hwnd);
            // ::log(successMsg);
        } else {
            DWORD error = GetLastError();
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Failed to add icon to system tray: %lu", error);
            ::log(errorMsg);
            
            DestroyWindow(statusItem->hwnd);
            g_trayItems.erase(statusItem->hwnd);
            delete statusItem;
            return nullptr;
        }
        
        return statusItem;
    });
}

ELECTROBUN_EXPORT void setTrayTitle(NSStatusItem *statusItem, const char *title) {
    if (!statusItem) return;
    
    MainThreadDispatcher::dispatch_sync([=]() {
        
        if (title) {
            statusItem->title = std::string(title);
            strncpy_s(statusItem->nid.szTip, title, sizeof(statusItem->nid.szTip) - 1);
        } else {
            statusItem->title.clear();
            statusItem->nid.szTip[0] = '\0';
        }
        
        // Update the tray icon
        Shell_NotifyIcon(NIM_MODIFY, &statusItem->nid);
    });
}

ELECTROBUN_EXPORT void setTrayImage(NSStatusItem *statusItem, const char *image) {
    if (!statusItem) return;
    
    MainThreadDispatcher::dispatch_sync([=]() {
        
        HICON oldIcon = statusItem->nid.hIcon;
        
        if (image && strlen(image) > 0) {
            statusItem->imagePath = std::string(image);
            
            // Convert to wide string
            int size = MultiByteToWideChar(CP_UTF8, 0, image, -1, NULL, 0);
            if (size > 0) {
                std::wstring wImagePath(size - 1, 0);
                MultiByteToWideChar(CP_UTF8, 0, image, -1, &wImagePath[0], size);
                
                statusItem->nid.hIcon = (HICON)LoadImageW(NULL, wImagePath.c_str(), IMAGE_ICON,
                                                         0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
            }
        }
        
        // Use default icon if loading failed
        if (!statusItem->nid.hIcon) {
            statusItem->nid.hIcon = LoadIcon(NULL, IDI_APPLICATION);
        }
        
        // Update the tray icon
        if (Shell_NotifyIcon(NIM_MODIFY, &statusItem->nid)) {
            // Clean up old icon if it's not the default
            if (oldIcon && oldIcon != LoadIcon(NULL, IDI_APPLICATION)) {
                DestroyIcon(oldIcon);
            }
        } else {
            ::log("ERROR: Failed to update tray image");
            // Restore old icon on failure
            statusItem->nid.hIcon = oldIcon;
        }
    });
}

// Updated setTrayMenuFromJSON function
ELECTROBUN_EXPORT void setTrayMenuFromJSON(NSStatusItem *statusItem, const char *jsonString) {
    if (!statusItem || !jsonString) return;
        
    MainThreadDispatcher::dispatch_sync([=]() {
        
        if (!statusItem->handler) {
            ::log("ERROR: No handler found for status item");
            return;
        }
        
        try {
            // Parse JSON using our simple parser
            SimpleJsonValue menuConfig = parseJson(std::string(jsonString));
            
            if (menuConfig.type != SimpleJsonValue::ARRAY) {
                ::log("ERROR: JSON menu configuration is not an array");
                return;
            }
            
            // Clean up existing menu
            if (statusItem->contextMenu) {
                DestroyMenu(statusItem->contextMenu);
                statusItem->contextMenu = NULL;
            }
            
            // Create new menu from JSON config
            statusItem->contextMenu = createMenuFromConfig(menuConfig, statusItem);
            
            if (statusItem->contextMenu) {
            } else {
                ::log("ERROR: Failed to create context menu from JSON configuration");
            }
            
        } catch (const std::exception& e) {
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Exception parsing JSON: %s", e.what());
            ::log(errorMsg);
        } catch (...) {
            ::log("ERROR: Unknown exception parsing JSON");
        }
    });
}

// You'll also need to update your tray click handler to process menu selections
// This should be called from your window procedure when handling tray icon messages
void handleTrayIconMessage(HWND hwnd, WPARAM wParam, LPARAM lParam) {
    NSStatusItem* statusItem = nullptr;
    
    // Find the status item from the global map
    auto it = g_trayItems.find(hwnd);
    if (it != g_trayItems.end()) {
        statusItem = it->second;
    }
    
    switch (lParam) {
        case WM_RBUTTONUP:
        case WM_CONTEXTMENU:
            if (statusItem && statusItem->contextMenu) {
                POINT pt;
                GetCursorPos(&pt);
                
                // Required for popup menus to work correctly
                SetForegroundWindow(hwnd);
                
                UINT cmd = TrackPopupMenu(
                    statusItem->contextMenu,
                    TPM_RETURNCMD | TPM_RIGHTBUTTON,
                    pt.x, pt.y,
                    0, hwnd, NULL
                );
                
                if (cmd != 0) {
                    handleMenuItemSelection(cmd, statusItem);
                }
                
                // Required cleanup
                PostMessage(hwnd, WM_NULL, 0, 0);
            }
            break;
            
        case WM_LBUTTONUP:
            // Handle left click on tray icon
            if (statusItem && statusItem->handler) {
                statusItem->handler(statusItem->trayId, "");
            }
            break;
    }
}

ELECTROBUN_EXPORT void setTrayMenu(NSStatusItem *statusItem, const char *menuConfig) {
    // Delegate to JSON version for now
    setTrayMenuFromJSON(statusItem, menuConfig);
}

ELECTROBUN_EXPORT void removeTray(NSStatusItem *statusItem) {
    if (!statusItem) return;
    
    MainThreadDispatcher::dispatch_sync([=]() {
        // Remove from global map first
        g_trayItems.erase(statusItem->hwnd);
        
        // Clean up the tray item
        delete statusItem;
    });
}

ELECTROBUN_EXPORT void setApplicationMenu(const char *jsonString, ZigStatusItemHandler zigTrayItemHandler) {
    if (!jsonString) {
        ::log("ERROR: NULL JSON string passed to setApplicationMenu");
        return;
    }
    
    
    MainThreadDispatcher::dispatch_sync([=]() {
        try {
            // Parse JSON using our simple parser
            SimpleJsonValue menuConfig = parseJson(std::string(jsonString));
            
            if (menuConfig.type != SimpleJsonValue::ARRAY) {
                ::log("ERROR: Application menu JSON configuration is not an array");
                return;
            }
            
            // Create target for handling menu actions
            g_appMenuTarget = std::make_unique<StatusItemTarget>();
            g_appMenuTarget->zigHandler = zigTrayItemHandler;
            g_appMenuTarget->trayId = 0;
            
            // Clean up existing application menu
            if (g_applicationMenu) {
                DestroyMenu(g_applicationMenu);
                g_applicationMenu = NULL;
            }
            
            // Create new application menu from JSON config
            g_applicationMenu = createApplicationMenuFromConfig(menuConfig, g_appMenuTarget.get());
            
            if (g_applicationMenu) {
                
                // Find the main application window to set the menu
                HWND mainWindow = GetActiveWindow();
                if (!mainWindow) {
                    mainWindow = FindWindowA("BasicWindowClass", NULL);
                }
                
                if (mainWindow) {
                    if (SetMenu(mainWindow, g_applicationMenu)) {
                        DrawMenuBar(mainWindow);
                        
                       
                    } else {
                        DWORD error = GetLastError();
                        char errorMsg[256];
                        sprintf_s(errorMsg, "Failed to set application menu on window: %lu", error);
                        ::log(errorMsg);
                    }
                } else {
                    ::log("Warning: No main window found to attach application menu");
                }
            } else {
                ::log("ERROR: Failed to create application menu from JSON configuration");
            }
            
        } catch (const std::exception& e) {
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Exception in setApplicationMenu: %s", e.what());
            ::log(errorMsg);
        } catch (...) {
            ::log("ERROR: Unknown exception in setApplicationMenu");
        }
    });
}


ELECTROBUN_EXPORT void showContextMenu(const char *jsonString, ZigStatusItemHandler contextMenuHandler) {
    if (!jsonString) {
        ::log("ERROR: NULL JSON string passed to showContextMenu");
        return;
    }
    
    if (!contextMenuHandler) {
        ::log("ERROR: NULL context menu handler passed to showContextMenu");
        return;
    }
    
    MainThreadDispatcher::dispatch_sync([=]() {
        try {
            SimpleJsonValue menuConfig = parseJson(std::string(jsonString));
            
            std::unique_ptr<StatusItemTarget> target = std::make_unique<StatusItemTarget>();
            target->zigHandler = contextMenuHandler;
            target->trayId = 0;
            
            HMENU menu = createMenuFromConfig(menuConfig, reinterpret_cast<NSStatusItem*>(target.get()));
            if (!menu) {
                ::log("ERROR: Failed to create context menu");
                return;
            }
            
            // Get cursor position for menu display
            POINT pt;
            GetCursorPos(&pt);
            
            // Get the foreground window or use desktop
            HWND hwnd = GetForegroundWindow();
            if (!hwnd) {
                hwnd = GetDesktopWindow();
            }
            
            // Required for proper menu operation
            SetForegroundWindow(hwnd);
                        
            // Show the context menu
            UINT cmd = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_RIGHTBUTTON,
                pt.x, pt.y,
                0, hwnd, NULL
            );
            
            // Handle menu selection
            if (cmd != 0) {
                handleMenuItemSelection(cmd, reinterpret_cast<NSStatusItem*>(target.get()));
            }
            
            // Required for proper cleanup
            PostMessage(hwnd, WM_NULL, 0, 0);
            
            // Cleanup menu
            DestroyMenu(menu);
            
        } catch (const std::exception& e) {
            ::log("ERROR: Exception in showContextMenu: " + std::string(e.what()));
        }
    });
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
    ::log("setJSUtils called but using map-based approach instead of callbacks");
}

// MARK: - Webview HTML Content Management (replaces JSCallback approach)

extern "C" ELECTROBUN_EXPORT void setWebviewHTMLContent(uint32_t webviewId, const char* htmlContent) {
    std::lock_guard<std::mutex> lock(webviewHTMLMutex);
    if (htmlContent) {
        webviewHTMLContent[webviewId] = std::string(htmlContent);
        char logMsg[256];
        sprintf_s(logMsg, "setWebviewHTMLContent: Set HTML for webview %u", webviewId);
        ::log(logMsg);
    } else {
        webviewHTMLContent.erase(webviewId);
        char logMsg[256];
        sprintf_s(logMsg, "setWebviewHTMLContent: Cleared HTML for webview %u", webviewId);
        ::log(logMsg);
    }
}

extern "C" ELECTROBUN_EXPORT const char* getWebviewHTMLContent(uint32_t webviewId) {
    std::lock_guard<std::mutex> lock(webviewHTMLMutex);
    auto it = webviewHTMLContent.find(webviewId);
    if (it != webviewHTMLContent.end()) {
        char* result = _strdup(it->second.c_str());
        char logMsg[256];
        sprintf_s(logMsg, "getWebviewHTMLContent: Retrieved HTML for webview %u", webviewId);
        ::log(logMsg);
        return result;
    } else {
        char logMsg[256];
        sprintf_s(logMsg, "getWebviewHTMLContent: No HTML found for webview %u", webviewId);
        ::log(logMsg);
        return nullptr;
    }
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
                
                
                
                // Check if this is a views:// URL
                if (wUri.find(L"views://") == 0) {
                    handleViewsSchemeRequest(args, wUri, webviewId);
                }
                
                CoTaskMemFree(uri);
                return S_OK;
            }).Get(), 
        &resourceToken);
    
    if (FAILED(hr)) {
        char errorMsg[256];
        sprintf_s(errorMsg, "Failed to add WebResourceRequested handler: 0x%lx", hr);
        ::log(errorMsg);
        return;
    }
    
    // Add filter for views:// scheme
    hr = webview->AddWebResourceRequestedFilter(L"views://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    if (FAILED(hr)) {
        char errorMsg[256];
        sprintf_s(errorMsg, "Failed to add resource filter for views://: 0x%lx", hr);
        ::log(errorMsg);
    } else {
    }
}

// Updated function to handle views:// scheme requests
void handleViewsSchemeRequest(ICoreWebView2WebResourceRequestedEventArgs* args, 
                             const std::wstring& uri, 
                             uint32_t webviewId) {
    
    
    // Convert URI to std::string for processing
    int size = WideCharToMultiByte(CP_UTF8, 0, uri.c_str(), -1, NULL, 0, NULL, NULL);
    std::string uriStr(size - 1, 0);
    WideCharToMultiByte(CP_UTF8, 0, uri.c_str(), -1, &uriStr[0], size, NULL, NULL);

    
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
        // Handle internal HTML content using stored content
        ::log("DEBUG Windows: Handling views://internal/index.html");
        const char* htmlContent = getWebviewHTMLContent(webviewId);
        if (htmlContent && strlen(htmlContent) > 0) {
            responseData = std::string(htmlContent);
            free((void*)htmlContent); // Free the strdup'd memory
            ::log("DEBUG Windows: Retrieved HTML content from storage");
        } else {
            responseData = "<html><body><h1>No content set</h1></body></html>";
            ::log("DEBUG Windows: No HTML content found, using fallback");
        }
        mimeType = "text/html";
    } else {
        // Handle other file requests
        responseData = loadViewsFile(path);
        mimeType = getMimeTypeForFile(path);
        
        if (responseData.empty()) {
            responseData = "<html><body><h1>404 - Views file not found</h1><p>Path: " + path + "</p></body></html>";
            mimeType = "text/html";
            ::log("Views file not found, returning 404");
        }
    }
    
    // sprintf_s(logMsg, "Response data length: %zu bytes, MIME type: %s", responseData.length(), mimeType.c_str());
    // log(logMsg);
    
    // Create the response using the global environment
    if (!g_environment) {
        ::log("ERROR: No global environment available for creating response");
        return;
    }
    
    try {
        // Create memory stream first
        ComPtr<IStream> stream;
        HGLOBAL hGlobal = GlobalAlloc(GMEM_MOVEABLE, responseData.length());
        if (!hGlobal) {
            ::log("ERROR: Failed to allocate global memory");
            return;
        }
        
        void* pData = GlobalLock(hGlobal);
        if (!pData) {
            GlobalFree(hGlobal);
            ::log("ERROR: Failed to lock global memory");
            return;
        }
        
        memcpy(pData, responseData.c_str(), responseData.length());
        GlobalUnlock(hGlobal);
        
        HRESULT streamResult = CreateStreamOnHGlobal(hGlobal, TRUE, &stream);
        if (FAILED(streamResult)) {
            GlobalFree(hGlobal);
            ::log("ERROR: Failed to create stream on global");
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
            ::log("ERROR: Failed to create web resource response");
            return;
        }
        
        // Set the response
        HRESULT setResult = args->put_Response(response.Get());
        if (FAILED(setResult)) {
            ::log("ERROR: Failed to set response");
            return;
        }
        
        
    } catch (...) {
        ::log("ERROR: Exception occurred while creating response");
    }
}

// Helper functions
std::string loadViewsFile(const std::string& path) {
    // Get the current working directory instead of executable directory
    char currentDir[MAX_PATH];
    DWORD result = GetCurrentDirectoryA(MAX_PATH, currentDir);
    
    if (result == 0 || result > MAX_PATH) {
        ::log("ERROR: Failed to get current working directory");
        return "";
    }
    
    // Build full path to views file from current working directory
    std::string fullPath = std::string(currentDir) + "\\..\\Resources\\app\\views\\" + path;
    
    
    // Try to read the file
    std::ifstream file(fullPath, std::ios::binary);
    if (!file.is_open()) {
        ::log("ERROR: Could not open views file");
        return "";
    }
    
    // Read file contents
    std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    file.close();
    
    return content;
}

// Shared MIME type detection function
// Based on Bun runtime supported file types and web development standards
std::string getMimeTypeForFile(const std::string& path) {
    // Web/Code Files (Bun native support)
    if (path.find(".html") != std::string::npos || path.find(".htm") != std::string::npos) {
        return "text/html";
    } else if (path.find(".js") != std::string::npos || path.find(".mjs") != std::string::npos || path.find(".cjs") != std::string::npos) {
        return "text/javascript";
    } else if (path.find(".ts") != std::string::npos || path.find(".mts") != std::string::npos || path.find(".cts") != std::string::npos) {
        return "text/typescript";
    } else if (path.find(".jsx") != std::string::npos) {
        return "text/jsx";
    } else if (path.find(".tsx") != std::string::npos) {
        return "text/tsx";
    } else if (path.find(".css") != std::string::npos) {
        return "text/css";
    } else if (path.find(".json") != std::string::npos) {
        return "application/json";
    } else if (path.find(".xml") != std::string::npos) {
        return "application/xml";
    } else if (path.find(".md") != std::string::npos) {
        return "text/markdown";
    } else if (path.find(".txt") != std::string::npos) {
        return "text/plain";
    } else if (path.find(".toml") != std::string::npos) {
        return "application/toml";
    } else if (path.find(".yaml") != std::string::npos || path.find(".yml") != std::string::npos) {
        return "application/x-yaml";
    
    // Image Files
    } else if (path.find(".png") != std::string::npos) {
        return "image/png";
    } else if (path.find(".jpg") != std::string::npos || path.find(".jpeg") != std::string::npos) {
        return "image/jpeg";
    } else if (path.find(".gif") != std::string::npos) {
        return "image/gif";
    } else if (path.find(".webp") != std::string::npos) {
        return "image/webp";
    } else if (path.find(".svg") != std::string::npos) {
        return "image/svg+xml";
    } else if (path.find(".ico") != std::string::npos) {
        return "image/x-icon";
    } else if (path.find(".avif") != std::string::npos) {
        return "image/avif";
    
    // Font Files
    } else if (path.find(".woff") != std::string::npos) {
        return "font/woff";
    } else if (path.find(".woff2") != std::string::npos) {
        return "font/woff2";
    } else if (path.find(".ttf") != std::string::npos) {
        return "font/ttf";
    } else if (path.find(".otf") != std::string::npos) {
        return "font/otf";
    
    // Media Files
    } else if (path.find(".mp3") != std::string::npos) {
        return "audio/mpeg";
    } else if (path.find(".mp4") != std::string::npos) {
        return "video/mp4";
    } else if (path.find(".webm") != std::string::npos) {
        return "video/webm";
    } else if (path.find(".ogg") != std::string::npos) {
        return "audio/ogg";
    } else if (path.find(".wav") != std::string::npos) {
        return "audio/wav";
    
    // Document Files
    } else if (path.find(".pdf") != std::string::npos) {
        return "application/pdf";
    
    // WebAssembly (Bun support)
    } else if (path.find(".wasm") != std::string::npos) {
        return "application/wasm";
    
    // Compressed Files
    } else if (path.find(".zip") != std::string::npos) {
        return "application/zip";
    } else if (path.find(".gz") != std::string::npos) {
        return "application/gzip";
    }
    
    return "application/octet-stream"; // default
}
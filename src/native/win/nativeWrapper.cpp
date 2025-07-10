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
#include <dcomp.h>     // For DirectComposition
#include <d2d1.h>      // For Direct2D
#include <direct.h>    // For _getcwd

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
        std::cout << "[CEF] LoadStart: Navigation started" << std::endl;
        
        // Execute preload scripts immediately at load start for main frame
        if (frame->IsMain()) {
            int browserId = browser->GetIdentifier();
            auto scriptIt = g_preloadScripts.find(browserId);
            if (scriptIt != g_preloadScripts.end() && !scriptIt->second.empty()) {
                // Execute with very high priority and immediate execution
                frame->ExecuteJavaScript(scriptIt->second, "", 0);
                std::cout << "[CEF] Executed preload scripts at load start for browser " << browserId << std::endl;
            }
        }
    }
    
    void OnLoadEnd(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, int httpStatusCode) override {
        std::cout << "[CEF] LoadEnd: Navigation completed with status " << httpStatusCode << std::endl;
        
        // Script injection now handled by response filter during HTML parsing
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
        std::cout << "[CEF] *** OnAfterCreated callback triggered! ***" << std::endl;
        std::cout << "[CEF] OnAfterCreated: Browser ID " << browser->GetIdentifier() << " created successfully" << std::endl;
        
        // Track browser creation
        g_cefBrowsers[browser->GetIdentifier()] = browser;
        g_browser_count++;
        std::cout << "[CEF] Total browsers: " << g_browser_count << std::endl;
        
        // Get the window handle and look up pending URL
        HWND browserWindow = browser->GetHost()->GetWindowHandle();
        HWND parentWindow = GetParent(browserWindow);
        
        std::cout << "[CEF] Browser window: " << browserWindow << ", parent: " << parentWindow << std::endl;
        
        // Set browser on the CEF client for script execution
        std::cout << "[CEF] Looking for client with parentWindow: " << parentWindow << std::endl;
        auto clientIt = g_cefClients.find(parentWindow);
        if (clientIt != g_cefClients.end()) {
            auto client = clientIt->second;
            if (client) {
                // Store browser-client pair for later processing
                // We'll call SetBrowser after the full class definition
                SetBrowserOnClient(client, browser);
                std::cout << "[CEF] Connected browser to client for script execution" << std::endl;
            } else {
                std::cout << "[CEF] Found client entry but client is null" << std::endl;
            }
        } else {
            std::cout << "[CEF] No client found for parentWindow: " << parentWindow << std::endl;
            std::cout << "[CEF] Available client windows: ";
            for (auto& pair : g_cefClients) {
                std::cout << pair.first << " ";
            }
            std::cout << std::endl;
        }
        
        // Set browser on the CEFView for direct JavaScript execution
        // Note: CEFView casting will be handled in a helper function defined after class declaration
        SetBrowserOnCEFView(parentWindow, browser);
        
        // Look for pending URL using parent window
        auto it = g_pendingUrls.find(parentWindow);
        if (it != g_pendingUrls.end()) {
            std::string target_url = it->second;
            std::cout << "[CEF] Found pending URL: " << target_url << std::endl;
            
            // Navigate to the target URL
            browser->GetMainFrame()->LoadURL(CefString(target_url));
            std::cout << "[CEF] Navigation initiated to: " << target_url << std::endl;
            
            // Clean up
            g_pendingUrls.erase(it);
        } else {
            std::cout << "[CEF] No pending URL found for parent window: " << parentWindow << std::endl;
        }
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
        std::string combined_script = electrobun_script_;
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
            std::cout << "[CEF] Stored preload scripts for browser " << browser->GetIdentifier() << " (length: " << script.length() << ")" << std::endl;
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
class BridgeHandler : public IUnknown {
private:
    long m_refCount;
    HandlePostMessage m_callback;
    uint32_t m_webviewId;
    std::string m_bridgeName;

public:
    BridgeHandler(const std::string& bridgeName, HandlePostMessage callback, uint32_t webviewId) 
        : m_refCount(1), m_callback(callback), m_webviewId(webviewId), m_bridgeName(bridgeName) {
        char logMsg[256];
        sprintf_s(logMsg, "Created %s bridge handler for webview %u", bridgeName.c_str(), webviewId);
        ::log(logMsg);
    }

    // IUnknown implementation
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
        if (riid == IID_IUnknown) {
            *ppvObject = static_cast<IUnknown*>(this);
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
    
public:
    std::string pendingUrl;
    std::string electrobunScript;
    std::string customScript;
    bool isCreationComplete = false;
    
    WebView2View(uint32_t webviewId) {
        this->webviewId = webviewId;
    }
    
    // Setter methods for COM objects (called from async creation callbacks)
    void setController(ComPtr<ICoreWebView2Controller> ctrl) {
        controller = ctrl;
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
        ::log("WebView2: evaluateJavaScriptWithNoCompletion called");
        if (webview) {
            ::log("WebView2: webview is valid, executing JavaScript");
            // Copy string to avoid lifetime issues in lambda
            std::string jsStringCopy = jsString;
            MainThreadDispatcher::dispatch_sync([this, jsStringCopy]() {
                ::log("WebView2: Main thread dispatch executing JavaScript");
                std::wstring js = std::wstring(jsStringCopy.begin(), jsStringCopy.end());
                HRESULT hr = webview->ExecuteScript(js.c_str(), nullptr);
                if (FAILED(hr)) {
                    char logMsg[256];
                    sprintf_s(logMsg, "WebView2: ExecuteScript failed with HRESULT: 0x%08lX", hr);
                    ::log(logMsg);
                } else {
                    ::log("WebView2: ExecuteScript succeeded");
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
            controller->put_Bounds(frame);
            visualBounds = frame;
            if (masksJson) {
                maskJSON = masksJson;
            }
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
            return;
        }
        
        if (maskJSON.empty()) {
            removeMasks();
            return;
        }
        
        // Get the webview's bounds
        RECT bounds;
        controller->get_Bounds(&bounds);
        int width = bounds.right - bounds.left;
        int height = bounds.bottom - bounds.top;
        
        // Create base region covering entire webview
        HRGN baseRegion = CreateRectRgn(0, 0, width, height);
        if (!baseRegion) {
            ::log("applyVisualMask: Failed to create base region");
            return;
        }
        
        // Parse maskJSON and subtract mask regions
        size_t pos = 0;
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
                
                // Create mask region and subtract from base
                HRGN maskRegion = CreateRectRgn(x, y, x + width, y + height);
                if (maskRegion) {
                    CombineRgn(baseRegion, baseRegion, maskRegion, RGN_DIFF);
                    DeleteObject(maskRegion);
                }
                
                pos = hEnd;
            } catch (const std::exception& e) {
                pos++;
            }
        }
        
        // Apply visual mask via CSS injection (more reliable for WebView2)
        injectMaskCSS();
        DeleteObject(baseRegion);
    }
    
    void removeMasks() override {
        if (!webview) {
            return;
        }
        
        // Remove CSS masks via JavaScript
        std::string script = 
            "(function() { "
            "  var oldStyle = document.getElementById('electrobun-masks'); "
            "  if (oldStyle) oldStyle.remove(); "
            "  var oldMasks = document.querySelectorAll('[class*=\"electrobun-mask-\"]'); "
            "  oldMasks.forEach(m => m.remove()); "
            "})();";
        
        std::wstring wScript(script.begin(), script.end());
        webview->ExecuteScript(wScript.c_str(), nullptr);
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

private:
    // WebView2-specific helper for CSS mask injection
    void injectMaskCSS() {
        if (!webview || maskJSON.empty()) {
            return;
        }
        
        // Build CSS for mask overlays
        std::string css = "<style id='electrobun-masks'>";
        
        size_t pos = 0;
        int maskIndex = 0;
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
                
                // Add CSS for this mask
                css += ".electrobun-mask-" + std::to_string(maskIndex) + " { ";
                css += "position: fixed; ";
                css += "left: " + std::to_string(x) + "px; ";
                css += "top: " + std::to_string(y) + "px; ";
                css += "width: " + std::to_string(width) + "px; ";
                css += "height: " + std::to_string(height) + "px; ";
                css += "background: transparent; ";
                css += "pointer-events: none; ";
                css += "z-index: 999999; ";
                css += "} ";
                
                maskIndex++;
                pos = hEnd;
            } catch (...) {
                pos++;
            }
        }
        
        css += "</style>";
        
        // Build JavaScript to inject the CSS and create mask elements
        std::string script = 
            "(function() { "
            "  var oldStyle = document.getElementById('electrobun-masks'); "
            "  if (oldStyle) oldStyle.remove(); "
            "  var oldMasks = document.querySelectorAll('[class*=\"electrobun-mask-\"]'); "
            "  oldMasks.forEach(m => m.remove()); "
            "  document.head.insertAdjacentHTML('beforeend', '" + css + "'); "
            "  for (var i = 0; i < " + std::to_string(maskIndex) + "; i++) { "
            "    var mask = document.createElement('div'); "
            "    mask.className = 'electrobun-mask-' + i; "
            "    document.body.appendChild(mask); "
            "  } "
            "})();";
        
        std::wstring wScript(script.begin(), script.end());
        webview->ExecuteScript(wScript.c_str(), nullptr);
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
        ::log("CEF: evaluateJavaScriptWithNoCompletion called");
        if (browser) {
            ::log("CEF: browser is valid, executing JavaScript");
            // Copy string to avoid lifetime issues in lambda
            std::string jsStringCopy = jsString;
            MainThreadDispatcher::dispatch_sync([this, jsStringCopy]() {
                ::log("CEF: Main thread dispatch executing JavaScript");
                browser->GetMainFrame()->ExecuteJavaScript(jsStringCopy.c_str(), "", 0);
                ::log("CEF: ExecuteJavaScript completed");
            });
        } else {
            ::log("CEF: browser is NULL, cannot execute JavaScript");
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
            browser->GetHost()->WasResized();
            visualBounds = frame;
            if (masksJson) {
                maskJSON = masksJson;
            }
        }
    }
    
    // CEF-specific implementation of mask functionality
    void applyVisualMask() override {
        // CEF mask implementation - stub for now
        // This would require CEF-specific masking logic
    }
    
    void removeMasks() override {
        // CEF mask removal - stub for now
        // This would require CEF-specific masking logic
    }
    
    void toggleMirrorMode(bool enable) override {
        if (enable && !mirrorModeEnabled) {
            mirrorModeEnabled = true;
            // CEF-specific input disabling
        } else if (!enable && mirrorModeEnabled) {
            mirrorModeEnabled = false;
            // CEF-specific input enabling
        }
    }
};

// Helper function to set browser on CEFView (defined after CEFView class)
void SetBrowserOnCEFView(HWND parentWindow, CefRefPtr<CefBrowser> browser) {
    std::cout << "[CEF] Looking for CEFView with parentWindow: " << parentWindow << std::endl;
    auto viewIt = g_cefViews.find(parentWindow);
    if (viewIt != g_cefViews.end()) {
        auto view = static_cast<CEFView*>(viewIt->second);
        if (view) {
            view->setBrowser(browser);
            std::cout << "[CEF] Set browser on CEFView for webview ID: " << view->webviewId << std::endl;
        } else {
            std::cout << "[CEF] Found CEFView entry but view is null" << std::endl;
        }
    } else {
        std::cout << "[CEF] No CEFView found for parentWindow: " << parentWindow << std::endl;
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
                if (webview2 && webview2->getController()) {
                    webview2->getController()->get_Bounds(&viewBounds);
                    
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
            sprintf_s(successMsg, "Container window setup completed: HWND=%p", m_hwnd);
            ::log(successMsg);
        }
    }

    void ContainerView::ResizeAutoSizingViews(int width, int height) {
        for (auto& view : m_abstractViews) {
            if (view->fullSize) {
                // Resize the webview to match container
                RECT bounds = {0, 0, width, height};
                view->resize(bounds, nullptr);
                
                char logMsg[256];
                sprintf_s(logMsg, "Resized auto-sizing WebView %u to %dx%d", 
                        view->webviewId, width, height);
                ::log(logMsg);
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
            
            // Now bring the actual WebView2 child window to front
            BringWebView2ChildWindowToFront(view.get());
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
        
        // Start new webviews in mirror mode (input disabled)
        // They will be made interactive when mouse hovers over them
        view->toggleMirrorMode(true);
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
    
    log("Using existing container for window");
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
        
        char logMsg[256];
        sprintf_s(logMsg, "Application menu action: %s", action.c_str());
        ::log(logMsg);
        
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
        char logMsg[256];
        sprintf_s(logMsg, "Setting accelerator for menu item %u: key=%u, modifiers=%u", menuId, key, modifiers);
        ::log(logMsg);
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


















ELECTROBUN_EXPORT bool initCEF() {
    if (g_cef_initialized) {
        return true; // Already initialized
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
    
    // Enable debug logging for more verbose output
    settings.log_severity = LOGSEVERITY_VERBOSE;
    CefString(&settings.log_file) = std::string(exePath) + "\\cef_debug.log";
    
    // Debug logging to see actual paths
    log(("CEF executable path: " + std::string(exePath)).c_str());
    log(("CEF resource dir: " + cefResourceDir).c_str());
    log(("CEF locales dir: " + cefResourceDir + "\\Resources\\locales").c_str());
    log(("CEF cache dir: " + userDataDir).c_str());
    
    bool success = CefInitialize(main_args, settings, g_cef_app.get(), nullptr);
    if (success) {
        g_cef_initialized = true;
        ::log("CEF initialized successfully");
        
        // Register the views:// scheme handler factory
        CefRegisterSchemeHandlerFactory("views", "", new ElectrobunSchemeHandlerFactory());
        ::log("Registered views:// scheme handler factory");
        
        // We'll start the message pump timer when we create the first browser
        std::cout << "[CEF] CEF initialized, message pump will start with first browser" << std::endl;
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
        auto view = std::make_shared<WebView2View>(webviewId);
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
    std::cout << "[WebView2] createWebView2View called with URL: " << (url ? url : "NULL") << std::endl;
    std::cout << "[WebView2] Electrobun script length: " << electrobunScript.length() << std::endl;
    std::cout << "[WebView2] Custom script length: " << customScript.length() << std::endl;
    
    auto view = std::make_shared<WebView2View>(webviewId);
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
        ::log("[WebView2] COM initialized successfully");
        
        // Get or create container
        auto container = GetOrCreateContainer(hwnd);
        if (!container) {
            ::log("ERROR: Failed to create container");
            return;
        }
        
        HWND containerHwnd = container->GetHwnd();
        char debugMsg[256];
        sprintf_s(debugMsg, "[WebView2] Creating controller for container HWND: %p, parent HWND: %p", containerHwnd, hwnd);
        ::log(debugMsg);
        
        // Verify the container window is valid
        if (!IsWindow(containerHwnd)) {
            ::log("ERROR: Container window handle is invalid");
            return;
        }
        
        // Get window info for debugging
        RECT windowRect;
        GetWindowRect(containerHwnd, &windowRect);
        DWORD windowStyle = GetWindowLong(containerHwnd, GWL_STYLE);
        char windowDebug[512];
        sprintf_s(windowDebug, "[WebView2] Container window - Rect: (%d,%d,%d,%d), Style: 0x%08X", 
                 windowRect.left, windowRect.top, windowRect.right, windowRect.bottom, windowStyle);
        ::log(windowDebug);
        
        // Make sure the window is visible (WebView2 requirement)
        ShowWindow(containerHwnd, SW_SHOW);
        UpdateWindow(containerHwnd);
        
        // Create WebView2 environment
        // Store values to avoid complex object captures in lambda
        uint32_t webviewId = view->webviewId;
        HWND parentHwnd = hwnd;
        
        auto environmentCompletedHandler = Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [view, container, x, y, width, height](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                ::log("[WebView2] Environment creation callback executed");
                if (FAILED(result)) {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "ERROR: Failed to create WebView2 environment, HRESULT: 0x%08X", result);
                    ::log(errorMsg);
                    view->setCreationFailed(true);
                    return result;
                }
                ::log("[WebView2] Environment created successfully - starting controller creation");
                
                // Create WebView2 controller - MINIMAL VERSION
                HWND targetHwnd = container->GetHwnd();
                char controllerDebug[256];
                sprintf_s(controllerDebug, "[WebView2] Target HWND for controller: %p", targetHwnd);
                ::log(controllerDebug);
                
                if (!IsWindow(targetHwnd)) {
                    ::log("ERROR: Target window is no longer valid");
                    view->setCreationFailed(true);
                    return S_OK;
                }
                
                ::log("[WebView2] About to create controller...");
                return env->CreateCoreWebView2Controller(targetHwnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [view, container, x, y, width, height, env](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                            ::log("[WebView2] Controller creation callback executed");
                            if (FAILED(result)) {
                                char errorMsg[256];
                                sprintf_s(errorMsg, "ERROR: Failed to create WebView2 controller, HRESULT: 0x%08X", result);
                                ::log(errorMsg);
                                view->setCreationFailed(true);
                                return result;
                            }
                            
                            ::log("[WebView2] Controller created successfully - minimal setup");
                            
                            // Minimal controller setup
                            ComPtr<ICoreWebView2Controller> ctrl(controller);
                            ComPtr<ICoreWebView2> webview;
                            ctrl->get_CoreWebView2(&webview);
                            view->setController(ctrl);
                            view->setWebView(webview);
                            
                            // Set bounds
                            RECT bounds = {(LONG)x, (LONG)y, (LONG)(x + width), (LONG)(y + height)};
                            ctrl->put_Bounds(bounds);
                            
                            // Add views:// scheme support - TEST ADDITION
                            ::log("[WebView2] Adding views:// scheme support");
                            webview->AddWebResourceRequestedFilter(L"views://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
                            
                            // Set up WebResourceRequested event handler for views:// scheme
                            webview->add_WebResourceRequested(
                                Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                                    [env](ICoreWebView2* sender, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                                        ::log("[WebView2] WebResourceRequested event triggered");
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
                                        
                                        ::log("[WebView2] Request URI converted successfully");
                                        
                                        if (uriStr.substr(0, 8) == "views://") {
                                            std::string filePath = uriStr.substr(8);
                                            std::string content = loadViewsFile(filePath);
                                            
                                            if (!content.empty()) {
                                                ::log("[WebView2] Loaded views file content, creating response");
                                                
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
                                                ::log("[WebView2] Successfully served views:// file");
                                            }
                                        }
                                        
                                        CoTaskMemFree(uri);
                                        return S_OK;
                                    }).Get(),
                                nullptr);
                            
                            ::log("[WebView2] Added views:// scheme support");
                            
                            // Add preload scripts - TEST ADDITION
                            ::log("[WebView2] Adding preload scripts");
                            std::string combinedScript;
                            if (!view->electrobunScript.empty()) {
                                combinedScript += view->electrobunScript;
                                ::log("[WebView2] Added electrobun preload script");
                            }
                            if (!view->customScript.empty()) {
                                if (!combinedScript.empty()) {
                                    combinedScript += "\n";
                                }
                                combinedScript += view->customScript;
                                ::log("[WebView2] Added custom preload script");
                            }
                            
                            if (!combinedScript.empty()) {
                                ::log("[WebView2] Converting script to wide string");
                                std::wstring wScript(combinedScript.begin(), combinedScript.end());
                                
                                std::string debugScript = "console.log('[WebView2] Preload script executing at:', location.href); console.log('[WebView2] About to execute electrobun preload'); " + combinedScript + "; console.log('[WebView2] Electrobun preload script completed');";
                                std::wstring wDebugScript(debugScript.begin(), debugScript.end());
                                
                                ::log("[WebView2] Adding script to execute on document created");
                                webview->AddScriptToExecuteOnDocumentCreated(wDebugScript.c_str(), nullptr);
                                
                                ::log("[WebView2] Adding navigation event handler");
                                webview->add_NavigationStarting(
                                    Callback<ICoreWebView2NavigationStartingEventHandler>(
                                        [debugScript](ICoreWebView2* sender, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                                            ::log("[WebView2] Navigation starting, injecting preload script early");
                                            std::wstring wDebugScript(debugScript.begin(), debugScript.end());
                                            sender->ExecuteScript(wDebugScript.c_str(), nullptr);
                                            return S_OK;
                                        }).Get(),
                                    nullptr);
                                ::log("[WebView2] Added navigation event handler for early script injection");
                            } else {
                                ::log("[WebView2] No preload scripts to add");
                            }
                            
                            // Navigate to URL
                            if (!view->pendingUrl.empty()) {
                                ::log("[WebView2] Navigating to pending URL");
                                view->loadURL(view->pendingUrl.c_str());
                            }
                            
                            view->setCreationComplete(true);
                            container->AddAbstractView(view);
                            
                            // Store WebView2View in global map for JavaScript execution
                            HWND containerHwnd = container->GetHwnd();
                            g_webview2Views[containerHwnd] = view.get();
                            ::log("[WebView2] Stored WebView2View for container hwnd");
                            
                            ::log("[WebView2] Minimal controller setup completed successfully");
                            
                            return S_OK;
                        }).Get());
            });
        
        /*
        // COMMENTED OUT: Original complex callback - uncomment to restore
        auto environmentCompletedHandler_ORIGINAL = Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [view, container, x, y, width, height](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                if (FAILED(result)) {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "ERROR: Failed to create WebView2 environment, HRESULT: 0x%08X", result);
                    ::log(errorMsg);
                    // Mark view as failed
                    view->setCreationFailed(true);
                    return result;
                }
                
                // Create WebView2 controller
                ::log("[WebView2] Creating WebView2 controller...");
                HWND targetHwnd = container->GetHwnd();
                char controllerDebug[256];
                sprintf_s(controllerDebug, "[WebView2] Target HWND for controller: %p", targetHwnd);
                ::log(controllerDebug);
                
                // Verify window is still valid before creating controller
                if (!IsWindow(targetHwnd)) {
                    ::log("ERROR: Target window is no longer valid");
                    view->setCreationFailed(true);
                    return S_OK;
                }
                
                // Additional window state validation
                if (!IsWindowVisible(targetHwnd)) {
                    ::log("WARNING: Target window is not visible");
                }
                
                DWORD windowStyle = GetWindowLong(targetHwnd, GWL_STYLE);
                char windowStateDebug[512];
                sprintf_s(windowStateDebug, "[WebView2] Window state - Style: 0x%08X, Visible: %s, Enabled: %s", 
                         windowStyle, IsWindowVisible(targetHwnd) ? "Yes" : "No", IsWindowEnabled(targetHwnd) ? "Yes" : "No");
                ::log(windowStateDebug);
                
                return env->CreateCoreWebView2Controller(targetHwnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [view, container, x, y, width, height, env](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                            if (FAILED(result)) {
                                char errorMsg[512];
                                const char* errorDescription = "";
                                switch (result) {
                                    case 0x80004004: errorDescription = "E_ABORT - Operation was aborted"; break;
                                    case 0x80070005: errorDescription = "E_ACCESSDENIED - Access denied"; break;
                                    case 0x8007000E: errorDescription = "E_OUTOFMEMORY - Out of memory"; break;
                                    case 0x80004005: errorDescription = "E_FAIL - Unspecified failure"; break;
                                    case 0x80070057: errorDescription = "E_INVALIDARG - Invalid argument"; break;
                                    default: errorDescription = "Unknown error"; break;
                                }
                                sprintf_s(errorMsg, "ERROR: Failed to create WebView2 controller, HRESULT: 0x%08X (%s)", result, errorDescription);
                                ::log(errorMsg);
                                
                                // Check if target window is still valid when the callback executes
                                HWND callbackTargetHwnd = container->GetHwnd();
                                char windowCheckMsg[256];
                                sprintf_s(windowCheckMsg, "[WebView2] Window state in callback - HWND: %p, Valid: %s, Visible: %s", 
                                         callbackTargetHwnd, IsWindow(callbackTargetHwnd) ? "Yes" : "No", 
                                         IsWindowVisible(callbackTargetHwnd) ? "Yes" : "No");
                                ::log(windowCheckMsg);
                                
                                // Mark view as failed
                                view->setCreationFailed(true);
                                return result;
                            }
                            
                            // Set up WebView2 controller and core
                            ComPtr<ICoreWebView2Controller> ctrl(controller);
                            ComPtr<ICoreWebView2> webview;
                            
                            ctrl->get_CoreWebView2(&webview);
                            view->setController(ctrl);
                            view->setWebView(webview);
                            
                            std::cout << "[WebView2] Successfully created WebView2 controller and core webview" << std::endl;
                            
                            // Set bounds
                            RECT bounds = {(LONG)x, (LONG)y, (LONG)(x + width), (LONG)(y + height)};
                            ctrl->put_Bounds(bounds);
                            
                            // Add preload scripts using scripts stored in view object
                            std::string combinedScript;
                            if (!view->electrobunScript.empty()) {
                                combinedScript += view->electrobunScript;
                                std::cout << "[WebView2] Added electrobun preload script (length: " << view->electrobunScript.length() << ")" << std::endl;
                            }
                            if (!view->customScript.empty()) {
                                if (!combinedScript.empty()) {
                                    combinedScript += "\n";
                                }
                                combinedScript += view->customScript;
                                std::cout << "[WebView2] Added custom preload script (length: " << view->customScript.length() << ")" << std::endl;
                            }
                            
                            if (!combinedScript.empty()) {
                                std::wstring wScript(combinedScript.begin(), combinedScript.end());
                                
                                // Add some debug logging to the script itself
                                std::string debugScript = "console.log('[WebView2] Preload script executing at:', location.href); console.log('[WebView2] About to execute electrobun preload'); " + combinedScript + "; console.log('[WebView2] Electrobun preload script completed');";
                                std::wstring wDebugScript(debugScript.begin(), debugScript.end());
                                
                                // Add script to execute on document created
                                webview->AddScriptToExecuteOnDocumentCreated(wDebugScript.c_str(), nullptr);
                                std::cout << "[WebView2] Added combined preload script to execute on document created (length: " << debugScript.length() << ")" << std::endl;
                                
                                // Also add navigation event handler to inject script early
                                webview->add_NavigationStarting(
                                    Callback<ICoreWebView2NavigationStartingEventHandler>(
                                        [debugScript](ICoreWebView2* sender, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                                            std::cout << "[WebView2] Navigation starting, injecting preload script early" << std::endl;
                                            std::wstring wDebugScript(debugScript.begin(), debugScript.end());
                                            sender->ExecuteScript(wDebugScript.c_str(), nullptr);
                                            return S_OK;
                                        }).Get(),
                                    nullptr);
                                std::cout << "[WebView2] Added navigation event handler for early script injection" << std::endl;
                            } else {
                                std::cout << "[WebView2] No preload scripts to add" << std::endl;
                            }
                            
                            // Add views:// scheme support for WebView2
                            webview->AddWebResourceRequestedFilter(L"views://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
                            
                            // Set up WebResourceRequested event handler for views:// scheme
                            webview->add_WebResourceRequested(
                                Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                                    [env](ICoreWebView2* sender, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                                        std::cout << "[WebView2] WebResourceRequested event triggered!" << std::endl;
                                        ComPtr<ICoreWebView2WebResourceRequest> request;
                                        args->get_Request(&request);
                                        
                                        LPWSTR uri;
                                        request->get_Uri(&uri);
                                        
                                        std::wstring wUri(uri);
                                        std::string uriStr;
                                        int size = WideCharToMultiByte(CP_UTF8, 0, uri, -1, nullptr, 0, nullptr, nullptr);
                                        if (size > 0) {
                                            uriStr.resize(size - 1);
                                            WideCharToMultiByte(CP_UTF8, 0, uri, -1, &uriStr[0], size, nullptr, nullptr);
                                        }
                                        std::cout << "[WebView2] Request URI: " << uriStr << std::endl;
                                        
                                        if (uriStr.substr(0, 8) == "views://") {
                                            std::string filePath = uriStr.substr(8); // Remove "views://" prefix
                                            std::string content = loadViewsFile(filePath);
                                            
                                            if (!content.empty()) {
                                                // Create response
                                                std::string mimeType = "text/html";
                                                if (filePath.find(".js") != std::string::npos) mimeType = "application/javascript";
                                                else if (filePath.find(".css") != std::string::npos) mimeType = "text/css";
                                                else if (filePath.find(".png") != std::string::npos) mimeType = "image/png";
                                                
                                                std::wstring wMimeType(mimeType.begin(), mimeType.end());
                                                
                                                // Create a memory stream for the content
                                                ComPtr<IStream> contentStream;
                                                HGLOBAL hGlobal = GlobalAlloc(GMEM_MOVEABLE, content.size());
                                                if (hGlobal) {
                                                    void* pData = GlobalLock(hGlobal);
                                                    memcpy(pData, content.c_str(), content.size());
                                                    GlobalUnlock(hGlobal);
                                                    CreateStreamOnHGlobal(hGlobal, TRUE, &contentStream);
                                                }
                                                
                                                // Format headers properly
                                                std::wstring headers = L"Content-Type: " + wMimeType + L"\r\nAccess-Control-Allow-Origin: *";
                                                
                                                ComPtr<ICoreWebView2WebResourceResponse> response;
                                                env->CreateWebResourceResponse(
                                                    contentStream.Get(),
                                                    200,
                                                    L"OK",
                                                    headers.c_str(),
                                                    &response);
                                                
                                                args->put_Response(response.Get());
                                                std::cout << "[WebView2] Served views:// file: " << filePath << " (" << content.size() << " bytes)" << std::endl;
                                            }
                                        }
                                        
                                        CoTaskMemFree(uri);
                                        return S_OK;
                                    }).Get(),
                                nullptr);
                            
                            std::cout << "[WebView2] Added views:// scheme support" << std::endl;
                            
                            // Navigate to URL using the stored URL in view (avoiding lambda capture corruption)
                            std::cout << "[WebView2] About to navigate - pendingUrl: '" << view->pendingUrl << "'" << std::endl;
                            if (!view->pendingUrl.empty()) {
                                std::cout << "[WebView2] Navigating to: " << view->pendingUrl << std::endl;
                                view->loadURL(view->pendingUrl.c_str());
                            } else {
                                std::cout << "[WebView2] ERROR: pendingUrl is empty, cannot navigate" << std::endl;
                            }
                            
                            // Mark creation as complete - all setup is done
                            view->setCreationComplete(true);
                            std::cout << "[WebView2] Creation completed successfully" << std::endl;
                            
                            // Add to container
                            container->AddAbstractView(view);
                            
                            return S_OK;
                        }).Get());
            }).Get();
        */
        
        // Create WebView2 environment with custom scheme support
        try {
            auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
            options->put_AdditionalBrowserArguments(L"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --allow-insecure-localhost --disable-web-security");
            
            // Get the interface that supports custom scheme registration  
            Microsoft::WRL::ComPtr<ICoreWebView2EnvironmentOptions4> options4;
            if (SUCCEEDED(options.As(&options4))) {
                ::log("Setting up views:// custom scheme registration");
                
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
                    ::log("views:// custom scheme registration set successfully");
                } else {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "Failed to set views:// custom scheme registration: 0x%lx", schemeResult);
                    ::log(errorMsg);
                }
            } else {
                ::log("ERROR: Failed to get ICoreWebView2EnvironmentOptions4 interface for custom scheme registration");
            }
            
            ::log("[WebView2] About to call CreateCoreWebView2EnvironmentWithOptions...");
            
            HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, nullptr, options.Get(), environmentCompletedHandler.Get());
            
            ::log("[WebView2] CreateCoreWebView2EnvironmentWithOptions returned");
            
            if (FAILED(hr)) {
                char errorMsg[256];
                sprintf_s(errorMsg, "ERROR: CreateCoreWebView2EnvironmentWithOptions failed with HRESULT: 0x%08X", hr);
                ::log(errorMsg);
            } else {
                ::log("[WebView2] CreateCoreWebView2EnvironmentWithOptions succeeded");
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
        windowInfo.SetAsChild(container->GetHwnd(), {(int)x, (int)y, (int)(x + width), (int)(y + height)});
        
        CefBrowserSettings browserSettings;
        // Note: web_security setting for CEF would need correct API
        
        // Create CEF client with bridge handlers
        auto client = new ElectrobunCefClient(webviewId, bunBridgeHandler, internalBridgeHandler);
        
        // Set up preload scripts
        if (electrobunPreloadScript && strlen(electrobunPreloadScript) > 0) {
            client->AddPreloadScript(std::string(electrobunPreloadScript));
            std::cout << "[CEF] Added electrobun preload script (length: " << strlen(electrobunPreloadScript) << ")" << std::endl;
        }
        if (customPreloadScript && strlen(customPreloadScript) > 0) {
            client->UpdateCustomPreloadScript(std::string(customPreloadScript));
            std::cout << "[CEF] Added custom preload script (length: " << strlen(customPreloadScript) << ")" << std::endl;
        }
        
        // Note: Additional callback methods would need to be implemented if needed
        // client->SetNavigationCallback(navigationCallback);
        // client->SetWebviewEventHandler(webviewEventHandler);
        
        view->setClient(client);
        
        // Create browser
        bool success = CefBrowserHost::CreateBrowser(
            windowInfo, client, url ? url : "about:blank", browserSettings, nullptr, nullptr);
        
        if (success) {
            container->AddAbstractView(view);
            // Add client to global map for OnAfterCreated callback using container window handle
            HWND containerHwnd = container->GetHwnd();
            g_cefClients[containerHwnd] = client;
            std::cout << "[CEF] Stored client for container hwnd: " << containerHwnd << std::endl;
            // Add CEFView to global map for OnAfterCreated callback using container window handle  
            g_cefViews[containerHwnd] = view.get();
            std::cout << "[CEF] Stored CEFView for container hwnd: " << containerHwnd << std::endl;
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
                Sleep(3000);
                
                // If browsers didn't close properly, force quit
                if (g_browser_count > 0) {
                    std::cout << "[CEF] Browsers didn't close, forcing CEF shutdown" << std::endl;
                    CefQuitMessageLoop();
                    Sleep(1000);
                }
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
        std::cout << "[CEF] Initializing CEF for message loop" << std::endl;
        if (initCEF()) {
            std::cout << "[CEF] Starting CEF message loop" << std::endl;
            CefRunMessageLoop(); // Use CEF's message loop like macOS
            std::cout << "[CEF] CEF message loop ended, shutting down" << std::endl;
            CefShutdown();
        } else {
            std::cout << "[CEF] Failed to initialize CEF, falling back to Windows message loop" << std::endl;
            // Fall back to Windows message loop if CEF init fails
            MSG msg;
            while (GetMessage(&msg, NULL, 0, 0)) {
                TranslateMessage(&msg);
                DispatchMessage(&msg);
            }
        }
    } else {
        std::cout << "[CEF] CEF not available, using Windows message loop" << std::endl;
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
        // Use CefQuitMessageLoop() for graceful shutdown, which will trigger OnBeforeClose handlers
        CefQuitMessageLoop();
        ::log("CEF shutdown initiated");
    } else {
        // If CEF is not running, exit directly
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
    ::log("=======>>>>>> initWebview (serialized)");
    printf("[LOG] Renderer: %s\n", renderer ? renderer : "default");
    printf("[LOG] WebView geometry - x: %.2f, y: %.2f, width: %.2f, height: %.2f, autoResize: %s\n", 
       x, y, width, height, autoResize ? "true" : "false");
    
    HWND hwnd = reinterpret_cast<HWND>(window);
    
    // Factory pattern - choose implementation based on renderer  
    AbstractView* view = nullptr;
    
    if (renderer && strcmp(renderer, "cef") == 0 && isCEFAvailable()) {
        ::log("=== Creating CEF Browser ===");
        auto cefView = createCEFView(webviewId, hwnd, url, x, y, width, height, autoResize,
                                    partitionIdentifier, navigationCallback, webviewEventHandler,
                                    bunBridgeHandler, internalBridgeHandler,
                                    electrobunPreloadScript, customPreloadScript);
        view = cefView.get();
    } else {
        ::log("=== Creating WebView2 Browser ===");
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
    char logMsg[512];
    sprintf_s(logMsg, "Loading URL in WebView %u: %s", abstractView->webviewId, urlString);
    log(logMsg);
    
    abstractView->loadURL(urlString);
}

ELECTROBUN_EXPORT void webviewGoBack(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewGoBack");
        return;
    }
    
    log("Webview going back");
    abstractView->goBack();
}

ELECTROBUN_EXPORT void webviewGoForward(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewGoForward");
        return;
    }
    
    log("Webview going forward");
    abstractView->goForward();
}

ELECTROBUN_EXPORT void webviewReload(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewReload");
        return;
    }
    
    log("Webview reloading");
    abstractView->reload();
}

ELECTROBUN_EXPORT void webviewRemove(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView in webviewRemove");
        return;
    }
    
    char logMsg[256];
    sprintf_s(logMsg, "Removing WebView %u", abstractView->webviewId);
    log(logMsg);
    
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
    
    char logMsg[512];
    sprintf_s(logMsg, "Executing JavaScript in webview %u (type: %s): %.100s", 
              abstractView->webviewId, 
              (dynamic_cast<WebView2View*>(abstractView) ? "WebView2" : 
               dynamic_cast<CEFView*>(abstractView) ? "CEF" : "Unknown"),
              script);
    ::log(logMsg);
    
    abstractView->evaluateJavaScriptWithNoCompletion(script);
    
    ::log("JavaScript execution dispatched to main thread");
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
                    char logMsg[256];
                    sprintf_s(logMsg, "Applied application menu to new window: HWND=%p", hwnd);
                    ::log(logMsg);
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
        char logMsg[256];
        sprintf_s(logMsg, "Bringing window to front and activating: HWND=%p", hwnd);
        ::log(logMsg);
        
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
                    ::log("Window brought to foreground using thread input attachment");
                } else {
                    // Last resort - flash the window to get user attention
                    FLASHWINFO fwi = {0};
                    fwi.cbSize = sizeof(FLASHWINFO);
                    fwi.hwnd = hwnd;
                    fwi.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
                    fwi.uCount = 3;
                    fwi.dwTimeout = 0;
                    FlashWindowEx(&fwi);
                    
                    ::log("Could not bring window to foreground, flashed window instead");
                }
            }
        }
        
        // Ensure the window is active and focused
        SetActiveWindow(hwnd);
        SetFocus(hwnd);
        
        // Bring to top of Z-order
        SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, 
                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        
        ::log("Window activation sequence completed");
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
                    char logMsg[512];
                    sprintf_s(logMsg, "Window title set successfully: %s", title);
                    ::log(logMsg);
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
        char logMsg[256];
        sprintf_s(logMsg, "Closing window: HWND=%p", hwnd);
        ::log(logMsg);
        
        // Clean up any associated container views before closing
        auto containerIt = g_containerViews.find(hwnd);
        if (containerIt != g_containerViews.end()) {
            ::log("Cleaning up container view for window");
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
    
    log("File dialog selection: " + result);
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
                                char logMsg[256];
                                sprintf_s(logMsg, "Right click on tray item %u - showing menu", trayItem->trayId);
                                ::log(logMsg);
                                
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
                                char logMsg[256];
                                sprintf_s(logMsg, "Right click on tray item %u - no menu, calling handler", trayItem->trayId);
                                ::log(logMsg);
                                
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
        ::log("Creating system tray icon");
        
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
        
        char logMsg[256];
        sprintf_s(logMsg, "Tray window created: HWND=%p", statusItem->hwnd);
        ::log(logMsg);
        
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
            char successMsg[256];
            sprintf_s(successMsg, "System tray icon created successfully: ID=%u, HWND=%p", trayId, statusItem->hwnd);
            ::log(successMsg);
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
    
    log("setTrayMenuFromJSON");
    
    MainThreadDispatcher::dispatch_sync([=]() {
        ::log("setTrayMenuFromJSON main thread");
        
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
                        
                        char successMsg[256];
                        sprintf_s(successMsg, "Application menu applied to window: HWND=%p", mainWindow);
                        ::log(successMsg);
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
            ::log("showContextMenu: parsing JSON menu configuration");
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
            
            ::log("showContextMenu: displaying menu at cursor position");
            
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
    g_getMimeType = getMimeType;
    g_getHTMLForWebviewSync = getHTMLForWebviewSync;
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
                
                char logMsg[512];
                sprintf_s(logMsg, "Resource request intercepted: %s", uriStr.c_str());
                ::log(logMsg);
                
                // Check if this is a views:// URL
                if (wUri.find(L"views://") == 0) {
                    ::log("Processing views:// request");
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
            ::log("Calling g_getHTMLForWebviewSync...");
            const char* htmlContent = g_getHTMLForWebviewSync(webviewId);
            if (htmlContent && strlen(htmlContent) > 0) {
                responseData = std::string(htmlContent);
                sprintf_s(logMsg, "Got HTML content from JS callback: %zu bytes", responseData.length());
                ::log(logMsg);
            } else {
                responseData = "<html><body><h1>Empty HTML content from callback!</h1></body></html>";
                ::log("JS callback returned empty or null content");
            }
        } else {
            responseData = "<html><body><h1>JS callback not available</h1><p>g_getHTMLForWebviewSync is null</p></body></html>";
            ::log("JS callback (g_getHTMLForWebviewSync) is not set");
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
    
    sprintf_s(logMsg, "Response data length: %zu bytes, MIME type: %s", responseData.length(), mimeType.c_str());
    log(logMsg);
    
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
            sprintf_s(logMsg, "ERROR: Failed to create stream on global: 0x%lx", streamResult);
            ::log(logMsg);
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
            ::log(logMsg);
            return;
        }
        
        // Set the response
        HRESULT setResult = args->put_Response(response.Get());
        if (FAILED(setResult)) {
            sprintf_s(logMsg, "ERROR: Failed to set response: 0x%lx", setResult);
            ::log(logMsg);
            return;
        }
        
        ::log("Successfully created and set views:// response");
        
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
    
    char logMsg[512];
    sprintf_s(logMsg, "Attempting to load views file: %s", fullPath.c_str());
    log(logMsg);
    
    // Try to read the file
    std::ifstream file(fullPath, std::ios::binary);
    if (!file.is_open()) {
        sprintf_s(logMsg, "Could not open views file: %s", fullPath.c_str());
        ::log(logMsg);
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
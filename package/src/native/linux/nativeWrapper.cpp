#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <jsc/jsc.h>
#ifndef NO_APPINDICATOR
#include <libayatana-appindicator/app-indicator.h>
#endif
#include <gdk/gdkx.h>
#include <X11/Xlib.h>
#include <X11/extensions/shape.h>
#include <X11/Xatom.h>
#include <X11/keysymdef.h>
#include <X11/XF86keysym.h>
#include <string>
#include <vector>
#include <memory>
#include <pthread.h>
#include <map>
#include <iostream>
#include <cstring>
#include <dlfcn.h>
#include <algorithm>
#include <sstream>
#include <thread>
#include <atomic>
#include <chrono>
#include <unistd.h>
#include <functional>
#include <execinfo.h>
#include <cmath>
#include <gio/gio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <mutex>
#include <condition_variable>
#include <fstream>
#include <set>

// Shared cross-platform utilities
#include "../shared/glob_match.h"
#include "../shared/callbacks.h"
#include "../shared/permissions.h"
#include "../shared/mime_types.h"
#include "../shared/asar.h"
#include "../shared/config.h"
#include "../shared/preload_script.h"
#include "../shared/webview_storage.h"
#include "../shared/navigation_rules.h"
#include "../shared/thread_safe_map.h"
#include "../shared/shutdown_guard.h"
#include "../shared/ffi_helpers.h"
#include "../shared/json_menu_parser.h"
#include "../shared/download_event.h"

using namespace electrobun;

// Global ASAR archive handle (lazy-loaded) with thread-safe initialization
// ASAR C FFI declarations are in shared/asar.h
static AsarArchive* g_asarArchive = nullptr;
static std::once_flag g_asarArchiveInitFlag;

// Global shutdown flag to prevent race conditions during cleanup
// Note: shared/shutdown_guard.h provides ShutdownManager singleton for new code
// This local atomic is kept for direct access patterns used throughout this file
static std::atomic<bool> g_shuttingDown{false};

// Additional race condition protection
static std::atomic<int> g_activeOperations{0};
static std::mutex g_cefBrowserMutex;

// Use OperationGuard from shared/shutdown_guard.h
using electrobun::OperationGuard;

// CEF includes - always include them even if it marginally increases binary size
// we want a few binaries that will work whenever an electrobun developer
// adds CEF into their bundles
#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_load_handler.h"
#include "include/cef_request_handler.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_keyboard_handler.h"
#include "include/cef_response_filter.h"
#include "include/cef_permission_handler.h"
#include "include/cef_dialog_handler.h"
#include "include/cef_download_handler.h"
#include "include/wrapper/cef_helpers.h"

// Ensure the exported functions have appropriate visibility
#define ELECTROBUN_EXPORT __attribute__((visibility("default")))

// X11 Error Handler (non-fatal errors are common in WebKit/GTK)
static int x11_error_handler(Display* display, XErrorEvent* error) {
    // Only log severe errors, ignore common ones like BadWindow for destroyed widgets
    if (error->error_code != BadWindow && error->error_code != BadDrawable) {
        char error_text[256];
        XGetErrorText(display, error->error_code, error_text, sizeof(error_text));
        fprintf(stderr, "X11 Error: %s (code %d)\n", error_text, error->error_code);
    }
    return 0; // Continue execution
}

// Helper macros
#ifndef MAX
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#endif

// OOPIF positioning - GTK uses separate containers instead of offscreen positioning

// Forward declare callback types
typedef void (*WindowCloseCallback)(uint32_t windowId);
typedef void (*WindowMoveCallback)(uint32_t windowId, double x, double y);
typedef void (*WindowResizeCallback)(uint32_t windowId, double x, double y, double width, double height);
typedef void (*WindowFocusCallback)(uint32_t windowId);

// Forward declaration for WebKit scheme handler
static void handleViewsURIScheme(WebKitURISchemeRequest* request, gpointer user_data);

// Forward declaration for partition context management
static WebKitWebContext* getContextForPartition(const char* partitionIdentifier);


// Webview and tray callback types are defined in shared/callbacks.h
// Platform-specific alias
typedef StatusItemHandler ZigStatusItemHandler;

// Menu item structure
struct MenuItemData {
    uint32_t menuId;
    std::string action;
    std::string type;
    ZigStatusItemHandler clickHandler;
};

// Global menu item counter and storage
static uint32_t g_nextMenuId = 1;
static std::map<uint32_t, std::shared_ptr<MenuItemData>> g_menuItems;
static std::mutex g_menuItemsMutex;

// Global application menu storage
static std::string g_applicationMenuConfig;
static ZigStatusItemHandler g_applicationMenuHandler = nullptr;

// Webview content storage (replaces JSCallback approach)
static std::map<uint32_t, std::string> webviewHTMLContent;
static std::mutex webviewHTMLMutex;

// Global variables for CEF cache path isolation
static std::string g_electrobunChannel = "";
static std::string g_electrobunIdentifier = "";

// Forward declarations for HTML content management
extern "C" ELECTROBUN_EXPORT const char* getWebviewHTMLContent(uint32_t webviewId);
extern "C" ELECTROBUN_EXPORT void setWebviewHTMLContent(uint32_t webviewId, const char* htmlContent);

// MIME type detection function is in shared/mime_types.h
// Permission cache types and functions are in shared/permissions.h

// Linux-specific permission request helper
std::string getOriginFromPermissionRequest(WebKitPermissionRequest* request) {
    // For views:// scheme, use a constant origin since these are local files
    // For other schemes, you would use webkit_permission_request_get_requesting_origin() when available
    return "views://";
}

// Menu JSON structure is now defined in shared/json_menu_parser.h
// Alias for backward compatibility with existing code
using MenuJsonValue = MenuItemJson;

// Forward declarations
class ContainerView;
class CEFWebViewImpl;
std::string getExecutableDir();
GtkWidget* getContainerViewOverlay(GtkWidget* window);
GtkWidget* createMenuFromParsedItems(const std::vector<MenuJsonValue>& items, ZigStatusItemHandler clickHandler, uint32_t trayId);
GtkWidget* createApplicationMenuBar(const std::vector<MenuJsonValue>& items, ZigStatusItemHandler clickHandler);
void applyApplicationMenuToWindow(GtkWidget* window);
void initializeGTK();

// X11 Window structure to replace GTK windows
struct X11Window {
    Display* display;
    Window window;
    uint32_t windowId;
    double x, y, width, height;
    std::string title;
    WindowCloseCallback closeCallback;
    WindowMoveCallback moveCallback;
    WindowResizeCallback resizeCallback;
    WindowFocusCallback focusCallback;
    std::vector<Window> childWindows;  // For managing webviews
    ContainerView* containerView = nullptr;  // Associated container for webview management
    bool transparent = false;  // Track if window is transparent

    X11Window() : display(nullptr), window(0), windowId(0), x(0), y(0), width(800), height(600), focusCallback(nullptr), transparent(false) {}
};

// Forward declarations for icon management
static void autoSetWindowIcon(void* window);
static void setX11WindowIcon(X11Window* x11win, GdkPixbuf* pixbuf);

// Forward declaration for X11 menu function
void applyApplicationMenuToX11Window(X11Window* x11win);

// Use parseMenuJson from shared/json_menu_parser.h
using electrobun::parseMenuJson;

// Mask rectangle structure for X11 regions
struct MaskRect {
    int x, y, width, height;
};

// Parse maskJSON string into rectangles
std::vector<MaskRect> parseMaskJson(const std::string& jsonStr) {
    std::vector<MaskRect> rects;
    
    
    if (jsonStr.empty()) {
        return rects;
    }
    
    // Handle double-escaped JSON by unescaping quotes
    std::string unescapedJson = jsonStr;
    size_t pos = 0;
    while ((pos = unescapedJson.find("\\\"", pos)) != std::string::npos) {
        unescapedJson.replace(pos, 2, "\"");
        pos += 1;
    }
    
    // Simple JSON parser for rectangle arrays
    // Looking for patterns like [{"x":10,"y":20,"width":100,"height":50}]
    size_t parsePos = 0;
    while (parsePos < unescapedJson.length()) {
        size_t objStart = unescapedJson.find("{", parsePos);
        if (objStart == std::string::npos) break;
        
        size_t objEnd = unescapedJson.find("}", objStart);
        if (objEnd == std::string::npos) break;
        
        std::string obj = unescapedJson.substr(objStart, objEnd - objStart + 1);
        
        MaskRect rect = {};
        
        // Parse x
        size_t xPos = obj.find("\"x\":");
        if (xPos != std::string::npos) {
            size_t valueStart = obj.find_first_of("0123456789-", xPos + 4);
            if (valueStart != std::string::npos) {
                rect.x = atoi(obj.substr(valueStart).c_str());
            }
        }
        
        // Parse y
        size_t yPos = obj.find("\"y\":");
        if (yPos != std::string::npos) {
            size_t valueStart = obj.find_first_of("0123456789-", yPos + 4);
            if (valueStart != std::string::npos) {
                rect.y = atoi(obj.substr(valueStart).c_str());
            }
        }
        
        // Parse width
        size_t widthPos = obj.find("\"width\":");
        if (widthPos != std::string::npos) {
            size_t valueStart = obj.find_first_of("0123456789", widthPos + 8);
            if (valueStart != std::string::npos) {
                rect.width = atoi(obj.substr(valueStart).c_str());
            }
        }
        
        // Parse height
        size_t heightPos = obj.find("\"height\":");
        if (heightPos != std::string::npos) {
            size_t valueStart = obj.find_first_of("0123456789", heightPos + 9);
            if (valueStart != std::string::npos) {
                rect.height = atoi(obj.substr(valueStart).c_str());
            }
        }
        
        rects.push_back(rect);
        parsePos = objEnd + 1;
    }
    
    return rects;
}

// Check if a point is within any of the mask rectangles
bool isPointInMask(int x, int y, const std::vector<MaskRect>& masks) {
    for (const auto& mask : masks) {
        if (x >= mask.x && x < mask.x + mask.width &&
            y >= mask.y && y < mask.y + mask.height) {
            return true;
        }
    }
    return false;
}

// Note: X11 window extraction removed - WebKit now uses GTK-native input shape masking

// Forward declarations
class AbstractView;

// Helper function to check navigation rules - defined after AbstractView class
bool checkNavigationRules(std::shared_ptr<AbstractView> view, const std::string& url);

// CEF globals and implementation
static std::atomic<bool> g_cefInitialized{false};
static std::atomic<bool> g_useCEF{false};
static std::atomic<bool> g_checkedForCEF{false};

// Global webview storage to keep shared_ptr alive
static std::map<uint32_t, std::shared_ptr<AbstractView>> g_webviewMap;
static std::mutex g_webviewMapMutex;

// Global map to store preload scripts by browser ID (for multi-process CEF)
static std::map<int, std::string> g_preloadScripts;

CefRefPtr<class ElectrobunApp> g_app;


// Get the directory of the current executable
std::string getExecutableDir() {
    char path[1024];
    ssize_t len = readlink("/proc/self/exe", path, sizeof(path) - 1);
    if (len != -1) {
        path[len] = '\0';
        std::string exePath(path);
        size_t lastSlash = exePath.find_last_of('/');
        if (lastSlash != std::string::npos) {
            return exePath.substr(0, lastSlash);
        }
    }
    return "."; // fallback to current directory
}

// CEF availability check - runtime check for CEF files in app bundle
bool isCEFAvailable() {
    // Return cached result if we've already checked
    if (g_checkedForCEF) {
        return g_useCEF;
    }
    
    // Perform the check once and cache the result
    // Get the directory where the executable is located
    std::string execDir = getExecutableDir();
    
    // Check for CEF shared library in cef subdirectory (where it's bundled)
    std::string cefLibPath = execDir + "/cef/libcef.so";
   
    // Check if the CEF library file exists
    if (access(cefLibPath.c_str(), F_OK) == 0) {
        g_useCEF = true;
    } else {
        // Also check for CEF in main directory (fallback)
        cefLibPath = execDir + "/libcef.so";
        if (access(cefLibPath.c_str(), F_OK) == 0) {
            g_useCEF = true;
        } else {
            g_useCEF = false;
        }
    }
    
    // Mark that we've performed the check
    g_checkedForCEF = true;
    
    return g_useCEF;
}




// CEF Response Filter for preload script injection (Mac-style clean approach)
class ElectrobunResponseFilter : public CefResponseFilter {
private:
    std::string electrobun_script_;
    std::string custom_script_;
    std::string buffer_;
    bool has_head_;
    bool injected_;
    
public:
    ElectrobunResponseFilter(const std::string& electrobunScript, const std::string& customScript)
        : electrobun_script_(electrobunScript), 
          custom_script_(customScript),
          has_head_(false), 
          injected_(false) {}
    
    virtual bool InitFilter() override {
        return true;
    }
    
    virtual FilterStatus Filter(void* data_in, size_t data_in_size,
                               size_t& data_in_read, void* data_out,
                               size_t data_out_size, size_t& data_out_written) override {
        
        // Add incoming data to buffer
        if (data_in_size > 0) {
            buffer_.append(static_cast<const char*>(data_in), data_in_size);
        }
        data_in_read = data_in_size;
        
        // Only inject once and if we have scripts to inject
        if (!injected_ && (!electrobun_script_.empty() || !custom_script_.empty())) {
            std::string combined_script = electrobun_script_;
            if (!custom_script_.empty()) {
                combined_script += "\n" + custom_script_;
            }
            
            std::string script_tag = "<script>\n" + combined_script + "\n</script>\n";
            
            // Look for injection points in order of preference
            size_t inject_pos = std::string::npos;
            
            // 1. Try to inject after <head>
            size_t head_pos = buffer_.find("<head>");
            if (head_pos != std::string::npos) {
                inject_pos = head_pos + 6; // After <head>
                has_head_ = true;
            }
            
            // 2. Try to inject after <html> with head wrapper
            if (inject_pos == std::string::npos) {
                size_t html_pos = buffer_.find("<html");
                if (html_pos != std::string::npos) {
                    // Find the end of the <html> tag
                    size_t html_end = buffer_.find(">", html_pos);
                    if (html_end != std::string::npos) {
                        inject_pos = html_end + 1;
                        script_tag = "<head>\n" + script_tag + "</head>\n";
                    }
                }
            }
            
            // 3. Fallback: inject at beginning
            if (inject_pos == std::string::npos) {
                inject_pos = 0;
                script_tag = "<html><head>\n" + script_tag + "</head><body>\n";
            }
            
            // Inject the script
            if (inject_pos <= buffer_.size()) {
                buffer_.insert(inject_pos, script_tag);
                injected_ = true;
            }
        }
        
        // Output buffered data
        size_t copy_size = std::min(data_out_size, buffer_.size());
        if (copy_size > 0) {
            std::memcpy(data_out, buffer_.data(), copy_size);
            buffer_.erase(0, copy_size);
        }
        data_out_written = copy_size;
        
        // Return RESPONSE_FILTER_NEED_MORE_DATA if we have more data to process
        if (data_in_size > 0 || !buffer_.empty()) {
            return RESPONSE_FILTER_NEED_MORE_DATA;
        }
        
        return RESPONSE_FILTER_DONE;
    }
    
    IMPLEMENT_REFCOUNTING(ElectrobunResponseFilter);
};

// CEF views:// scheme handler implementation
class ViewsResourceHandler : public CefResourceHandler {
public:
    ViewsResourceHandler() : offset_(0) {}
    
    bool Open(CefRefPtr<CefRequest> request, bool& handle_request, CefRefPtr<CefCallback> callback) override {
        std::string url = request->GetURL();
        
        // Parse the URI to get everything after views://
        std::string fullPath = "index.html"; // default
        if (url.find("views://") == 0) {
            fullPath = url.substr(8); // Skip "views://"
        }
        
        // Check if this is the internal HTML request
        if (fullPath == "internal/index.html") {
            // Use stored HTML content instead of JSCallback
            const char* htmlContent = getWebviewHTMLContent(1); // TODO: get webviewId properly
            if (htmlContent) {
                data_ = std::string(htmlContent);
                mimeType_ = "text/html";
                free((void*)htmlContent); // Free the strdup'd memory
                handle_request = true;
                return true;
            } else {
                data_ = "<html><body>No content set</body></html>";
                mimeType_ = "text/html";
                handle_request = true;
                return true;
            }
        }
        
        // Build paths relative to current directory (bin)
        char* cwd = g_get_current_dir();
        gchar* resourcesDir = g_build_filename(cwd, "..", "Resources", nullptr);
        gchar* asarPath = g_build_filename(resourcesDir, "app.asar", nullptr);

        // Check if ASAR archive exists
        if (g_file_test(asarPath, G_FILE_TEST_EXISTS)) {
            // Thread-safe lazy-load ASAR archive on first use
            std::call_once(g_asarArchiveInitFlag, [asarPath]() {
                g_asarArchive = asar_open(asarPath);
                if (!g_asarArchive) {
                    printf("ERROR CEF loadViewsFile: Failed to open ASAR archive at %s\n", asarPath);
                }
            });

            // If ASAR archive is loaded, try to read from it
            if (g_asarArchive) {
                // The ASAR contains the entire app directory, so prepend "views/" to the path
                std::string asarFilePath = "views/" + fullPath;

                size_t fileSize = 0;
                const uint8_t* fileData = asar_read_file(g_asarArchive, asarFilePath.c_str(), &fileSize);

                if (fileData && fileSize > 0) {
                    // Create std::string that copies the buffer (we'll free it after)
                    data_ = std::string(reinterpret_cast<const char*>(fileData), fileSize);
                    // Free the ASAR buffer
                    asar_free_buffer(fileData, fileSize);

                    // Determine MIME type
                    std::string mimeType = "application/octet-stream";
                    if (fullPath.find(".html") != std::string::npos) mimeType = "text/html";
                    else if (fullPath.find(".css") != std::string::npos) mimeType = "text/css";
                    else if (fullPath.find(".js") != std::string::npos) mimeType = "text/javascript";
                    else if (fullPath.find(".json") != std::string::npos) mimeType = "application/json";
                    else if (fullPath.find(".png") != std::string::npos) mimeType = "image/png";
                    else if (fullPath.find(".jpg") != std::string::npos || fullPath.find(".jpeg") != std::string::npos) mimeType = "image/jpeg";
                    else if (fullPath.find(".svg") != std::string::npos) mimeType = "image/svg+xml";
                    else if (fullPath.find(".woff") != std::string::npos) mimeType = "font/woff";
                    else if (fullPath.find(".woff2") != std::string::npos) mimeType = "font/woff2";
                    else if (fullPath.find(".ttf") != std::string::npos) mimeType = "font/ttf";
                    mimeType_ = mimeType;

                    g_free(cwd);
                    g_free(resourcesDir);
                    g_free(asarPath);

                    handle_request = true;
                    return true;
                } else {
                    // Fall through to flat file reading
                }
            }
        }

        // Fallback: Read from flat file system (for non-ASAR builds or missing files)
        gchar* viewsDir = g_build_filename(resourcesDir, "app", "views", nullptr);
        gchar* filePath = g_build_filename(viewsDir, fullPath.c_str(), nullptr);


        // Check if file exists and read it
        if (g_file_test(filePath, G_FILE_TEST_EXISTS)) {
            gsize fileSize;
            gchar* fileContent;
            GError* error = nullptr;

            if (g_file_get_contents(filePath, &fileContent, &fileSize, &error)) {
                data_ = std::string(fileContent, fileSize);
                g_free(fileContent);
                
                // Determine MIME type using shared function
                mimeType_ = getMimeTypeFromUrl(fullPath);
                
                
                g_free(cwd);
                g_free(viewsDir);
                g_free(filePath);
                
                handle_request = true;
                return true;
            } else {
                printf("CEF views:// failed to read file: %s\n", error ? error->message : "unknown error");
                if (error) g_error_free(error);
            }
        } else {
            printf("CEF views:// file not found: %s\n", filePath);
        }
        
        g_free(cwd);
        g_free(viewsDir);
        g_free(filePath);
        
        handle_request = false;
        return false;
    }
    
    void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length, CefString& redirectUrl) override {
        response->SetStatus(200);
        response->SetMimeType(mimeType_);
        response->SetStatusText("OK");
        response_length = data_.length();
    }
    
    bool Read(void* data_out, int bytes_to_read, int& bytes_read, CefRefPtr<CefResourceReadCallback> callback) override {
        bool has_data = false;
        bytes_read = 0;
        
        if (offset_ < data_.length()) {
            int transfer_size = std::min(bytes_to_read, static_cast<int>(data_.length() - offset_));
            memcpy(data_out, data_.c_str() + offset_, transfer_size);
            offset_ += transfer_size;
            bytes_read = transfer_size;
            has_data = true;
        }
        
        return has_data;
    }
    
    void Cancel() override {
        // Nothing to cancel
    }
    
private:
    std::string data_;
    std::string mimeType_;
    size_t offset_;
    
    IMPLEMENT_REFCOUNTING(ViewsResourceHandler);
};

// CEF views:// scheme handler factory
class ViewsSchemeHandlerFactory : public CefSchemeHandlerFactory {
public:
    CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, 
                                       const CefString& scheme_name, CefRefPtr<CefRequest> request) override {
        return new ViewsResourceHandler();
    }
    
private:
    IMPLEMENT_REFCOUNTING(ViewsSchemeHandlerFactory);
};

// V8 Handler for postMessage functions
class V8MessageHandler : public CefV8Handler {
public:
    V8MessageHandler(CefRefPtr<CefBrowser> browser, const CefString& messageName)
        : browser_(browser), message_name_(messageName) {}

    virtual bool Execute(const CefString& name,
                       CefRefPtr<CefV8Value> object,
                       const CefV8ValueList& arguments,
                       CefRefPtr<CefV8Value>& retval,
                       CefString& exception) override {
        
        if (arguments.size() > 0 && arguments[0]->IsString()) {
            std::string msgContent = arguments[0]->GetStringValue();
            
            // Create and send process message to the browser process
            CefRefPtr<CefProcessMessage> message = CefProcessMessage::Create(message_name_);
            message->GetArgumentList()->SetString(0, msgContent);
            browser_->GetMainFrame()->SendProcessMessage(PID_BROWSER, message);
            return true;
        }
        return false;
    }

private:
    CefRefPtr<CefBrowser> browser_;
    CefString message_name_;
    IMPLEMENT_REFCOUNTING(V8MessageHandler);
};

// ElectrobunApp implementation for Linux
class ElectrobunApp : public CefApp,
                     public CefBrowserProcessHandler,
                     public CefRenderProcessHandler {
public:
    ElectrobunApp() {}
    
    void OnBeforeCommandLineProcessing(const CefString& process_type, CefRefPtr<CefCommandLine> command_line) override {
        command_line->AppendSwitchWithValue("custom-scheme", "views");
        command_line->AppendSwitch("use-mock-keychain");
        // Linux-specific settings - disable GPU acceleration for VM compatibility
        command_line->AppendSwitch("disable-gpu");
        command_line->AppendSwitch("disable-gpu-compositing");
        command_line->AppendSwitch("disable-gpu-sandbox");
        command_line->AppendSwitch("enable-software-rasterizer");
        command_line->AppendSwitch("force-software-rasterizer");
        command_line->AppendSwitch("disable-accelerated-2d-canvas");
        command_line->AppendSwitch("disable-accelerated-video-decode");
        command_line->AppendSwitch("disable-accelerated-video-encode");
        command_line->AppendSwitch("disable-gpu-memory-buffer-video-frames");
        // Additional VM/headless flags
        command_line->AppendSwitch("disable-dev-shm-usage");
        command_line->AppendSwitch("disable-extensions");
        command_line->AppendSwitch("disable-plugins");
        command_line->AppendSwitch("disable-web-security");
        command_line->AppendSwitch("no-sandbox");
    }
    
    void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
        registrar->AddCustomScheme("views", 
            CEF_SCHEME_OPTION_STANDARD | 
            CEF_SCHEME_OPTION_CORS_ENABLED |
            CEF_SCHEME_OPTION_SECURE |
            CEF_SCHEME_OPTION_CSP_BYPASSING |
            CEF_SCHEME_OPTION_FETCH_ENABLED);
    }
    
    CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
        return this;
    }
    
    CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override {
        // In multi-process mode, return nullptr so render process uses the helper
        return nullptr;
    }
    
    
    void OnContextInitialized() override {
        CefRegisterSchemeHandlerFactory("views", "", new ViewsSchemeHandlerFactory());
    }
    
    // Render process handler methods
    void OnContextCreated(CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefFrame> frame,
                         CefRefPtr<CefV8Context> context) override {
        
        // Enter the context
        context->Enter();
        
        // Get the global object
        CefRefPtr<CefV8Value> global = context->GetGlobal();
        
        // Create bunBridge object with postMessage method
        CefRefPtr<CefV8Value> bunBridge = CefV8Value::CreateObject(nullptr, nullptr);
        CefRefPtr<CefV8Handler> bunHandler = new V8MessageHandler(browser, "BunBridgeMessage");
        CefRefPtr<CefV8Value> bunPostMessage = CefV8Value::CreateFunction("postMessage", bunHandler);
        bunBridge->SetValue("postMessage", bunPostMessage, V8_PROPERTY_ATTRIBUTE_NONE);
        global->SetValue("bunBridge", bunBridge, V8_PROPERTY_ATTRIBUTE_NONE);
        
        // Create internalBridge object with postMessage method
        CefRefPtr<CefV8Value> internalBridge = CefV8Value::CreateObject(nullptr, nullptr);
        CefRefPtr<CefV8Handler> internalHandler = new V8MessageHandler(browser, "internalMessage");
        CefRefPtr<CefV8Value> internalPostMessage = CefV8Value::CreateFunction("postMessage", internalHandler);
        internalBridge->SetValue("postMessage", internalPostMessage, V8_PROPERTY_ATTRIBUTE_NONE);
        global->SetValue("internalBridge", internalBridge, V8_PROPERTY_ATTRIBUTE_NONE);
        
        
        // Exit the context
        context->Exit();
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunApp);
    DISALLOW_COPY_AND_ASSIGN(ElectrobunApp);
};


// ElectrobunClient implementation for Linux
class ElectrobunClient : public CefClient,
                        public CefLoadHandler,
                        public CefRequestHandler,
                        public CefContextMenuHandler,
                        public CefKeyboardHandler,
                        public CefResourceRequestHandler,
                        public CefLifeSpanHandler,
                        public CefPermissionHandler,
                        public CefDialogHandler,
                        public CefDownloadHandler,
                        public CefRenderHandler {
private:
    uint32_t webview_id_;
    HandlePostMessage bun_bridge_handler_;
    HandlePostMessage webview_tag_handler_;
    WebviewEventHandler webview_event_handler_;
    DecideNavigationCallback navigation_callback_;
    
    std::string electrobun_script_;
    std::string custom_script_;
    CefRefPtr<CefBrowser> browser_;
    
    GtkWidget* gtk_widget_;
    std::function<void()> positioning_callback_;
    std::function<void(CefRefPtr<CefBrowser>)> browser_created_callback_;
    std::function<void()> browser_close_callback_;  // Callback to clear parent webview browser
    
    // OSR (Off-Screen Rendering) members for transparency
    Window x11_window_;
    Display* display_;
    bool osr_enabled_;
    int osr_width_, osr_height_;

public:
    ElectrobunClient(uint32_t webviewId,
                     HandlePostMessage bunBridgeHandler,
                     HandlePostMessage internalBridgeHandler,
                     WebviewEventHandler webviewEventHandler,
                     DecideNavigationCallback navigationCallback,
                     GtkWidget* gtkWidget)
        : webview_id_(webviewId)
        , bun_bridge_handler_(bunBridgeHandler)
        , webview_tag_handler_(internalBridgeHandler)
        , webview_event_handler_(webviewEventHandler)
        , navigation_callback_(navigationCallback)
        , gtk_widget_(gtkWidget)
        , x11_window_(0)
        , display_(nullptr)
        , osr_enabled_(false)
        , osr_width_(0)
        , osr_height_(0) {}

    void AddPreloadScript(const std::string& script, bool mainFrameOnly = false) {
        electrobun_script_ = script;
    }

    void UpdateCustomPreloadScript(const std::string& script) {
        custom_script_ = script;
    }
    
    std::string GetCombinedScript() {
        std::string combined_script = electrobun_script_;
        if (!custom_script_.empty()) {
            combined_script += "\n" + custom_script_;
        }
        return combined_script;
    }
    
    void SetBrowser(CefRefPtr<CefBrowser> browser) {
        browser_ = browser;
    }
    
    CefRefPtr<CefBrowser> GetBrowser() {
        return browser_;
    }
    
    void SetBrowserCreatedCallback(std::function<void(CefRefPtr<CefBrowser>)> callback) {
        browser_created_callback_ = callback;
    }
    
    void SetBrowserCloseCallback(std::function<void()> callback) {
        browser_close_callback_ = callback;
    }
    
    void SetBrowserPreloadScript(int browserId, const std::string& script) {
        g_preloadScripts[browserId] = script;
    }
    
    void SetPositioningCallback(std::function<void()> callback) {
        positioning_callback_ = callback;
    }
    
    void EnableOSR(Window x11_window, Display* display, int width, int height) {
        x11_window_ = x11_window;
        display_ = display;
        osr_enabled_ = true;
        osr_width_ = width;
        osr_height_ = height;
        printf("CEF: OSR enabled for window %lu, size %dx%d\n", x11_window, width, height);
    }
    
    void SendMouseEvent(const CefMouseEvent& event, bool mouse_down, int click_count) {
        if (browser_ && osr_enabled_) {
            browser_->GetHost()->SendMouseMoveEvent(event, false);
            if (mouse_down) {
                browser_->GetHost()->SendMouseClickEvent(event, MBT_LEFT, false, click_count);
            }
        }
    }
    
    void SendKeyEvent(const CefKeyEvent& event) {
        if (browser_ && osr_enabled_) {
            browser_->GetHost()->SendKeyEvent(event);
        }
    }

    virtual CefRefPtr<CefLoadHandler> GetLoadHandler() override {
        return this;
    }

    virtual CefRefPtr<CefRequestHandler> GetRequestHandler() override {
        return this;
    }

    virtual CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override {
        return this;
    }

    virtual CefRefPtr<CefKeyboardHandler> GetKeyboardHandler() override {
        return this;
    }

    virtual CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override {
        return this;
    }
    
    virtual CefRefPtr<CefPermissionHandler> GetPermissionHandler() override {
        return this;
    }
    
    virtual CefRefPtr<CefDialogHandler> GetDialogHandler() override {
        return this;
    }

    virtual CefRefPtr<CefDownloadHandler> GetDownloadHandler() override {
        return this;
    }

    virtual CefRefPtr<CefRenderHandler> GetRenderHandler() override {
        return this;
    }

    // Static debounce timestamp for ctrl+click handling
    static double lastCtrlClickTime;

    // Handle navigation requests
    bool OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       CefRefPtr<CefRequest> request,
                       bool user_gesture,
                       bool is_redirect) override {
        std::string url = request->GetURL().ToString();

        // Check for Ctrl key using GDK
        GdkDisplay* display = gdk_display_get_default();
        GdkSeat* seat = display ? gdk_display_get_default_seat(display) : nullptr;
        GdkDevice* keyboard = seat ? gdk_seat_get_keyboard(seat) : nullptr;
        GdkModifierType modifiers = (GdkModifierType)0;
        bool isCtrlHeld = false;

        if (keyboard) {
            gdk_device_get_state(keyboard, gdk_get_default_root_window(), NULL, &modifiers);
            isCtrlHeld = (modifiers & GDK_CONTROL_MASK) != 0;
        }

        printf("[CEF OnBeforeBrowse] url=%s user_gesture=%d is_redirect=%d display=%p seat=%p keyboard=%p modifiers=0x%X isCtrlHeld=%d hasHandler=%d webviewId=%u\n",
               url.c_str(), user_gesture, is_redirect, display, seat, keyboard, modifiers, isCtrlHeld, webview_event_handler_ != nullptr, webview_id_);

        if (isCtrlHeld && !is_redirect && webview_event_handler_) {
            // Debounce: ignore ctrl+click navigations within 500ms
            double now = g_get_monotonic_time() / 1000000.0;
            printf("[CEF OnBeforeBrowse] Ctrl held! now=%.3f lastTime=%.3f diff=%.3f\n",
                   now, lastCtrlClickTime, now - lastCtrlClickTime);

            if (now - lastCtrlClickTime >= 0.5) {
                lastCtrlClickTime = now;

                // Escape URL for JSON
                std::string escapedUrl;
                for (char c : url) {
                    switch (c) {
                        case '"': escapedUrl += "\\\""; break;
                        case '\\': escapedUrl += "\\\\"; break;
                        default: escapedUrl += c; break;
                    }
                }

                std::string eventData = "{\"url\":\"" + escapedUrl +
                                       "\",\"isCmdClick\":true,\"modifierFlags\":0}";
                printf("[CEF OnBeforeBrowse] Firing new-window-open: %s\n", eventData.c_str());
                // Use strdup to create persistent copies for the FFI callback
                webview_event_handler_(webview_id_, strdup("new-window-open"), strdup(eventData.c_str()));
                return true;  // Cancel navigation
            } else {
                printf("[CEF OnBeforeBrowse] Debounced - too soon after last ctrl+click\n");
            }
        }

        // Check navigation rules synchronously from native-stored rules  
        // Note: This mirrors the same logic in WebKit policy handler
        bool shouldAllow = true;
        {
            std::lock_guard<std::mutex> lock(g_webviewMapMutex);
            auto it = g_webviewMap.find(webview_id_);
            if (it != g_webviewMap.end() && it->second != nullptr) {
                // Forward to the navigation rules check method (defined later in this file)
                shouldAllow = checkNavigationRules(it->second, url);
            }
        }

        // Fire will-navigate event with allowed status
        if (webview_event_handler_) {
            // Escape URL for JSON
            std::string escapedUrl;
            for (char c : url) {
                switch (c) {
                    case '"': escapedUrl += "\\\""; break;
                    case '\\': escapedUrl += "\\\\"; break;
                    default: escapedUrl += c; break;
                }
            }
            std::string eventData = "{\"url\":\"" + escapedUrl + "\",\"allowed\":" +
                                   (shouldAllow ? "true" : "false") + "}";
            webview_event_handler_(webview_id_, strdup("will-navigate"), strdup(eventData.c_str()));
        }

        return !shouldAllow;  // Return true to cancel navigation
    }

    virtual CefRefPtr<CefResourceRequestHandler> GetResourceRequestHandler(
        CefRefPtr<CefBrowser> browser,
        CefRefPtr<CefFrame> frame,
        CefRefPtr<CefRequest> request,
        bool is_navigation,
        bool is_download,
        const CefString& request_initiator,
        bool& disable_default_handling) override {
        return this;
    }
    
    // Response filter for preload script injection (Mac-style clean approach)
    virtual CefRefPtr<CefResponseFilter> GetResourceResponseFilter(
        CefRefPtr<CefBrowser> browser,
        CefRefPtr<CefFrame> frame,
        CefRefPtr<CefRequest> request,
        CefRefPtr<CefResponse> response) override {
        
        // Only inject scripts into HTML responses in main frame
        if (frame->IsMain() && 
            response->GetMimeType().ToString().find("html") != std::string::npos) {
            
            std::string combined_script = GetCombinedScript();
            if (!combined_script.empty()) {
                return new ElectrobunResponseFilter(electrobun_script_, custom_script_);
            }
        }
        return nullptr;
    }


    void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                  CefRefPtr<CefFrame> frame,
                  int httpStatusCode) override {
        if (frame->IsMain() && webview_event_handler_) {
            std::string url = frame->GetURL().ToString();
            webview_event_handler_(webview_id_, strdup("did-navigate"), strdup(url.c_str()));
        }
    }

    // Context menu handler with DevTools option
    void OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                            CefRefPtr<CefFrame> frame,
                            CefRefPtr<CefContextMenuParams> params,
                            CefRefPtr<CefMenuModel> model) override {
        printf("CEF: Creating context menu with DevTools options\n");
        
        // Don't clear the default menu - let CEF show its default items
        // model->Clear();
        
        // Add DevTools option to existing menu
        if (model->GetCount() > 0) {
            model->AddSeparator();
        }
        model->AddItem(26501, "Inspect Element");
        model->AddItem(26502, "Open DevTools");
        
        printf("CEF: Context menu now has %zu items\n", model->GetCount());
    }
    
    // Handle context menu display
    bool RunContextMenu(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       CefRefPtr<CefContextMenuParams> params,
                       CefRefPtr<CefMenuModel> model,
                       CefRefPtr<CefRunContextMenuCallback> callback) override {
        printf("CEF: RunContextMenu called - using CEF's default implementation\n");
        
        // Return false to let CEF handle the context menu with its native implementation
        // CEF will create its own X11 window for the menu that works properly
        return false;
    }
    
    // Handle context menu commands
    bool OnContextMenuCommand(CefRefPtr<CefBrowser> browser,
                             CefRefPtr<CefFrame> frame,
                             CefRefPtr<CefContextMenuParams> params,
                             int command_id,
                             EventFlags event_flags) override {
        printf("CEF: Context menu command selected: %d\n", command_id);
        
        switch (command_id) {
            case 26501: // Inspect Element
            case 26502: // Open DevTools
                printf("CEF: Opening DevTools...\n");
                browser->GetHost()->ShowDevTools(CefWindowInfo(), this, CefBrowserSettings(), CefPoint());
                return true;
                
            case 26503: // Reload
                printf("CEF: Reloading page...\n");
                browser->Reload();
                return true;
                
            case 26504: // View Source
                printf("CEF: Viewing source...\n");
                frame->ViewSource();
                return true;
                
            default:
                return false;
        }
    }
    
    // Handle keyboard shortcuts (F12 for DevTools)
    bool OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                       const CefKeyEvent& event,
                       CefEventHandle os_event,
                       bool* is_keyboard_shortcut) override {
        if (event.type == KEYEVENT_KEYDOWN && event.windows_key_code == 123) { // F12 key
            printf("CEF: F12 pressed - opening DevTools\n");
            browser->GetHost()->ShowDevTools(CefWindowInfo(), this, CefBrowserSettings(), CefPoint());
            return true; // Consume the event
        }
        return false;
    }

    // CefLifeSpanHandler methods
    void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
        
        // Set the browser reference
        SetBrowser(browser);
        
        // Notify CEFWebViewImpl that browser is created
        if (browser_created_callback_) {
            browser_created_callback_(browser);
        }
        
        // The CEF browser window is now fully created
        CefWindowHandle cefWindow = browser->GetHost()->GetWindowHandle();
        
        // Validate the CEF window handle and try to understand what's happening
        if (cefWindow) {
            Display* display = gdk_x11_get_default_xdisplay();
            
            // For transparent windows, ensure the CEF window has no background
            // This will be properly handled when transparency info is available
            
            XWindowAttributes attrs;
            
            
            if (XGetWindowAttributes(display, cefWindow, &attrs) == 0) {
                Window root, parent;
                Window* children;
                unsigned int nchildren;
                
                // Get the root window
                Window rootWindow = DefaultRootWindow(display);
                if (XQueryTree(display, rootWindow, &root, &parent, &children, &nchildren) != 0) {
                    for (unsigned int i = 0; i < nchildren; i++) {
                        XWindowAttributes childAttrs;
                        if (XGetWindowAttributes(display, children[i], &childAttrs) != 0) {
                            // printf("CEF: Valid window found: 0x%lx (decimal: %lu)\n", 
                            //        (unsigned long)children[i], (unsigned long)children[i]);
                        }
                    }
                    XFree(children);
                }
            } else {
                       
                // Try positioning callback if window is ready
                if (positioning_callback_) {
                    positioning_callback_();
                }
            }
        }
    }

    // Critical: Handle browser cleanup to prevent use-after-free
    void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
        printf("CEF: OnBeforeClose called for browser %d\n", browser->GetIdentifier());
        
        // Clear browser reference to prevent use-after-free
        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
        if (browser_ && browser_->IsSame(browser)) {
            browser_ = nullptr;
            printf("CEF: Browser reference cleared in OnBeforeClose\n");
            
            // Notify parent webview to clear its browser reference too
            if (browser_close_callback_) {
                browser_close_callback_();
            }
        }
    }

    // Try using OnLoadingStateChange to detect when CEF is fully ready
    void OnLoadingStateChange(CefRefPtr<CefBrowser> browser,
                            bool isLoading,
                            bool canGoBack,
                            bool canGoForward) override {
        if (!isLoading) {
            
            // Check if CEF window handle is valid now
            CefWindowHandle cefWindow = browser->GetHost()->GetWindowHandle();
            if (cefWindow) {
                Display* display = gdk_x11_get_default_xdisplay();
                XWindowAttributes attrs;
                if (XGetWindowAttributes(display, cefWindow, &attrs) == 0) {
                } else {
                    
                    // Check window class hint
                    XClassHint class_hint;
                    if (XGetClassHint(display, cefWindow, &class_hint) != 0) {
                        
                        // Analyze toolkit based on class names
                        // if (class_hint.res_class) {
                        //     if (strstr(class_hint.res_class, "Gtk") || strstr(class_hint.res_class, "gtk")) {
                        //         // printf("CEF: TOOLKIT DETECTED: GTK (based on class name)\n");
                        //     } else if (strstr(class_hint.res_class, "Qt") || strstr(class_hint.res_class, "qt")) {
                        //         // printf("CEF: TOOLKIT DETECTED: Qt (based on class name)\n");
                        //     } else {
                        //         // printf("CEF: TOOLKIT: Likely native X11 (class: %s)\n", class_hint.res_class);
                        //     }
                        // }
                        
                        if (class_hint.res_class) XFree(class_hint.res_class);
                        if (class_hint.res_name) XFree(class_hint.res_name);
                    }
                    
                    // Check window manager name
                    char *wm_name = nullptr;
                    if (XFetchName(display, cefWindow, &wm_name) && wm_name) {
                        XFree(wm_name);
                    }
                    
                    // Check parent window
                    Window root, parent;
                    Window* children;
                    unsigned int nchildren;
                    if (XQueryTree(display, cefWindow, &root, &parent, &children, &nchildren) != 0) {
                        if (children) XFree(children);
                    }
                    
                    // Check window type
                    Atom actual_type;
                    int actual_format;
                    unsigned long nitems, bytes_after;
                    unsigned char* prop_data = nullptr;
                    Atom window_type_atom = XInternAtom(display, "_NET_WM_WINDOW_TYPE", False);
                    Atom atom_type = XInternAtom(display, "ATOM", False);
                    if (XGetWindowProperty(display, cefWindow, window_type_atom, 0, 1, False,
                                         atom_type, &actual_type, &actual_format, &nitems,
                                         &bytes_after, &prop_data) == Success && prop_data) {
                        Atom window_type = *(Atom*)prop_data;
                        char* type_name = XGetAtomName(display, window_type);
                        if (type_name) XFree(type_name);
                        XFree(prop_data);
                    }
                    // Additional toolkit detection via window properties
                    
                    // Check for GTK-specific properties
                    Atom gtk_atom = XInternAtom(display, "_GTK_THEME_VARIANT", True);
                    if (gtk_atom != None) {
                        unsigned char* gtk_data = nullptr;
                        if (XGetWindowProperty(display, cefWindow, gtk_atom, 0, 1, False,
                                             AnyPropertyType, &actual_type, &actual_format, &nitems,
                                             &bytes_after, &gtk_data) == Success && gtk_data) {
                            XFree(gtk_data);
                        }
                    }
                    
                    // Check for Qt-specific properties  
                    Atom qt_atom = XInternAtom(display, "_QT_SELECTION", True);
                    if (qt_atom != None) {
                        unsigned char* qt_data = nullptr;
                        if (XGetWindowProperty(display, cefWindow, qt_atom, 0, 1, False,
                                             AnyPropertyType, &actual_type, &actual_format, &nitems,
                                             &bytes_after, &qt_data) == Success && qt_data) {
                            XFree(qt_data);
                        }
                    }
                    
                    // if (attrs.all_event_masks & 0x400000) {
                    //     // printf("CEF: Event mask suggests modern toolkit (GTK3+ or Qt5+)\n");
                    // }
                }
            }
        }
    }

    // Handle process messages from render process
    virtual bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                        CefRefPtr<CefFrame> frame,
                                        CefProcessId source_process,
                                        CefRefPtr<CefProcessMessage> message) override {
        std::string messageName = message->GetName().ToString();
        std::string messageContent = message->GetArgumentList()->GetString(0).ToString();
        
        
        char* contentCopy = strdup(messageContent.c_str());
        bool result = false;
        
        if (messageName == "BunBridgeMessage") {
            // printf("CEF: Forwarding BunBridgeMessage to handler\n");
            bun_bridge_handler_(webview_id_, contentCopy);
            result = true;
        } else if (messageName == "internalMessage") {
            // printf("CEF: Forwarding internalMessage to handler\n");
            webview_tag_handler_(webview_id_, contentCopy);
            result = true;
        }

        // Free the copied string after a delay to ensure the callback has time to process it
        // This is necessary because the callbacks are invoked on the JS worker thread
        g_timeout_add(1000, [](gpointer data) -> gboolean {
            free(data);
            return G_SOURCE_REMOVE;
        }, contentCopy);
        
        return result;
    }
    
    // Permission Handler methods for CEF
    virtual bool OnRequestMediaAccessPermission(
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
        
        // Create camera/microphone permission dialog
        std::string message = "This page wants to access your camera and/or microphone.\n\nDo you want to allow this?";
        std::string title = "Camera & Microphone Access";
        
        // Create permission dialog with custom buttons
        GtkWidget* dialog = gtk_dialog_new_with_buttons(
            title.c_str(),
            nullptr,
            GTK_DIALOG_MODAL,
            "Allow", GTK_RESPONSE_YES,
            "Block", GTK_RESPONSE_NO,
            nullptr
        );
        
        // Add message label
        GtkWidget* content_area = gtk_dialog_get_content_area(GTK_DIALOG(dialog));
        GtkWidget* label = gtk_label_new(message.c_str());
        gtk_label_set_line_wrap(GTK_LABEL(label), TRUE);
        gtk_widget_set_margin_top(label, 10);
        gtk_widget_set_margin_bottom(label, 10);
        gtk_widget_set_margin_start(label, 10);
        gtk_widget_set_margin_end(label, 10);
        gtk_container_add(GTK_CONTAINER(content_area), label);
        gtk_widget_show_all(dialog);
        
        gtk_window_set_position(GTK_WINDOW(dialog), GTK_WIN_POS_CENTER);
        
        // Show dialog and get response
        gint response = gtk_dialog_run(GTK_DIALOG(dialog));
        gtk_widget_destroy(dialog);
        
        // Handle response and cache the decision
        if (response == GTK_RESPONSE_YES) {
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
    
    virtual bool OnShowPermissionPrompt(
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
        
        // Create permission dialog with custom buttons
        GtkWidget* dialog = gtk_dialog_new_with_buttons(
            title.c_str(),
            nullptr,
            GTK_DIALOG_MODAL,
            "Allow", GTK_RESPONSE_YES,
            "Block", GTK_RESPONSE_NO,
            nullptr
        );
        
        // Add message label
        GtkWidget* content_area = gtk_dialog_get_content_area(GTK_DIALOG(dialog));
        GtkWidget* label = gtk_label_new(message.c_str());
        gtk_label_set_line_wrap(GTK_LABEL(label), TRUE);
        gtk_widget_set_margin_top(label, 10);
        gtk_widget_set_margin_bottom(label, 10);
        gtk_widget_set_margin_start(label, 10);
        gtk_widget_set_margin_end(label, 10);
        gtk_container_add(GTK_CONTAINER(content_area), label);
        gtk_widget_show_all(dialog);
        
        gtk_window_set_position(GTK_WINDOW(dialog), GTK_WIN_POS_CENTER);
        
        // Show dialog and get response
        gint response = gtk_dialog_run(GTK_DIALOG(dialog));
        gtk_widget_destroy(dialog);
        
        // Handle response and cache the decision
        if (response == GTK_RESPONSE_YES) {
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
    
    virtual void OnDismissPermissionPrompt(
        CefRefPtr<CefBrowser> browser,
        uint64_t prompt_id,
        cef_permission_request_result_t result) override {
        
        printf("CEF: Permission prompt dismissed with result %d\n", result);
        // Optional: Handle prompt dismissal if needed
    }
    
    // CefDialogHandler methods
    virtual bool OnFileDialog(CefRefPtr<CefBrowser> browser,
                            FileDialogMode mode,
                            const CefString& title,
                            const CefString& default_file_path,
                            const std::vector<CefString>& accept_filters,
                            CefRefPtr<CefFileDialogCallback> callback) override {
        
        printf("CEF Linux: File dialog requested - mode: %d\n", static_cast<int>(mode));
        
        // Run the file dialog using GTK on the main thread
        // Since this is Linux, we can use GTK dialogs directly
        GtkWidget* dialog = nullptr;
        GtkFileChooserAction action = GTK_FILE_CHOOSER_ACTION_OPEN;
        const char* buttonText = "_Open";
        
        // Configure dialog based on mode
        switch (mode) {
            case FILE_DIALOG_OPEN:
                action = GTK_FILE_CHOOSER_ACTION_OPEN;
                buttonText = "_Open";
                break;
            case FILE_DIALOG_OPEN_MULTIPLE:
                action = GTK_FILE_CHOOSER_ACTION_OPEN;
                buttonText = "_Open";
                break;
            case FILE_DIALOG_OPEN_FOLDER:
                action = GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER;
                buttonText = "_Select";
                break;
            case FILE_DIALOG_SAVE:
                action = GTK_FILE_CHOOSER_ACTION_SAVE;
                buttonText = "_Save";
                break;
        }
        
        dialog = gtk_file_chooser_dialog_new(
            title.empty() ? "Select File" : title.ToString().c_str(),
            nullptr, // No parent window
            action,
            "_Cancel", GTK_RESPONSE_CANCEL,
            buttonText, GTK_RESPONSE_ACCEPT,
            nullptr
        );
        
        // Set multiple selection for OPEN_MULTIPLE mode
        if (mode == FILE_DIALOG_OPEN_MULTIPLE) {
            gtk_file_chooser_set_select_multiple(GTK_FILE_CHOOSER(dialog), TRUE);
        }
        
        // Set default file path if provided
        if (!default_file_path.empty()) {
            std::string path = default_file_path.ToString();
            if (mode == FILE_DIALOG_SAVE) {
                // For save dialogs, set the filename
                gtk_file_chooser_set_current_name(GTK_FILE_CHOOSER(dialog), path.c_str());
            } else {
                // For open dialogs, set the folder
                gtk_file_chooser_set_current_folder(GTK_FILE_CHOOSER(dialog), path.c_str());
            }
        }
        
        // Set file filters
        if (!accept_filters.empty()) {
            for (const auto& filter : accept_filters) {
                std::string filterStr = filter.ToString();
                
                GtkFileFilter* gtkFilter = gtk_file_filter_new();
                gtk_file_filter_set_name(gtkFilter, filterStr.c_str());
                
                // Handle common patterns
                if (filterStr == "*.*" || filterStr == "*") {
                    gtk_file_filter_add_pattern(gtkFilter, "*");
                } else if (filterStr.find("*.") == 0) {
                    gtk_file_filter_add_pattern(gtkFilter, filterStr.c_str());
                } else {
                    // Assume it's a file extension
                    std::string pattern = "*." + filterStr;
                    gtk_file_filter_add_pattern(gtkFilter, pattern.c_str());
                }
                
                gtk_file_chooser_add_filter(GTK_FILE_CHOOSER(dialog), gtkFilter);
            }
            
            // Always add an "All files" filter
            GtkFileFilter* allFilter = gtk_file_filter_new();
            gtk_file_filter_set_name(allFilter, "All files");
            gtk_file_filter_add_pattern(allFilter, "*");
            gtk_file_chooser_add_filter(GTK_FILE_CHOOSER(dialog), allFilter);
        }
        
        // Show the dialog
        gint response = gtk_dialog_run(GTK_DIALOG(dialog));
        
        std::vector<CefString> file_paths;
        if (response == GTK_RESPONSE_ACCEPT) {
            if (mode == FILE_DIALOG_OPEN_MULTIPLE) {
                GSList* filenames = gtk_file_chooser_get_filenames(GTK_FILE_CHOOSER(dialog));
                for (GSList* iter = filenames; iter != nullptr; iter = iter->next) {
                    file_paths.push_back((char*)iter->data);
                    g_free(iter->data);
                }
                g_slist_free(filenames);
            } else {
                char* filename = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(dialog));
                if (filename) {
                    file_paths.push_back(filename);
                    g_free(filename);
                }
            }
        }
        
        gtk_widget_destroy(dialog);
        
        // Call the callback with results
        callback->Continue(file_paths);
        
        printf("CEF Linux: File dialog completed with %zu files selected\n", file_paths.size());
        return true; // We handled the dialog
    }

    // CefDownloadHandler methods
    bool OnBeforeDownload(CefRefPtr<CefBrowser> browser,
                          CefRefPtr<CefDownloadItem> download_item,
                          const CefString& suggested_name,
                          CefRefPtr<CefBeforeDownloadCallback> callback) override {
        printf("CEF Linux: OnBeforeDownload for %s\n", suggested_name.ToString().c_str());

        // Get the Downloads folder using GLib
        const gchar* downloadsDir = g_get_user_special_dir(G_USER_DIRECTORY_DOWNLOAD);
        if (!downloadsDir) {
            // Fallback to home directory + Downloads
            const gchar* homeDir = g_get_home_dir();
            if (homeDir) {
                gchar* fallbackDir = g_build_filename(homeDir, "Downloads", nullptr);
                downloadsDir = fallbackDir;
            }
        }

        if (downloadsDir) {
            std::string suggestedStr = suggested_name.ToString();
            gchar* destinationPath = g_build_filename(downloadsDir, suggestedStr.c_str(), nullptr);

            // Handle duplicate filenames
            gchar* basePath = g_strdup(destinationPath);
            gchar* extension = nullptr;
            gchar* dot = g_strrstr(basePath, ".");
            if (dot && dot != basePath) {
                // Check if dot is in filename (not in path)
                gchar* lastSlash = g_strrstr(basePath, "/");
                if (!lastSlash || dot > lastSlash) {
                    extension = g_strdup(dot);
                    *dot = '\0';
                }
            }

            int counter = 1;
            while (g_file_test(destinationPath, G_FILE_TEST_EXISTS)) {
                g_free(destinationPath);
                if (extension) {
                    destinationPath = g_strdup_printf("%s (%d)%s", basePath, counter, extension);
                } else {
                    destinationPath = g_strdup_printf("%s (%d)", basePath, counter);
                }
                counter++;
            }

            printf("CEF Linux: Downloading to %s\n", destinationPath);

            // Continue the download to the specified path without showing a dialog
            callback->Continue(destinationPath, false);

            g_free(basePath);
            g_free(extension);
            g_free(destinationPath);
        } else {
            printf("CEF Linux ERROR: Could not determine Downloads directory, using default behavior\n");
            callback->Continue("", false);
        }

        return true;  // We handled it
    }

    void OnDownloadUpdated(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefDownloadItem> download_item,
                           CefRefPtr<CefDownloadItemCallback> callback) override {
        if (download_item->IsComplete()) {
            printf("CEF Linux: Download complete - %s\n", download_item->GetFullPath().ToString().c_str());
        } else if (download_item->IsCanceled()) {
            printf("CEF Linux: Download canceled\n");
        } else if (download_item->IsInProgress()) {
            int percent = download_item->GetPercentComplete();
            if (percent >= 0 && percent % 25 == 0) {  // Log at 0%, 25%, 50%, 75%, 100%
                printf("CEF Linux: Download progress %d%%\n", percent);
            }
        }
    }

    // CefRenderHandler methods for OSR (Off-Screen Rendering)
    void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect& rect) override {
        if (osr_enabled_) {
            rect.Set(0, 0, osr_width_, osr_height_);
            // printf("CEF OSR GetViewRect: returning %dx%d\n", osr_width_, osr_height_);
        } else {
            rect.Set(0, 0, 800, 600); // Default fallback
            // printf("CEF OSR GetViewRect: fallback 800x600\n");
        }
    }

    void OnPaint(CefRefPtr<CefBrowser> browser,
                 PaintElementType type,
                 const RectList& dirtyRects,
                 const void* buffer,
                 int width,
                 int height) override {
        
        if (!osr_enabled_ || !display_ || !x11_window_ || type != PET_VIEW) {
            printf("CEF OSR OnPaint: skipping (enabled=%d, display=%p, window=%lu, type=%d)\n", 
                   osr_enabled_, display_, x11_window_, type);
            return;
        }
        

        // Convert BGRA to ARGB format for X11
        const uint32_t* src = static_cast<const uint32_t*>(buffer);
        std::vector<uint32_t> converted_buffer(width * height);
        
        for (int i = 0; i < width * height; i++) {
            uint32_t bgra = src[i];
            uint32_t b = (bgra >> 0) & 0xFF;
            uint32_t g = (bgra >> 8) & 0xFF;
            uint32_t r = (bgra >> 16) & 0xFF;
            uint32_t a = (bgra >> 24) & 0xFF;
            
            // Convert BGRA to ARGB
            converted_buffer[i] = (a << 24) | (r << 16) | (g << 8) | b;
        }
        
        // Get window attributes to ensure we have the right visual
        XWindowAttributes win_attrs;
        XGetWindowAttributes(display_, x11_window_, &win_attrs);
        
        // Create XImage with the window's visual for proper transparency support
        XImage* image = XCreateImage(display_,
                                   win_attrs.visual,
                                   win_attrs.depth, // Use window's depth
                                   ZPixmap,
                                   0,
                                   reinterpret_cast<char*>(converted_buffer.data()),
                                   width,
                                   height,
                                   32, // bitmap_pad
                                   width * 4); // bytes_per_line
        
        if (image) {
            // Create a GC compatible with the window's visual
            GC gc = XCreateGC(display_, x11_window_, 0, nullptr);
            
            // Draw the image to the window
            XPutImage(display_, x11_window_, gc,
                     image, 0, 0, 0, 0, width, height);
            
            XFlush(display_);
            XFreeGC(display_, gc);
            
            // Clean up (don't free the data since it's from converted_buffer)
            image->data = nullptr;
            XDestroyImage(image);
            
            
        }
        
       
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunClient);
    DISALLOW_COPY_AND_ASSIGN(ElectrobunClient);
};

// Initialize static debounce timestamp for ctrl+click handling
double ElectrobunClient::lastCtrlClickTime = 0;

// Initialize CEF for Linux
bool initializeCEF() {
    if (g_cefInitialized) return true;
    
    if (!isCEFAvailable()) {
        printf("CEF not available in app bundle\n");
        return false;
    }
    
    // CRITICAL: Call gtk_disable_setlocale before any CEF operations
    // CEF internally calls GTK initialization, so we must do this first
    gtk_disable_setlocale();
    
    // Get command line arguments
    int argc = 0;
    char** argv = nullptr;
    
    // Read /proc/self/cmdline for arguments
    FILE* cmdline = fopen("/proc/self/cmdline", "r");
    if (cmdline) {
        fseek(cmdline, 0, SEEK_END);
        long size = ftell(cmdline);
        fseek(cmdline, 0, SEEK_SET);
        
        char* buffer = (char*)malloc(size + 1);
        fread(buffer, 1, size, cmdline);
        buffer[size] = '\0';
        fclose(cmdline);
        
        // Count arguments
        for (long i = 0; i < size; i++) {
            if (buffer[i] == '\0') argc++;
        }
        
        argv = (char**)malloc(sizeof(char*) * argc);
        int argIndex = 0;
        char* start = buffer;
        
        for (long i = 0; i <= size; i++) {
            if (buffer[i] == '\0') {
                argv[argIndex++] = strdup(start);
                start = buffer + i + 1;
            }
        }
        free(buffer);
    }
    
    CefMainArgs main_args(argc, argv);
    g_app = new ElectrobunApp();

   
    CefSettings settings;
    settings.no_sandbox = true;
    settings.windowless_rendering_enabled = true;  // Required for OSR/transparent windows
    // settings.remote_debugging_port = 9222;
    // printf("CEF: Remote debugging enabled on port 9222\n");
    
    // Use centralized GTK initialization to ensure proper setlocale handling
    initializeGTK();
    
    // Set the resource directory to where CEF files are located
    std::string execDir = getExecutableDir();
    // Resources are in the same directory as the executable for Linux
    CefString(&settings.resources_dir_path) = execDir;
    CefString(&settings.locales_dir_path) = execDir + "/locales";
    
    // Set browser subprocess path to the main helper binary
    CefString(&settings.browser_subprocess_path) = execDir + "/bun Helper";
    
    // Set cache path with identifier and channel to allow multiple apps/channels to run simultaneously
    // Use ~/.cache/identifier-channel/CEF (similar to macOS pattern)
    char* home = getenv("HOME");
    if (home) {
        std::string appIdentifier = !g_electrobunIdentifier.empty() ? g_electrobunIdentifier : "Electrobun";
        if (!g_electrobunChannel.empty()) {
            appIdentifier += "-" + g_electrobunChannel;
        }
        std::string cachePath = std::string(home) + "/.cache/" + appIdentifier + "/CEF";
        std::cout << "[CEF] Using app: " << appIdentifier << std::endl;
        CefString(&settings.root_cache_path) = cachePath;
    }
    
    // Set language
    CefString(&settings.accept_language_list) = "en-US,en";
    
    bool result = CefInitialize(main_args, settings, g_app.get(), nullptr);

    // Cleanup
    if (argv) {
        for (int i = 0; i < argc; i++) {
            free(argv[i]);
        }
        free(argv);
    }
    
    if (!result) {
        printf("CEF initialization failed\n");
        return false;
    } else {
    }
    
    g_cefInitialized = true;
    // printf("CEF initialized successfully\n");
    return true;
}

CefRefPtr<CefClient> create_default_handler() {
  class SimpleClient : public CefClient, public CefLifeSpanHandler {
  public:
    CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
    void OnAfterCreated(CefRefPtr<CefBrowser>) override {}
    IMPLEMENT_REFCOUNTING(SimpleClient);
  };
  return new SimpleClient();
}


// AbstractView base class declaration
class AbstractView {
public:
    uint32_t webviewId;
    GtkWidget* widget = nullptr;
    bool isMousePassthroughEnabled = false;
    bool mirrorModeEnabled = false;
    bool fullSize = false;
    bool isReceivingInput = true;
    std::string maskJSON;
    GdkRectangle visualBounds = {};
    bool creationFailed = false;

    // Navigation rules for URL filtering
    std::vector<std::string> navigationRules;

    AbstractView(uint32_t webviewId) : webviewId(webviewId) {}
    virtual ~AbstractView() {}

    // Set navigation rules from JSON array string
    void setNavigationRulesFromJSON(const char* rulesJson) {
        navigationRules.clear();
        if (!rulesJson || strlen(rulesJson) == 0) {
            return;
        }

        // Simple JSON array parser for string arrays: ["rule1", "rule2", ...]
        std::string json(rulesJson);
        size_t pos = json.find('[');
        if (pos == std::string::npos) return;

        pos++;
        while (pos < json.length()) {
            // Find start of string
            size_t strStart = json.find('"', pos);
            if (strStart == std::string::npos) break;

            // Find end of string (handle escaped quotes)
            size_t strEnd = strStart + 1;
            while (strEnd < json.length()) {
                if (json[strEnd] == '"' && json[strEnd - 1] != '\\') break;
                strEnd++;
            }
            if (strEnd >= json.length()) break;

            // Extract string value
            std::string rule = json.substr(strStart + 1, strEnd - strStart - 1);
            navigationRules.push_back(rule);

            pos = strEnd + 1;
        }
    }

    // Check if URL should be allowed based on navigation rules
    bool shouldAllowNavigationToURL(const std::string& url) {
        if (navigationRules.empty()) {
            return true; // Default allow if no rules
        }

        bool allowed = true; // Default allow if no rules match

        for (const std::string& rule : navigationRules) {
            bool isBlockRule = !rule.empty() && rule[0] == '^';
            std::string pattern = isBlockRule ? rule.substr(1) : rule;

            if (electrobun::globMatch(pattern, url)) {
                allowed = !isBlockRule; // Last match wins
                fprintf(stderr, "DEBUG: Navigation rule '%s' matched URL '%s', allowed=%d\n", 
                       rule.c_str(), url.c_str(), allowed);
            }
        }

        fprintf(stderr, "DEBUG: Final navigation decision for URL '%s': allowed=%d\n", 
               url.c_str(), allowed);
        return allowed;
    }
    
    // Pure virtual methods that must be implemented by derived classes
    virtual void loadURL(const char* urlString) = 0;
    virtual void loadHTML(const char* htmlString) = 0;
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
    virtual void resize(const GdkRectangle& frame, const char* masksJson) = 0;
    virtual void applyVisualMask() = 0;
    virtual void removeMasks() = 0;
    virtual void toggleMirrorMode(bool enable) = 0;
    
    // Common methods with default implementation
    virtual void setTransparent(bool transparent) {}
    virtual void setPassthrough(bool enable) { isMousePassthroughEnabled = enable; }
    virtual void setHidden(bool hidden) {}

    // Find in page methods
    virtual void findInPage(const char* searchText, bool forward, bool matchCase) = 0;
    virtual void stopFindInPage() = 0;
};

// Helper function implementation - calls AbstractView's navigation rules method
bool checkNavigationRules(std::shared_ptr<AbstractView> view, const std::string& url) {
    return view->shouldAllowNavigationToURL(url);
}

// WebKitGTK implementation
class WebKitWebViewImpl : public AbstractView {
public:
    GtkWidget* webview;
    WebKitUserContentManager* manager;
    DecideNavigationCallback navigationCallback;
    WebviewEventHandler eventHandler;
    HandlePostMessage bunBridgeHandler;
    HandlePostMessage internalBridgeHandler;
    std::string electrobunPreloadScript;
    std::string customPreloadScript;
    std::string partition;
    
    // Navigation state tracking
    bool lastNavigationWasBlocked = false;
    
    WebKitWebViewImpl(uint32_t webviewId, 
                      GtkWidget* window,
                      const char* url,
                      double x, double y,
                      double width, double height,
                      bool autoResize,
                      const char* partitionIdentifier,
                      DecideNavigationCallback navigationCallback,
                      WebviewEventHandler webviewEventHandler,
                      HandlePostMessage bunBridgeHandler,
                      HandlePostMessage internalBridgeHandler,
                      const char* electrobunPreloadScript,
                      const char* customPreloadScript) 
        : AbstractView(webviewId), navigationCallback(navigationCallback), 
          eventHandler(webviewEventHandler), bunBridgeHandler(bunBridgeHandler),
          internalBridgeHandler(internalBridgeHandler),
          electrobunPreloadScript(electrobunPreloadScript ? electrobunPreloadScript : ""),
          customPreloadScript(customPreloadScript ? customPreloadScript : ""),
          partition(partitionIdentifier ? partitionIdentifier : "")
    {
        // Create the user content controller and manager
        manager = webkit_user_content_manager_new();
        if (!manager) {
            fprintf(stderr, "ERROR: Failed to create WebKit user content manager\n");
            throw std::runtime_error("Failed to create WebKit user content manager");
        }
        
        // Create WebKit settings
        WebKitSettings* settings = webkit_settings_new();
        if (!settings) {
            fprintf(stderr, "ERROR: Failed to create WebKit settings\n");
            throw std::runtime_error("Failed to create WebKit settings");
        }
        webkit_settings_set_enable_developer_extras(settings, TRUE);
        webkit_settings_set_enable_javascript(settings, TRUE);
        webkit_settings_set_javascript_can_access_clipboard(settings, FALSE);
        webkit_settings_set_javascript_can_open_windows_automatically(settings, TRUE);
        webkit_settings_set_enable_back_forward_navigation_gestures(settings, TRUE);
        webkit_settings_set_enable_smooth_scrolling(settings, TRUE);
        
        // Enable media stream and WebRTC for camera/microphone access
        webkit_settings_set_enable_media_stream(settings, TRUE);
        webkit_settings_set_enable_webrtc(settings, TRUE);
        webkit_settings_set_enable_media(settings, TRUE);
        
        // Try to improve offscreen rendering without breaking stability
        // webkit_settings_set_enable_accelerated_2d_canvas is deprecated - removed

        // Get or create shared context for this partition
        WebKitWebContext* context = getContextForPartition(partition.empty() ? nullptr : partition.c_str());

        // Create webview with context and user content manager
        webview = GTK_WIDGET(g_object_new(WEBKIT_TYPE_WEB_VIEW,
            "web-context", context,
            "user-content-manager", manager,
            "settings", settings,
            NULL));
        if (!webview) {
            fprintf(stderr, "ERROR: Failed to create WebKit webview\n");
            throw std::runtime_error("Failed to create WebKit webview");
        }

        // Set size
        gtk_widget_set_size_request(webview, (int)width, (int)height);
        
        // Check if parent window is transparent and apply transparency to webview
        GtkWidget* toplevel = gtk_widget_get_toplevel(window);
        if (GTK_IS_WINDOW(toplevel)) {
            // Check if window has RGBA visual (transparent)
            GdkScreen* screen = gtk_window_get_screen(GTK_WINDOW(toplevel));
            GdkVisual* visual = gtk_widget_get_visual(toplevel);
            if (visual && gdk_screen_get_rgba_visual(screen) == visual) {
                // Window is transparent, make webview transparent too
                GdkRGBA transparent_color = {0.0, 0.0, 0.0, 0.0};
                webkit_web_view_set_background_color(WEBKIT_WEB_VIEW(webview), &transparent_color);
                printf("GTK WebKit: Applied transparent background to webview\n");
            }
        }
        
        // Add preload scripts
        if (!this->electrobunPreloadScript.empty()) {
            addPreloadScriptToWebView(this->electrobunPreloadScript.c_str());
        }
        if (!this->customPreloadScript.empty()) {
            addPreloadScriptToWebView(this->customPreloadScript.c_str());
        }
        
        // Set up message handlers
        if (bunBridgeHandler) {
            g_signal_connect(manager, "script-message-received::bunBridge", 
                           G_CALLBACK(onBunBridgeMessage), this);
            webkit_user_content_manager_register_script_message_handler(manager, "bunBridge");
        }
        
        if (internalBridgeHandler) {
            g_signal_connect(manager, "script-message-received::internalBridge", 
                           G_CALLBACK(onInternalBridgeMessage), this);
            webkit_user_content_manager_register_script_message_handler(manager, "internalBridge");
        }
        
        // Connect navigation decision handler for both navigation callbacks AND navigation rules
        g_signal_connect(webview, "decide-policy", G_CALLBACK(onDecidePolicy), this);
        
        // Set up event handlers
        if (eventHandler) {
            g_signal_connect(webview, "load-changed", G_CALLBACK(onLoadChanged), this);
            g_signal_connect(webview, "load-failed", G_CALLBACK(onLoadFailed), this);
        }
        
        // Enable context menu (right-click menu)
        g_signal_connect(webview, "context-menu", G_CALLBACK(onContextMenu), this);
        
        // Debug scroll events
        g_signal_connect(webview, "scroll-event", G_CALLBACK(onScrollEvent), this);
        
        // Handle permission requests for getUserMedia
        g_signal_connect(webview, "permission-request", G_CALLBACK(onPermissionRequest), this);
        
        // Handle file chooser requests for <input type="file">
        g_signal_connect(webview, "run-file-chooser", G_CALLBACK(onRunFileChooser), this);

        // Handle downloads
        WebKitWebContext* defaultContext = webkit_web_view_get_context(WEBKIT_WEB_VIEW(webview));
        if (defaultContext) {
            g_signal_connect(defaultContext, "download-started", G_CALLBACK(onDownloadStarted), this);
        }

        // Note: Removed visibility override for stability
        
        this->widget = webview;
        
        // Ensure webview is visible for rendering
        gtk_widget_set_visible(webview, TRUE);
        
        // Widget will be realized after it's added to a container in addWebview()
        
        // Load URL if provided
        if (url && strlen(url) > 0) {
            loadURL(url);
        }
    }
    
    ~WebKitWebViewImpl() {
        if (webview) {
            gtk_widget_destroy(webview);
        }
        if (manager) {
            g_object_unref(manager);
        }
    }
    
    void loadURL(const char* urlString) override {
        if (webview && urlString) {
            webkit_web_view_load_uri(WEBKIT_WEB_VIEW(webview), urlString);
        } else {
            fprintf(stderr, "ERROR: Cannot load URL - webview=%p, urlString=%s\n", webview, urlString ? urlString : "NULL");
        }
    }
    
    void loadHTML(const char* htmlString) override {
        if (webview && htmlString) {
            webkit_web_view_load_html(WEBKIT_WEB_VIEW(webview), htmlString, nullptr);
        } else {
            fprintf(stderr, "ERROR: Cannot load HTML - webview=%p, htmlString=%s\n", webview, htmlString ? htmlString : "NULL");
        }
    }
    
    void goBack() override {
        if (webview) {
            webkit_web_view_go_back(WEBKIT_WEB_VIEW(webview));
        }
    }
    
    void goForward() override {
        if (webview) {
            webkit_web_view_go_forward(WEBKIT_WEB_VIEW(webview));
        }
    }
    
    void reload() override {
        if (webview) {
            webkit_web_view_reload(WEBKIT_WEB_VIEW(webview));
        }
    }
    
    void remove() override {
        if (webview && gtk_widget_get_parent(webview)) {
            gtk_container_remove(GTK_CONTAINER(gtk_widget_get_parent(webview)), webview);
        }
    }
    
    bool canGoBack() override {
        if (webview) {
            return webkit_web_view_can_go_back(WEBKIT_WEB_VIEW(webview));
        }
        return false;
    }
    
    bool canGoForward() override {
        if (webview) {
            return webkit_web_view_can_go_forward(WEBKIT_WEB_VIEW(webview));
        }
        return false;
    }
    
    void evaluateJavaScriptWithNoCompletion(const char* jsString) override {
        if (webview && jsString) {
            webkit_web_view_evaluate_javascript(WEBKIT_WEB_VIEW(webview), jsString, -1, nullptr, nullptr, nullptr, nullptr, nullptr);
        }
    }
    
    void callAsyncJavascript(const char* messageId, const char* jsString, uint32_t webviewId, uint32_t hostWebviewId, void* completionHandler) override {
        // TODO: Implement async JavaScript with completion handler
        evaluateJavaScriptWithNoCompletion(jsString);
    }
    
    void addPreloadScriptToWebView(const char* jsString) override {
        if (manager && jsString) {
            WebKitUserScript* script = webkit_user_script_new(jsString, 
                                                            WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
                                                            WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START,
                                                            nullptr, nullptr);
            webkit_user_content_manager_add_script(manager, script);
            webkit_user_script_unref(script);
        }
    }
    
    void updateCustomPreloadScript(const char* jsString) override {
        customPreloadScript = jsString ? jsString : "";
        
        // Remove existing custom scripts and add new one
        if (manager) {
            // Remove all custom scripts (we'll track them with a prefix)
            webkit_user_content_manager_remove_all_scripts(manager);
            
            // Re-add electrobun preload script
            if (!electrobunPreloadScript.empty()) {
                WebKitUserScript* script = webkit_user_script_new(electrobunPreloadScript.c_str(), 
                                                                WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
                                                                WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START,
                                                                nullptr, nullptr);
                webkit_user_content_manager_add_script(manager, script);
                webkit_user_script_unref(script);
            }
            
            // Add updated custom script
            if (!customPreloadScript.empty()) {
                WebKitUserScript* script = webkit_user_script_new(customPreloadScript.c_str(), 
                                                                WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
                                                                WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START,
                                                                nullptr, nullptr);
                webkit_user_content_manager_add_script(manager, script);
                webkit_user_script_unref(script);
            }
        }
    }
    
    void resize(const GdkRectangle& frame, const char* masksJson) override {
        if (webview) {
            // Resizing webview
            
            // Set webview size
            gtk_widget_set_size_request(webview, frame.width, frame.height);
            
            // Check if this webview has a wrapper (OOPIF case)
            GtkWidget* wrapper = (GtkWidget*)g_object_get_data(G_OBJECT(webview), "wrapper");
            if (wrapper) {
                // TODO: this only sort of works, the webview ends up half height
                // and other overlay stuff is just janky and gross
                // so people should probably use CEF if they want OOPIFs on linux

                // For negative positions (scrolled out of view), we need to use
                // gtk_widget_set_margin_* with clamped values and offset the webview inside
                int clampedX = MAX(0, frame.x);
                int clampedY = MAX(0, frame.y);
                int offsetX = frame.x - clampedX;  // Will be negative if frame.x < 0
                int offsetY = frame.y - clampedY;  // Will be negative if frame.y < 0
                
                gtk_widget_set_size_request(wrapper, frame.width, frame.height);
                gtk_widget_set_margin_start(wrapper, clampedX);
                gtk_widget_set_margin_top(wrapper, clampedY);
                
                // Position webview within wrapper with offset to handle negative positions
                // Note: /2 division appears necessary for GTK coordinate system
                gtk_fixed_move(GTK_FIXED(wrapper), webview, offsetX / 2, offsetY / 2);
               
                // OOPIF positioned with coordinate adjustment
            } else {
                // For host webview, position directly with margins (can't be negative)
                gtk_widget_set_margin_start(webview, MAX(0, frame.x));
                gtk_widget_set_margin_top(webview, MAX(0, frame.y));
            }
            
            visualBounds = frame;
        }
        maskJSON = masksJson ? masksJson : "";
        
        // Store maskJSON for potential future use, but masking is not implemented for WebKit
        // See applyVisualMask() method for technical details on why WebKit masking isn't feasible
    }
    
    void applyVisualMask() override {
        // NOTE: WebKit masking is not implemented due to architectural limitations.
        // WebKit webviews in GTK have their own complex rendering and event handling
        // pipeline that doesn't support the "hole cutting" pattern used by CEF.
        // 
        // WebKit alternatives that were tried:
        // 1. X11 XShape masking - Conflicts with GTK rendering, causes visual artifacts
        // 2. GTK input shape masking - WebKit's internal event handling bypasses GTK input shapes
        // 3. CSS clipping - Would affect visual rendering, not just mouse events
        // 
        // Recommendation: Use CEF for webviews that require maskJSON functionality
        // on Linux, as CEF provides direct window management that supports masking.
    }
    
    void removeMasks() override {
        // NOTE: WebKit masking is not implemented - see applyVisualMask() for details
    }
    
    void toggleMirrorMode(bool enable) override {
        if (mirrorModeEnabled == enable) {
            return;
        }
        
        mirrorModeEnabled = enable;
        
        // With separate containers, mirror mode only affects input handling
        // No need to move webviews offscreen since OOPIFs are in non-sizing container
        if (webview) {
            if (enable) {
                // Disable input events for this webview
                gtk_widget_set_sensitive(webview, FALSE);
            } else {
                // Re-enable input events
                gtk_widget_set_sensitive(webview, TRUE);
            }
        }
    }
    
    void setHidden(bool hidden) override {
        if (webview) {
            if (hidden) {
                gtk_widget_hide(webview);
            } else {
                gtk_widget_show(webview);
            }
        }
    }
    
    // Static callback functions
    static void onBunBridgeMessage(WebKitUserContentManager* manager, WebKitJavascriptResult* js_result, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);
        if (impl->bunBridgeHandler && js_result) {
            // Use the newer JSC API recommended by WebKit2GTK
            JSCValue* value = webkit_javascript_result_get_js_value(js_result);
            if (value && JSC_IS_VALUE(value) && jsc_value_is_string(value)) {
                gchar* str_value = jsc_value_to_string(value);
                if (str_value) {
                    // Create a copy for the callback to avoid memory issues
                    size_t len = strlen(str_value);
                    char* message_copy = new char[len + 1];
                    strcpy(message_copy, str_value);
                    
                    // Call the callback
                    impl->bunBridgeHandler(impl->webviewId, message_copy);
                    
                    // Schedule cleanup after a delay to avoid premature deallocation
                    std::thread([message_copy, str_value]() {
                        std::this_thread::sleep_for(std::chrono::seconds(1));
                        delete[] message_copy;
                        g_free(str_value);
                    }).detach();
                } else {
                    g_free(str_value);
                }
            }
        }
    }
    
    static void onInternalBridgeMessage(WebKitUserContentManager* manager, WebKitJavascriptResult* js_result, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);
        if (impl->internalBridgeHandler && js_result) {
            // Use the newer JSC API recommended by WebKit2GTK
            JSCValue* value = webkit_javascript_result_get_js_value(js_result);
            if (value && JSC_IS_VALUE(value) && jsc_value_is_string(value)) {
                gchar* str_value = jsc_value_to_string(value);
                if (str_value) {
                    // Create a copy for the callback to avoid memory issues
                    size_t len = strlen(str_value);
                    char* message_copy = new char[len + 1];
                    strcpy(message_copy, str_value);
                    
                    // Call the callback
                    impl->internalBridgeHandler(impl->webviewId, message_copy);
                    
                    // Schedule cleanup after a delay to avoid premature deallocation
                    std::thread([message_copy, str_value]() {
                        std::this_thread::sleep_for(std::chrono::seconds(1));
                        delete[] message_copy;
                        g_free(str_value);
                    }).detach();
                } else {
                    g_free(str_value);
                }
            }
        }
    }
    
    // Static debounce timestamp for ctrl+click handling
    static double lastCtrlClickTime;

    static gboolean onDecidePolicy(WebKitWebView* webview, WebKitPolicyDecision* decision, WebKitPolicyDecisionType type, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);

        if (type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) {
            WebKitNavigationPolicyDecision* nav_decision = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
            WebKitNavigationAction* action = webkit_navigation_policy_decision_get_navigation_action(nav_decision);
            WebKitURIRequest* request = webkit_navigation_action_get_request(action);
            const char* uri = webkit_uri_request_get_uri(request);

            // Check for Ctrl key using GDK
            GdkDisplay* display = gdk_display_get_default();
            GdkSeat* seat = display ? gdk_display_get_default_seat(display) : nullptr;
            GdkDevice* keyboard = seat ? gdk_seat_get_keyboard(seat) : nullptr;
            GdkModifierType modifiers = (GdkModifierType)0;
            bool isCtrlHeld = false;

            if (keyboard) {
                gdk_device_get_state(keyboard, gdk_get_default_root_window(), NULL, &modifiers);
                isCtrlHeld = (modifiers & GDK_CONTROL_MASK) != 0;
            }

            printf("[GTKWebKit onDecidePolicy] url=%s display=%p seat=%p keyboard=%p modifiers=0x%X isCtrlHeld=%d hasHandler=%d\n",
                   uri ? uri : "(null)", display, seat, keyboard, modifiers, isCtrlHeld, impl->eventHandler != nullptr);

            if (isCtrlHeld && impl->eventHandler) {
                // Debounce: ignore ctrl+click navigations within 500ms
                double now = g_get_monotonic_time() / 1000000.0;
                printf("[GTKWebKit onDecidePolicy] Ctrl held! now=%.3f lastTime=%.3f diff=%.3f\n",
                       now, lastCtrlClickTime, now - lastCtrlClickTime);

                if (now - lastCtrlClickTime >= 0.5) {
                    lastCtrlClickTime = now;

                    // Escape URL for JSON
                    std::string url = uri ? uri : "";
                    std::string escapedUrl;
                    for (char c : url) {
                        switch (c) {
                            case '"': escapedUrl += "\\\""; break;
                            case '\\': escapedUrl += "\\\\"; break;
                            default: escapedUrl += c; break;
                        }
                    }

                    std::string eventData = "{\"url\":\"" + escapedUrl +
                                           "\",\"isCmdClick\":true,\"modifierFlags\":0}";
                    printf("[GTKWebKit onDecidePolicy] Firing new-window-open: %s\n", eventData.c_str());
                    // Use strdup to create persistent copies for the FFI callback
                    impl->eventHandler(impl->webviewId, strdup("new-window-open"), strdup(eventData.c_str()));

                    webkit_policy_decision_ignore(decision);
                    return TRUE;
                } else {
                    printf("[GTKWebKit onDecidePolicy] Debounced - too soon after last ctrl+click\n");
                }
            }

            // Check navigation rules synchronously from native-stored rules
            std::string url = uri ? uri : "";
            bool shouldAllow = true;
            {
                std::lock_guard<std::mutex> lock(g_webviewMapMutex);
                auto it = g_webviewMap.find(impl->webviewId);
                if (it != g_webviewMap.end() && it->second != nullptr) {
                    fprintf(stderr, "DEBUG: Found webview %u in map, checking navigation rules for URL: %s\n", 
                           impl->webviewId, url.c_str());
                    shouldAllow = it->second->shouldAllowNavigationToURL(url);
                } else {
                    fprintf(stderr, "DEBUG: Webview %u NOT found in map!\n", impl->webviewId);
                }
            }

            // Fire will-navigate event with allowed status
            if (impl->eventHandler) {
                // Escape URL for JSON
                std::string escapedUrl;
                for (char c : url) {
                    switch (c) {
                        case '"': escapedUrl += "\\\""; break;
                        case '\\': escapedUrl += "\\\\"; break;
                        default: escapedUrl += c; break;
                    }
                }
                std::string eventData = "{\"url\":\"" + escapedUrl + "\",\"allowed\":" +
                                       (shouldAllow ? "true" : "false") + "}";
                impl->eventHandler(impl->webviewId, strdup("will-navigate"), strdup(eventData.c_str()));
            }

            // Block navigation if not allowed
            if (!shouldAllow) {
                impl->lastNavigationWasBlocked = true;
                webkit_policy_decision_ignore(decision);
                return TRUE;
            }
            
            // Navigation is allowed, reset the flag
            impl->lastNavigationWasBlocked = false;
        }
        return FALSE;
    }
    
    static void onLoadChanged(WebKitWebView* webview, WebKitLoadEvent event, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);
        if (impl->eventHandler) {
            const char* uri = webkit_web_view_get_uri(webview);
            switch (event) {
                case WEBKIT_LOAD_STARTED:
                    impl->eventHandler(impl->webviewId, "load-started", uri);
                    break;
                case WEBKIT_LOAD_REDIRECTED:
                    impl->eventHandler(impl->webviewId, "load-redirected", uri);
                    break;
                case WEBKIT_LOAD_COMMITTED:
                    impl->eventHandler(impl->webviewId, "load-committed", uri);
                    break;
                case WEBKIT_LOAD_FINISHED:
                    impl->eventHandler(impl->webviewId, "load-finished", uri);
                    // Only fire did-navigate event if navigation wasn't blocked
                    if (!impl->lastNavigationWasBlocked) {
                        impl->eventHandler(impl->webviewId, "did-navigate", uri);
                    }
                    break;
            }
        }
    }
    
    static gboolean onLoadFailed(WebKitWebView* webview, WebKitLoadEvent event, gchar* uri, GError* error, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);
        if (impl->eventHandler) {
            impl->eventHandler(impl->webviewId, "load-failed", uri);
        }
        return FALSE;
    }
    
    static gboolean onContextMenu(WebKitWebView* webview, WebKitContextMenu* context_menu, GdkEvent* event, WebKitHitTestResult* hit_test_result, gpointer user_data) {
        // Allow the default context menu to be shown
        return FALSE;
    }
    
    static gboolean onScrollEvent(GtkWidget* widget, GdkEventScroll* event, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);
        fflush(stdout);
        return FALSE; // Allow scroll to continue
    }
    
    static gboolean onPermissionRequest(WebKitWebView* webview, WebKitPermissionRequest* request, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);
        
        // Check if this is a user media permission request (camera/microphone)
        if (WEBKIT_IS_USER_MEDIA_PERMISSION_REQUEST(request)) {
            std::string origin = getOriginFromPermissionRequest(request);
            
            // Check cache first
            PermissionStatus cachedStatus = getPermissionFromCache(origin, PermissionType::USER_MEDIA);
            
            if (cachedStatus == PermissionStatus::ALLOWED) {
                printf("Using cached permission: User previously allowed camera/microphone access for %s\n", origin.c_str());
                webkit_permission_request_allow(request);
                return TRUE;
            } else if (cachedStatus == PermissionStatus::DENIED) {
                printf("Using cached permission: User previously blocked camera/microphone access for %s\n", origin.c_str());
                webkit_permission_request_deny(request);
                return TRUE;
            }
            
            // No cached permission, show dialog
            printf("No cached permission found for %s, showing dialog\n", origin.c_str());
            
            // Create camera/microphone permission dialog
            std::string message = "This page wants to access your camera and/or microphone.\n\nDo you want to allow this?";
            std::string title = "Camera & Microphone Access";
            
            // Create permission dialog with custom buttons
            GtkWidget* dialog = gtk_dialog_new_with_buttons(
                title.c_str(),
                nullptr,
                GTK_DIALOG_MODAL,
                "Allow", GTK_RESPONSE_YES,
                "Block", GTK_RESPONSE_NO,
                nullptr
            );
            
            // Add message label
            GtkWidget* content_area = gtk_dialog_get_content_area(GTK_DIALOG(dialog));
            GtkWidget* label = gtk_label_new(message.c_str());
            gtk_label_set_line_wrap(GTK_LABEL(label), TRUE);
            gtk_widget_set_margin_top(label, 10);
            gtk_widget_set_margin_bottom(label, 10);
            gtk_widget_set_margin_start(label, 10);
            gtk_widget_set_margin_end(label, 10);
            gtk_container_add(GTK_CONTAINER(content_area), label);
            gtk_widget_show_all(dialog);
            
            gtk_window_set_position(GTK_WINDOW(dialog), GTK_WIN_POS_CENTER);
            
            // Show dialog and get response
            gint response = gtk_dialog_run(GTK_DIALOG(dialog));
            gtk_widget_destroy(dialog);
            
            // Handle response and cache the decision
            if (response == GTK_RESPONSE_YES) {
                webkit_permission_request_allow(request);
                cachePermission(origin, PermissionType::USER_MEDIA, PermissionStatus::ALLOWED);
                printf("User allowed camera/microphone access for %s (cached)\n", origin.c_str());
            } else {
                webkit_permission_request_deny(request);
                cachePermission(origin, PermissionType::USER_MEDIA, PermissionStatus::DENIED);
                printf("User blocked camera/microphone access for %s (cached)\n", origin.c_str());
            }
            
            return TRUE;
        }
        
        // For other permission types (geolocation, notifications, etc.)
        std::string message = "This page is requesting additional permissions.\n\nDo you want to allow this?";
        std::string title = "Permission Request";
        
        // Create permission dialog with custom buttons
        GtkWidget* dialog = gtk_dialog_new_with_buttons(
            title.c_str(),
            nullptr,
            GTK_DIALOG_MODAL,
            "Allow", GTK_RESPONSE_YES,
            "Block", GTK_RESPONSE_NO,
            nullptr
        );
        
        // Add message label
        GtkWidget* content_area = gtk_dialog_get_content_area(GTK_DIALOG(dialog));
        GtkWidget* label = gtk_label_new(message.c_str());
        gtk_label_set_line_wrap(GTK_LABEL(label), TRUE);
        gtk_widget_set_margin_top(label, 10);
        gtk_widget_set_margin_bottom(label, 10);
        gtk_widget_set_margin_start(label, 10);
        gtk_widget_set_margin_end(label, 10);
        gtk_container_add(GTK_CONTAINER(content_area), label);
        gtk_widget_show_all(dialog);
        
        gtk_window_set_position(GTK_WINDOW(dialog), GTK_WIN_POS_CENTER);
        
        gint response = gtk_dialog_run(GTK_DIALOG(dialog));
        gtk_widget_destroy(dialog);
        
        if (response == GTK_RESPONSE_YES) {
            webkit_permission_request_allow(request);
            printf("User allowed permission request\n");
        } else {
            webkit_permission_request_deny(request);
            printf("User blocked permission request\n");
        }
        
        return TRUE;
    }
    
    static gboolean onRunFileChooser(WebKitWebView* webview, WebKitFileChooserRequest* request, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);
        
        // Get file chooser details
        gboolean allowsMultipleSelection = webkit_file_chooser_request_get_select_multiple(request);
        const gchar* const* acceptedMimeTypes = webkit_file_chooser_request_get_mime_types(request);
        
        // Create the file chooser dialog
        GtkWidget* dialog = gtk_file_chooser_dialog_new(
            "Select File(s)",
            nullptr, // No parent window for now
            GTK_FILE_CHOOSER_ACTION_OPEN,
            "_Cancel", GTK_RESPONSE_CANCEL,
            "_Open", GTK_RESPONSE_ACCEPT,
            nullptr
        );
        
        // Set multiple selection
        gtk_file_chooser_set_select_multiple(GTK_FILE_CHOOSER(dialog), allowsMultipleSelection);
        
        // Set up MIME type filters if provided
        if (acceptedMimeTypes && acceptedMimeTypes[0] != nullptr) {
            GtkFileFilter* filter = gtk_file_filter_new();
            gtk_file_filter_set_name(filter, "Allowed file types");
            
            for (int i = 0; acceptedMimeTypes[i] != nullptr; i++) {
                const char* mimeType = acceptedMimeTypes[i];
                
                // Add MIME type to filter
                if (strlen(mimeType) > 0) {
                    gtk_file_filter_add_mime_type(filter, mimeType);
                    
                    // Also add common patterns for known MIME types
                    if (strcmp(mimeType, "image/*") == 0) {
                        gtk_file_filter_add_pattern(filter, "*.jpg");
                        gtk_file_filter_add_pattern(filter, "*.jpeg");
                        gtk_file_filter_add_pattern(filter, "*.png");
                        gtk_file_filter_add_pattern(filter, "*.gif");
                        gtk_file_filter_add_pattern(filter, "*.bmp");
                        gtk_file_filter_add_pattern(filter, "*.webp");
                    } else if (strcmp(mimeType, "text/*") == 0) {
                        gtk_file_filter_add_pattern(filter, "*.txt");
                        gtk_file_filter_add_pattern(filter, "*.html");
                        gtk_file_filter_add_pattern(filter, "*.css");
                        gtk_file_filter_add_pattern(filter, "*.js");
                        gtk_file_filter_add_pattern(filter, "*.json");
                    }
                }
            }
            
            gtk_file_chooser_add_filter(GTK_FILE_CHOOSER(dialog), filter);
        }
        
        // Always add "All files" filter as fallback
        GtkFileFilter* allFilter = gtk_file_filter_new();
        gtk_file_filter_set_name(allFilter, "All files");
        gtk_file_filter_add_pattern(allFilter, "*");
        gtk_file_chooser_add_filter(GTK_FILE_CHOOSER(dialog), allFilter);
        
        // Run the dialog and handle the response
        gint response = gtk_dialog_run(GTK_DIALOG(dialog));
        
        if (response == GTK_RESPONSE_ACCEPT) {
            GSList* filenames = gtk_file_chooser_get_filenames(GTK_FILE_CHOOSER(dialog));
            
            // Convert GSList to array of strings
            guint length = g_slist_length(filenames);
            gchar** files = g_new(gchar*, length + 1);
            
            GSList* iter = filenames;
            for (guint i = 0; i < length; i++) {
                files[i] = (gchar*)iter->data;
                iter = iter->next;
            }
            files[length] = nullptr;
            
            // Select the files in the request
            webkit_file_chooser_request_select_files(request, (const gchar* const*)files);
            
            // Clean up
            g_slist_free_full(filenames, g_free);
            g_free(files);
        } else {
            // User cancelled - WebKit will handle this automatically
            webkit_file_chooser_request_cancel(request);
        }
        
        gtk_widget_destroy(dialog);
        return TRUE; // We handled the request
    }

    // Download handling callbacks
    static gboolean onDecideDestination(WebKitDownload* download, gchar* suggested_filename, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);
        fprintf(stderr, "WebKit2GTK: Deciding destination for download: %s\n", suggested_filename);

        // Get the Downloads directory
        const gchar* downloadsDir = g_get_user_special_dir(G_USER_DIRECTORY_DOWNLOAD);
        if (!downloadsDir) {
            // Fallback to home directory + Downloads
            downloadsDir = g_get_home_dir();
            if (downloadsDir) {
                gchar* fallbackDir = g_build_filename(downloadsDir, "Downloads", nullptr);
                downloadsDir = fallbackDir;
            }
        }

        if (downloadsDir) {
            gchar* destinationPath = g_build_filename(downloadsDir, suggested_filename, nullptr);

            // Handle duplicate filenames
            gchar* basePath = g_strdup(destinationPath);
            gchar* extension = nullptr;
            gchar* dot = g_strrstr(basePath, ".");
            if (dot && dot != basePath) {
                // Check if dot is in filename (not in path)
                gchar* lastSlash = g_strrstr(basePath, "/");
                if (!lastSlash || dot > lastSlash) {
                    extension = g_strdup(dot);
                    *dot = '\0';
                }
            }

            int counter = 1;
            while (g_file_test(destinationPath, G_FILE_TEST_EXISTS)) {
                g_free(destinationPath);
                if (extension) {
                    destinationPath = g_strdup_printf("%s (%d)%s", basePath, counter, extension);
                } else {
                    destinationPath = g_strdup_printf("%s (%d)", basePath, counter);
                }
                counter++;
            }

            g_free(basePath);
            g_free(extension);

            // Convert path to URI
            gchar* destinationUri = g_filename_to_uri(destinationPath, nullptr, nullptr);
            if (destinationUri) {
                fprintf(stderr, "WebKit2GTK: Downloading to %s\n", destinationPath);
                webkit_download_set_destination(download, destinationUri);
                g_free(destinationUri);
            } else {
                fprintf(stderr, "WebKit2GTK ERROR: Could not convert path to URI: %s\n", destinationPath);
            }

            g_free(destinationPath);
        } else {
            fprintf(stderr, "WebKit2GTK ERROR: Could not determine Downloads directory\n");
        }

        return TRUE; // We handled the signal
    }

    static void onDownloadFinished(WebKitDownload* download, gpointer user_data) {
        const gchar* destination = webkit_download_get_destination(download);
        fprintf(stderr, "WebKit2GTK: Download finished - %s\n", destination ? destination : "unknown");
    }

    static void onDownloadFailed(WebKitDownload* download, GError* error, gpointer user_data) {
        fprintf(stderr, "WebKit2GTK ERROR: Download failed - %s\n", error ? error->message : "unknown error");
    }

    static void onDownloadStarted(WebKitWebContext* context, WebKitDownload* download, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);
        WebKitURIRequest* request = webkit_download_get_request(download);
        const gchar* uri = webkit_uri_request_get_uri(request);
        fprintf(stderr, "WebKit2GTK: Download started for %s\n", uri);

        // Connect to decide-destination signal
        g_signal_connect(download, "decide-destination", G_CALLBACK(onDecideDestination), user_data);

        // Connect to finished/failed signals for logging
        g_signal_connect(download, "finished", G_CALLBACK(onDownloadFinished), user_data);
        g_signal_connect(download, "failed", G_CALLBACK(onDownloadFailed), user_data);
    }

    void findInPage(const char* searchText, bool forward, bool matchCase) override {
        if (!WEBKIT_IS_WEB_VIEW(webview)) return;

        WebKitFindController* findController = webkit_web_view_get_find_controller(WEBKIT_WEB_VIEW(webview));
        if (!findController) return;

        if (!searchText || strlen(searchText) == 0) {
            webkit_find_controller_search_finish(findController);
            return;
        }

        guint32 findOptions = WEBKIT_FIND_OPTIONS_WRAP_AROUND;
        if (!matchCase) {
            findOptions |= WEBKIT_FIND_OPTIONS_CASE_INSENSITIVE;
        }
        if (!forward) {
            findOptions |= WEBKIT_FIND_OPTIONS_BACKWARDS;
        }

        webkit_find_controller_search(findController, searchText, findOptions, G_MAXUINT);
    }

    void stopFindInPage() override {
        if (!WEBKIT_IS_WEB_VIEW(webview)) return;

        WebKitFindController* findController = webkit_web_view_get_find_controller(WEBKIT_WEB_VIEW(webview));
        if (findController) {
            webkit_find_controller_search_finish(findController);
        }
    }

};

// Initialize static debounce timestamp for ctrl+click handling
double WebKitWebViewImpl::lastCtrlClickTime = 0;

// Create a CefRequestContext for partition isolation (CEF)
CefRefPtr<CefRequestContext> CreateRequestContextForPartition(const char* partitionIdentifier, uint32_t webviewId) {
    CefRequestContextSettings settings;

    if (!partitionIdentifier || !partitionIdentifier[0]) {
        // No partition: use ephemeral settings
        settings.persist_session_cookies = false;
        settings.persist_user_preferences = false;
    } else {
        std::string identifier(partitionIdentifier);
        bool isPersistent = identifier.substr(0, 8) == "persist:";

        if (isPersistent) {
            std::string partitionName = identifier.substr(8);

            // Build app identifier
            std::string appIdentifier = !g_electrobunIdentifier.empty() ? g_electrobunIdentifier : "Electrobun";
            if (!g_electrobunChannel.empty()) {
                appIdentifier += "-" + g_electrobunChannel;
            }

            // Build cache path
            char* home = getenv("HOME");
            std::string basePath = home ? std::string(home) : "/tmp";
            std::string cachePath = basePath + "/.cache/" + appIdentifier + "/CEF/Partitions/" + partitionName;

            // Create directory
            g_mkdir_with_parents(cachePath.c_str(), 0755);

            settings.persist_session_cookies = true;
            settings.persist_user_preferences = true;
            CefString(&settings.cache_path).FromString(cachePath);
        } else {
            // Ephemeral partition
            settings.persist_session_cookies = false;
            settings.persist_user_preferences = false;
        }
    }

    // Create isolated context with partition-specific settings
    CefRefPtr<CefRequestContext> context = CefRequestContext::CreateContext(settings, nullptr);
    
    // Register the views:// scheme handler factory on this context
    // This ensures the context can load views:// URLs while maintaining partition isolation
    static CefRefPtr<ViewsSchemeHandlerFactory> schemeFactory = new ViewsSchemeHandlerFactory();
    bool registered = context->RegisterSchemeHandlerFactory("views", "", schemeFactory);
    
    if (!registered) {
        fprintf(stderr, "WARNING: Failed to register views:// scheme handler for partition context\n");
    }
    
    return context;
}

// Forward declaration for X11 event processing
void processX11EventsForOSR(uint32_t windowId, CefRefPtr<ElectrobunClient> client);

// OSR event handling data structure
struct OSREventData {
    uint32_t windowId;
    CefRefPtr<ElectrobunClient> client;
    bool active;
};

// CEF WebView implementation
class CEFWebViewImpl : public AbstractView {
public:
    CefRefPtr<CefBrowser> browser;
    CefRefPtr<ElectrobunClient> client;
    DecideNavigationCallback navigationCallback;
    WebviewEventHandler eventHandler;
    HandlePostMessage bunBridgeHandler;
    HandlePostMessage internalBridgeHandler;
    std::string electrobunPreloadScript;
    std::string customPreloadScript;
    std::string partition;
    
    // Pending frame for deferred positioning
    GdkRectangle pendingFrame;
    bool hasPendingFrame = false;
    
    // For popup reparenting approach
    unsigned long parentXWindow = 0;
    CefRect targetBounds;
    
    // For deferred browser creation
    GtkWidget* gtkWindow = nullptr;
    std::string deferredUrl;
    double deferredX = 0, deferredY = 0, deferredWidth = 0, deferredHeight = 0;
    
    // Track if parent window is transparent
    bool parentTransparent = false;
    
    // OSR event handling data
    void* osr_event_data_ = nullptr;
    
    // X11 event handling for OSR windows is now handled via processX11EventsForOSR
    Window osr_x11_window_ = 0;
    Display* osr_display_ = nullptr;
    
    CEFWebViewImpl(uint32_t webviewId,
                   GtkWidget* window,
                   const char* url,
                   double x, double y,
                   double width, double height,
                   bool autoResize,
                   const char* partitionIdentifier,
                   DecideNavigationCallback navigationCallback,
                   WebviewEventHandler webviewEventHandler,
                   HandlePostMessage bunBridgeHandler,
                   HandlePostMessage internalBridgeHandler,
                   const char* electrobunPreloadScript,
                   const char* customPreloadScript)
        : AbstractView(webviewId), navigationCallback(navigationCallback),
          eventHandler(webviewEventHandler), bunBridgeHandler(bunBridgeHandler),
          internalBridgeHandler(internalBridgeHandler),
          electrobunPreloadScript(electrobunPreloadScript ? electrobunPreloadScript : ""),
          customPreloadScript(customPreloadScript ? customPreloadScript : ""),
          partition(partitionIdentifier ? partitionIdentifier : "")
    {
        // Initialize CEF if not already done
        if (!g_cefInitialized && !initializeCEF()) {
            creationFailed = true;
            return;
        }
        
        createCEFBrowser(window, url, x, y, width, height);
        
        // Browser creation happens immediately in createCEFBrowser
    }
    
    ~CEFWebViewImpl() {
        // Clean up OSR event handling
        if (osr_event_data_) {
            auto* eventData = static_cast<OSREventData*>(osr_event_data_);
            eventData->active = false;  // Stop the timer
            delete eventData;
            osr_event_data_ = nullptr;
        }
    }
    
    void createCEFBrowser(GtkWidget* window, const char* url, double x, double y, double width, double height) {
        
        // NO GTK widget needed - CEF will be a direct child of the X11 window
        this->widget = nullptr;
        
        // window parameter is actually X11Window* cast as GtkWidget*
        X11Window* x11win = reinterpret_cast<X11Window*>(window);
        if (!x11win || !x11win->window) {
            printf("CEF: ERROR - X11 window is null or invalid\n");
            creationFailed = true;
            return;
        }
        
        // Store the parent X11 window handle for later window association
        this->parentXWindow = x11win->window;
        
        // Store the parameters
        this->deferredUrl = url ? url : "";
        this->deferredX = x;
        this->deferredY = y;
        this->deferredWidth = width;
        this->deferredHeight = height;
        
        // Create CEF browser immediately as child of X11 window
        CefWindowInfo window_info;
        CefRect cef_rect((int)x, (int)y, (int)width, (int)height);
        
        // Use SetAsChild with the X11 window
        window_info.SetAsChild(x11win->window, cef_rect);
        
        // For transparent windows, use windowless/OSR mode like macOS and Windows
        if (x11win->transparent) {
            // Use windowless (off-screen) rendering for transparency
            window_info.SetAsWindowless(x11win->window);
            printf("CEF: Using windowless (OSR) mode for transparency\n");
        }
        
        
        CefBrowserSettings browser_settings;
        
        // Check if the parent window is transparent
        if (parentXWindow && x11win->transparent) {
            // For OSR transparent windows, use fully transparent background
            browser_settings.background_color = CefColorSetARGB(0, 0, 0, 0); // Fully transparent
            this->parentTransparent = true;
            printf("CEF: Using transparent background for OSR mode\n");
        }
        
        // Create client
        client = new ElectrobunClient(
            webviewId,
            bunBridgeHandler,
            internalBridgeHandler,
            eventHandler,
            navigationCallback,
            nullptr  // No GTK window needed
        );
        
        // Enable OSR for transparent windows
        if (x11win->transparent) {
            client->EnableOSR(x11win->window, x11win->display, (int)width, (int)height);
        }
        
        // Set up browser creation callback to notify CEFWebViewImpl when browser is ready
        client->SetBrowserCreatedCallback([this, x11win](CefRefPtr<CefBrowser> browser) {
            this->browser = browser;
            
            // Handle pending frame positioning now that browser is available
            if (hasPendingFrame) {
                syncCEFPositionWithFrame(pendingFrame);
                hasPendingFrame = false;
            }
            
            // For transparent OSR windows, setup event handling
            if (this->parentTransparent && x11win && x11win->transparent) {
                // Create a data structure to pass to the timer callback
                auto* eventData = new OSREventData{x11win->windowId, this->client, true};
                
                // Store event data in the webview for cleanup
                this->osr_event_data_ = eventData;
                
                // Use a higher frequency timer for better responsiveness
                g_timeout_add(5, [](gpointer data) -> gboolean {  // 200fps - process events more frequently
                    auto* osrData = static_cast<OSREventData*>(data);
                    if (osrData && osrData->active) {
                        processX11EventsForOSR(osrData->windowId, osrData->client);
                        return TRUE; // Continue timer
                    }
                    return FALSE; // Stop timer
                }, eventData);
                
                // Also use idle processing for immediate event handling
                g_idle_add([](gpointer data) -> gboolean {
                    auto* osrData = static_cast<OSREventData*>(data);
                    if (osrData && osrData->active) {
                        processX11EventsForOSR(osrData->windowId, osrData->client);
                        return TRUE; // Continue processing
                    }
                    return FALSE; // Stop
                }, eventData);
                
                printf("CEF: Transparent window input handling enabled for window %u\n", x11win->windowId);
            }
        });
        
        // Set up browser close callback to clear browser reference
        client->SetBrowserCloseCallback([this]() {
            std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
            this->browser = nullptr;
            printf("CEF: Browser reference cleared in CEFWebViewImpl\n");
        });
        
        // Add preload scripts to the client
        if (!electrobunPreloadScript.empty()) {
            client->AddPreloadScript(electrobunPreloadScript);
        }
        if (!customPreloadScript.empty()) {
            client->UpdateCustomPreloadScript(customPreloadScript);
        }
        
        // Create the browser with partition-specific request context
        std::string loadUrl = deferredUrl.empty() ? "https://www.wikipedia.org" : deferredUrl;
        CefRefPtr<CefRequestContext> requestContext = CreateRequestContextForPartition(partition.c_str(), webviewId);
        bool create_result = CefBrowserHost::CreateBrowser(window_info, client, loadUrl, browser_settings, nullptr, requestContext);
        
        if (!create_result) {
            creationFailed = true;
        } else {
            // Add this webview to the X11 window's child list
            x11win->childWindows.push_back(0); // Will be updated when browser is created
        }
    }
    
    // Removed createCEFBrowserInX11Window and createCEFBrowserDeferred - functionality moved to createCEFBrowser
    
    void syncCEFPositionWithFrame(const GdkRectangle& frame) {
        // Note: This may be called with or without g_cefBrowserMutex held
        // So we need to be careful about browser access
        CefRefPtr<CefBrowser> browserRef = browser;  // Atomic read
        if (!browserRef) {
            printf("CEF: Cannot sync - no browser\n");
            return;
        }
        
        
        // Get the CEF browser's X11 window handle
        CefWindowHandle cefWindow = browserRef->GetHost()->GetWindowHandle();
        if (!cefWindow) {
            printf("CEF: No window handle available for positioning\n");
            return;
        }
        
        // Validate the CEF window handle before using it
        Display* display = gdk_x11_get_default_xdisplay();
        XWindowAttributes attrs;
        if (XGetWindowAttributes(display, (Window)cefWindow, &attrs) == 0) {
            // Store the target frame for later positioning
            // For now, just skip positioning - this is likely during initial creation
            return;
        }
        
        XMoveResizeWindow(display, (Window)cefWindow, frame.x, frame.y, frame.width, frame.height);
        XFlush(display);
        
        // Ensure the window is mapped and raised
        XMapRaised(display, (Window)cefWindow);
        XFlush(display);
        
        // Also notify CEF about the resize
        browserRef->GetHost()->WasResized();
        
        // Check if the resize actually took effect
        XWindowAttributes newAttrs;
        if (XGetWindowAttributes(display, (Window)cefWindow, &newAttrs) != 0) {
            // printf("CEF: After resize - CEF window 0x%lx now at (%d,%d) size %dx%d\n", 
            //        (unsigned long)cefWindow, newAttrs.x, newAttrs.y, newAttrs.width, newAttrs.height);
        }
        
    }
    
    // Event handling will be implemented separately after global declarations
    
    void syncCEFPositionWithWidget() {
        if (!browser || !widget) {
            printf("CEF: Cannot sync - browser=%p, widget=%p\n", browser.get(), widget);
            return;
        }
        
        // Get the GTK widget's position relative to the parent window
        GtkWidget* parentWidget = gtk_widget_get_parent(widget);
        if (!parentWidget) {
            printf("CEF: Cannot sync - no parent widget\n");
            return;
        }
        
        // Get widget size first
        GtkAllocation allocation;
        gtk_widget_get_allocation(widget, &allocation);
        
        // Try to get absolute position on screen
        gint absX, absY;
        gdk_window_get_origin(gtk_widget_get_window(gtk_widget_get_toplevel(widget)), &absX, &absY);
        
        // Use the allocation position directly
        int finalX = allocation.x;
        int finalY = allocation.y;
        int finalWidth = MAX(allocation.width, 1);
        int finalHeight = MAX(allocation.height, 1);
        
        // Move the CEF browser window to match the widget position
        CefWindowHandle cefWindow = browser->GetHost()->GetWindowHandle();
        if (cefWindow) {
            Display* display = gdk_x11_get_default_xdisplay();
            
            // Validate CEF window handle before using it
            XWindowAttributes attrs;
            if (XGetWindowAttributes(display, cefWindow, &attrs) == 0) {
                printf("CEF: ERROR - Invalid CEF window handle 0x%lx in syncCEFPositionWithWidget, deferring until window is ready\n", 
                       (unsigned long)cefWindow);
                // Skip positioning for now - this is likely during initial creation
                return;
            }
            
            XMoveResizeWindow(display, cefWindow, finalX, finalY, finalWidth, finalHeight);
            XFlush(display);
        } else {
            printf("CEF: No CEF window handle available\n");
        }
    }
    
    void retryPositioning() {
        if (browser && widget) {
            // Try to sync position with the current widget allocation
            GtkAllocation allocation;
            gtk_widget_get_allocation(widget, &allocation);
            
            GdkRectangle frame;
            frame.x = allocation.x;
            frame.y = allocation.y;
            frame.width = allocation.width;
            frame.height = allocation.height;
            
            syncCEFPositionWithFrame(frame);
        }
    }
    
    void loadURL(const char* urlString) override {
        OperationGuard guard;
        if (!guard.isValid()) return;
        
        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
        if (browser) {
            browser->GetMainFrame()->LoadURL(CefString(urlString));
        }
    }
    
    void loadHTML(const char* htmlString) override {
        OperationGuard guard;
        if (!guard.isValid() || !htmlString) return;
        
        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
        if (browser) {
            // Create a data URI for the HTML content
            std::string dataUri = "data:text/html;charset=utf-8,";
            dataUri += htmlString;
            browser->GetMainFrame()->LoadURL(CefString(dataUri));
        }
    }
    
    void goBack() override {
        OperationGuard guard;
        if (!guard.isValid()) return;
        
        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
        if (browser) {
            browser->GoBack();
        }
    }
    
    void goForward() override {
        OperationGuard guard;
        if (!guard.isValid()) return;
        
        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
        if (browser) {
            browser->GoForward();
        }
    }
    
    void reload() override {
        OperationGuard guard;
        if (!guard.isValid()) return;
        
        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
        if (browser) {
            browser->Reload();
        }
    }
    
    void remove() override {
        OperationGuard guard;
        if (!guard.isValid()) return;
        
        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
        if (browser) {
            // Don't nullify browser immediately - let CEF cleanup complete
            browser->GetHost()->CloseBrowser(true);
            // browser will be nullified in OnBeforeClose callback
        }
        if (widget) {
            gtk_widget_destroy(widget);
            widget = nullptr;
        }
    }
    
    bool canGoBack() override {
        OperationGuard guard;
        if (!guard.isValid()) return false;
        
        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
        return browser ? browser->CanGoBack() : false;
    }
    
    bool canGoForward() override {
        OperationGuard guard;
        if (!guard.isValid()) return false;
        
        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
        return browser ? browser->CanGoForward() : false;
    }
    
    void evaluateJavaScriptWithNoCompletion(const char* jsString) override {
        OperationGuard guard;
        if (!guard.isValid() || !jsString || strlen(jsString) == 0) {
            if (jsString && strlen(jsString) == 0) {
                printf("CEF: evaluateJavaScriptWithNoCompletion called with empty jsString\n");
            }
            return;
        }
        
        // Get browser reference without holding lock for JS execution
        CefRefPtr<CefBrowser> browserRef;
        {
            std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
            browserRef = browser;
        }
        
        if (!browserRef) {
            printf("CEF: evaluateJavaScriptWithNoCompletion called but browser is NULL\n");
            return;
        }
        
        CefRefPtr<CefFrame> frame = browserRef->GetMainFrame();
        if (!frame) {
            printf("CEF: evaluateJavaScriptWithNoCompletion - GetMainFrame returned NULL\n");
            return;
        }
        
        frame->ExecuteJavaScript(CefString(jsString), CefString(""), 0);
    }
    
    void callAsyncJavascript(const char* messageId, const char* jsString, uint32_t webviewId, uint32_t hostWebviewId, void* completionHandler) override {
        // TODO: Implement async javascript execution with completion handler
        evaluateJavaScriptWithNoCompletion(jsString);
    }
    
    void addPreloadScriptToWebView(const char* jsString) override {
        electrobunPreloadScript = jsString ? jsString : "";
        if (client) {
            client->AddPreloadScript(electrobunPreloadScript);
        }
    }
    
    void updateCustomPreloadScript(const char* jsString) override {
        customPreloadScript = jsString ? jsString : "";
        if (client) {
            client->UpdateCustomPreloadScript(customPreloadScript);
        }
    }
    
    void resize(const GdkRectangle& frame, const char* masksJson) override {
        OperationGuard guard;
        if (!guard.isValid()) return;
        
        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
        if (browser) {
            
            // CEF webviews don't have GTK widgets (widget = nullptr)
            // They manage their own X11 windows, so we only need to sync CEF positioning
            
            // Notify CEF that the browser was resized
            browser->GetHost()->WasResized();
            
            // Sync CEF browser window position using frame coordinates
            syncCEFPositionWithFrame(frame);
            
            visualBounds = frame;
        }
        maskJSON = masksJson ? masksJson : "";
        
        // Apply visual mask if maskJSON is provided
        if (masksJson && strlen(masksJson) > 0) {
            applyVisualMask();
        } else {
            // If no masks, remove any existing masks
            removeMasks();
        }
    }
    
    void applyVisualMask() override {
        
        if (!browser || maskJSON.empty()) {
            return;
        }
        
        // Parse mask rectangles from JSON
        std::vector<MaskRect> masks = parseMaskJson(maskJSON);
        if (masks.empty()) {
            return;
        }
        
        // Get the CEF browser's X11 window
        CefWindowHandle window = browser->GetHost()->GetWindowHandle();
        if (!window) {
            return;
        }
        
        // Get the X11 display
        Display* display = gdk_x11_get_default_xdisplay();
        
        // Create X11 rectangles for the mask regions
        std::vector<XRectangle> xrects;
        for (const auto& mask : masks) {
            XRectangle rect = {
                static_cast<short>(mask.x),
                static_cast<short>(mask.y),
                static_cast<unsigned short>(mask.width),
                static_cast<unsigned short>(mask.height)
            };
            xrects.push_back(rect);
        }
        
        // Apply the shape mask to the X11 window
        // This creates holes in the window where the mask rectangles are
        if (!xrects.empty()) {
            
            // First, create the base shape (full window rectangle)
            XRectangle baseRect = {
                0, 0, 
                static_cast<unsigned short>(visualBounds.width),
                static_cast<unsigned short>(visualBounds.height)
            };
            
            // Set the base shape to the full window
            XShapeCombineRectangles(display, window, ShapeBounding, 0, 0,
                                   &baseRect, 1, ShapeSet, YXBanded);
            
            // Subtract each mask rectangle individually
            for (size_t i = 0; i < xrects.size(); i++) {
                XShapeCombineRectangles(display, window, ShapeBounding, 0, 0,
                                       &xrects[i], 1, ShapeSubtract, YXBanded);
            }
            
            XFlush(display);
        }
    }
    
    void removeMasks() override {
        if (!browser) {
            return;
        }
        
        // Get the CEF browser's X11 window
        CefWindowHandle window = browser->GetHost()->GetWindowHandle();
        if (!window) {
            return;
        }
        
        // Get the X11 display
        Display* display = gdk_x11_get_default_xdisplay();
        
        // Reset the window shape to be fully opaque/visible
        // This removes any existing shape mask
        XShapeCombineMask(display, window, ShapeBounding, 0, 0, None, ShapeSet);
        XFlush(display);
        
        // Clear the mask JSON
        maskJSON.clear();
    }
    
    void toggleMirrorMode(bool enable) override {
        mirrorModeEnabled = enable;
        // TODO: Implement mirror mode for CEF
    }
    
    void setHidden(bool hidden) override {
        if (browser) {
            // Use X11 APIs to show/hide the CEF window
            CefWindowHandle window = browser->GetHost()->GetWindowHandle();
            if (window) {
                Display* display = gdk_x11_get_default_xdisplay();
                if (hidden) {
                    XUnmapWindow(display, window);
                } else {
                    XMapWindow(display, window);
                }
                XFlush(display);
            }
        }
    }
    
    void setTransparent(bool transparent) override {
        if (browser) {
            // Use X11 APIs to set window transparency
            CefWindowHandle window = browser->GetHost()->GetWindowHandle();
            if (window) {
                Display* display = gdk_x11_get_default_xdisplay();
                if (transparent) {
                    // Set window to be transparent
                    Atom atom = XInternAtom(display, "_NET_WM_WINDOW_OPACITY", False);
                    unsigned long opacity = 0xC0000000; // 75% opacity
                    XChangeProperty(display, window, atom, XA_CARDINAL, 32,
                                   PropModeReplace, (unsigned char*)&opacity, 1);
                } else {
                    // Remove transparency
                    Atom atom = XInternAtom(display, "_NET_WM_WINDOW_OPACITY", False);
                    XDeleteProperty(display, window, atom);
                }
                XFlush(display);
            }
        }
    }
    
    void setPassthrough(bool enable) override {
        AbstractView::setPassthrough(enable); // Set the flag

        if (browser) {
            // Use X11 input shape extension for mouse passthrough
            CefWindowHandle window = browser->GetHost()->GetWindowHandle();
            if (window) {
                Display* display = gdk_x11_get_default_xdisplay();
                if (enable) {
                    // Make window invisible to mouse events
                    XRectangle rect = {0, 0, 0, 0}; // Empty rectangle
                    XShapeCombineRectangles(display, window, ShapeInput, 0, 0,
                                           &rect, 1, ShapeSet, YXBanded);
                } else {
                    // Reset input shape to allow mouse events
                    XShapeCombineMask(display, window, ShapeInput, 0, 0, None, ShapeSet);
                }
                XFlush(display);
            }
        }
    }

    void findInPage(const char* searchText, bool forward, bool matchCase) override {
        if (!browser) return;

        CefRefPtr<CefBrowserHost> host = browser->GetHost();
        if (!host) return;

        if (!searchText || strlen(searchText) == 0) {
            host->StopFinding(true);
            return;
        }

        // Use CEF's native find functionality
        host->Find(CefString(searchText), forward, matchCase, false);
    }

    void stopFindInPage() override {
        if (!browser) return;

        CefRefPtr<CefBrowserHost> host = browser->GetHost();
        if (host) {
            host->StopFinding(true); // true = clear selection
        }
    }
};



// Container for managing multiple webviews
class ContainerView {
public:
    GtkWidget* window;
    GtkWidget* overlay;
    std::vector<std::shared_ptr<AbstractView>> abstractViews;
    AbstractView* activeWebView = nullptr;
    uint32_t windowId;
    WindowCloseCallback closeCallback;
    WindowMoveCallback moveCallback;
    WindowResizeCallback resizeCallback;
    WindowFocusCallback focusCallback;

    ContainerView(GtkWidget* window) : window(window), windowId(0), closeCallback(nullptr), moveCallback(nullptr), resizeCallback(nullptr), focusCallback(nullptr) {
        // Create an overlay container as the main container
        overlay = gtk_overlay_new();
        gtk_container_add(GTK_CONTAINER(window), overlay);
        
        gtk_widget_show(overlay);
    }
    
    ContainerView(GtkWidget* window, uint32_t windowId, WindowCloseCallback closeCallback, WindowMoveCallback moveCallback, WindowResizeCallback resizeCallback, WindowFocusCallback focusCallback)
        : window(window), windowId(windowId), closeCallback(closeCallback), moveCallback(moveCallback), resizeCallback(resizeCallback), focusCallback(focusCallback) {
        // Create an overlay container as the main container
        overlay = gtk_overlay_new();
        gtk_container_add(GTK_CONTAINER(window), overlay);
        
        gtk_widget_show(overlay);
    }
    
    
    void addWebview(std::shared_ptr<AbstractView> view, double x = 0, double y = 0) {
        abstractViews.insert(abstractViews.begin(), view);
        if (view->widget) {
            // Prevent webview from affecting window size
            g_object_set(view->widget,
                        "expand", FALSE,
                        "hexpand", FALSE,
                        "vexpand", FALSE,
                        NULL);
            
            // Add webview to overlay container
            if (abstractViews.size() == 1) {
                // First webview becomes the base layer (determines overlay size)
                printf("DEBUG: Adding first webview (ID: %u) to container\n", view->webviewId);
                fflush(stdout);
                gtk_container_add(GTK_CONTAINER(overlay), view->widget);
                
                // Now that widget is anchored, realize it for rendering
                gtk_widget_realize(view->widget);
                printf("DEBUG: First webview (ID: %u) realized successfully\n", view->webviewId);
                fflush(stdout);
            } else {
                // For OOPIFs, wrap in a fixed container to enforce size constraints
                GtkWidget* wrapper = gtk_fixed_new();
                gtk_widget_set_size_request(wrapper, 1, 1); // Don't affect overlay size
                
                // Make wrapper receive no events (pass through to widgets below)
                gtk_widget_set_events(wrapper, 0);
                gtk_widget_set_can_focus(wrapper, FALSE);
                
                // Add webview to wrapper at 0,0
                printf("DEBUG: Adding subsequent webview (ID: %u) to wrapper\n", view->webviewId);
                fflush(stdout);
                gtk_fixed_put(GTK_FIXED(wrapper), view->widget, 0, 0);
                
                // Now that widget is anchored, realize it for rendering
                gtk_widget_realize(view->widget);
                printf("DEBUG: Subsequent webview (ID: %u) realized successfully\n", view->webviewId);
                fflush(stdout);
                
                // Add wrapper as overlay layer
                gtk_overlay_add_overlay(GTK_OVERLAY(overlay), wrapper);
                
                // Make the wrapper pass-through for events outside the webview
                gtk_overlay_set_overlay_pass_through(GTK_OVERLAY(overlay), wrapper, TRUE);
                
                // Position wrapper using margins (will be updated in resize)
                gtk_widget_set_margin_start(wrapper, (int)x);
                gtk_widget_set_margin_top(wrapper, (int)y);
                
                gtk_widget_show(wrapper);
                
                // Store wrapper reference
                g_object_set_data(G_OBJECT(view->widget), "wrapper", wrapper);
            }
            
            gtk_widget_show(view->widget);
        }
    }
    
    void removeView(uint32_t webviewId) {
        auto it = std::find_if(abstractViews.begin(), abstractViews.end(),
            [webviewId](const std::shared_ptr<AbstractView>& view) {
                return view->webviewId == webviewId;
            });
        
        if (it != abstractViews.end()) {
            if ((*it)->widget) {
                gtk_widget_destroy((*it)->widget);
            }
            abstractViews.erase(it);
        }
    }
    
    void resizeAutoSizingViews(int width, int height) {
        // Skip if no webviews have been added yet (timing issue during window creation)
        if (abstractViews.empty()) {
            return;
        }
        
        GdkRectangle frame = { 0, 0, width, height };
        
        for (auto& view : abstractViews) {
            
            if (view->fullSize) {
                // Auto-resize webviews should fill the entire window
                view->resize(frame, "");
            }
            // OOPIFs (fullSize=false) keep their positioning and don't auto-resize
        }
        
        // Ensure the overlay spans the entire window for proper layering
        if (overlay) {
            gtk_widget_set_size_request(overlay, width, height);
        }
    }
};

// Window configure callback for move and resize events
static gboolean onWindowConfigure(GtkWidget* widget, GdkEventConfigure* event, gpointer user_data) {
    ContainerView* container = static_cast<ContainerView*>(user_data);
    if (container) {
        // Handle resize events
        container->resizeAutoSizingViews(event->width, event->height);
        
        // Handle move events - call the move callback with position
        if (container->moveCallback) {
            container->moveCallback(container->windowId, event->x, event->y);
        }
        
        // Handle resize events - call the resize callback with position and size
        if (container->resizeCallback) {
            container->resizeCallback(container->windowId, event->x, event->y, event->width, event->height);
        }
    }
    return FALSE; // Let other handlers process this event too
}

// Mouse move callback for debugging
static gboolean onMouseMove(GtkWidget* widget, GdkEventMotion* event, gpointer user_data) {

    return FALSE; // Let other handlers process this event too
}

// Window delete event callback - handles X button clicks
static gboolean onWindowDeleteEvent(GtkWidget* widget, GdkEvent* event, gpointer user_data) {
    printf("DEBUG: Window delete event triggered\n");
    ContainerView* container = static_cast<ContainerView*>(user_data);
    if (container) {
        printf("DEBUG: Container found for window ID: %u\n", container->windowId);
        if (container->closeCallback) {
            printf("DEBUG: Calling close callback for window ID: %u\n", container->windowId);
            container->closeCallback(container->windowId);
        } else {
            printf("DEBUG: No close callback set for window ID: %u\n", container->windowId);
        }
    } else {
        printf("DEBUG: No container found in delete event handler\n");
    }
    
    // Hide the window immediately to give user feedback
    gtk_widget_hide(widget);
    
    // Schedule the window destruction on the next iteration of the main loop
    // This allows the callback to complete before destroying the window
    g_idle_add_full(G_PRIORITY_HIGH, [](gpointer data) -> gboolean {
        GtkWidget* window = GTK_WIDGET(data);
        printf("DEBUG: Destroying window from idle callback\n");
        gtk_widget_destroy(window);
        return G_SOURCE_REMOVE;
    }, widget, nullptr);
    
    // Return TRUE to prevent the default handler from running
    // We're handling the destruction ourselves
    return TRUE;
}

// Tray implementation using AppIndicator
#ifndef NO_APPINDICATOR
class TrayItem {
public:
    uint32_t trayId;
    AppIndicator* indicator;
    GtkWidget* menu;
    ZigStatusItemHandler clickHandler;
    std::string title;
    std::string imagePath;
    
    TrayItem(uint32_t id, const char* title, const char* pathToImage, bool isTemplate, ZigStatusItemHandler handler) 
        : trayId(id), indicator(nullptr), menu(nullptr), clickHandler(handler),
          title(title ? title : ""), imagePath(pathToImage ? pathToImage : "") {
        
        // Create unique indicator ID
        std::string indicatorId = "electrobun-tray-" + std::to_string(id);
        
        // Create app indicator
        indicator = app_indicator_new(indicatorId.c_str(), 
                                    !imagePath.empty() ? imagePath.c_str() : "application-default-icon",
                                    APP_INDICATOR_CATEGORY_APPLICATION_STATUS);
        
        if (indicator) {
            app_indicator_set_status(indicator, APP_INDICATOR_STATUS_ACTIVE);
            
            if (!this->title.empty()) {
                app_indicator_set_title(indicator, title);
            }
            
            // Create default menu (required for AppIndicator)
            createDefaultMenu();
        }
    }
    
    ~TrayItem() {
        if (indicator) {
            app_indicator_set_status(indicator, APP_INDICATOR_STATUS_PASSIVE);
            g_object_unref(indicator);
        }
        if (menu) {
            gtk_widget_destroy(menu);
        }
    }
    
    void setTitle(const char* newTitle) {
        title = newTitle ? newTitle : "";
        if (indicator) {
            app_indicator_set_title(indicator, title.c_str());
        }
    }
    
    void setImage(const char* newImage) {
        imagePath = newImage ? newImage : "";
        if (indicator && !imagePath.empty()) {
            app_indicator_set_icon_full(indicator, imagePath.c_str(), "Electrobun Tray Icon");
        }
    }
    
    void setMenu(const char* jsonString) {
        if (menu) {
            gtk_widget_destroy(menu);
            menu = nullptr;
        }
        
        if (!jsonString || strlen(jsonString) == 0) {
            createDefaultMenu();
            return;
        }
        
        // Parse JSON menu configuration using our simple parser
        try {
            std::vector<MenuJsonValue> menuItems = parseMenuJson(std::string(jsonString));
            menu = createMenuFromParsedItems(menuItems, this->clickHandler, trayId);
            
            if (menu) {
                gtk_widget_show_all(menu);
                if (indicator) {
                    app_indicator_set_menu(indicator, GTK_MENU(menu));
                }
            }
        } catch (const std::exception& e) {
            // Fallback to default menu
            createDefaultMenu();
        }
    }
    
private:
    void createDefaultMenu() {
        menu = gtk_menu_new();
        
        GtkWidget* defaultItem = gtk_menu_item_new_with_label("Electrobun App");
        gtk_widget_set_sensitive(defaultItem, FALSE);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu), defaultItem);
        
        gtk_widget_show_all(menu);
        
        if (indicator) {
            app_indicator_set_menu(indicator, GTK_MENU(menu));
        }
    }
    
    static void onMenuItemClick(GtkMenuItem* menuItem, gpointer userData) {
        TrayItem* tray = static_cast<TrayItem*>(userData);
        if (tray->clickHandler) {
            tray->clickHandler(tray->trayId, "menu-click");
        }
    }
    
    static void onQuitClick(GtkMenuItem* menuItem, gpointer userData) {
        TrayItem* tray = static_cast<TrayItem*>(userData);
        if (tray->clickHandler) {
            tray->clickHandler(tray->trayId, "quit");
        }
    }
};
#endif // NO_APPINDICATOR

// Global state
static std::map<uint32_t, std::shared_ptr<ContainerView>> g_containers;
static std::mutex g_containersMutex;
#ifndef NO_APPINDICATOR
static std::map<uint32_t, std::shared_ptr<TrayItem>> g_trays;
static std::mutex g_traysMutex;
#endif
static bool g_gtkInitialized = false;
static std::mutex g_gtkInitMutex;
static std::condition_variable g_gtkInitCondition;

// Window dragging state
static GtkWidget* g_draggedWindow = nullptr;
static gint g_dragStartX = 0;
static gint g_dragStartY = 0;
static guint g_motionHandlerId = 0;
static guint g_buttonReleaseHandlerId = 0;

// X11 window management
static std::map<uint32_t, std::shared_ptr<X11Window>> g_x11_windows;
static std::map<Window, uint32_t> g_x11_window_to_id;
static std::mutex g_x11WindowsMutex;

// X11 event processing for OSR windows
void processX11EventsForOSR(uint32_t windowId, CefRefPtr<ElectrobunClient> client) {
    // Check if shutting down
    if (g_shuttingDown.load()) return;
    
    std::shared_ptr<X11Window> x11win;
    {
        std::lock_guard<std::mutex> lock(g_x11WindowsMutex);
        auto it = g_x11_windows.find(windowId);
        if (it != g_x11_windows.end() && it->second && it->second->transparent) {
            x11win = it->second;
        }
    }
    
    if (!x11win) return;
    
    Display* display = x11win->display;
    Window window = x11win->window;
    
    // Process ALL pending X11 events to avoid missing any
    XEvent event;
    int events_processed = 0;
    
    // Sync to ensure we get all events
    XSync(display, False);
    
    while (XPending(display) > 0) {
        XNextEvent(display, &event);
        events_processed++;
        
        if (event.xany.window != window) continue;
        
        switch (event.type) {
            case ButtonPress:
            case ButtonRelease: {
                CefMouseEvent mouse_event;
                mouse_event.x = event.xbutton.x;
                mouse_event.y = event.xbutton.y;
                mouse_event.modifiers = 0; // TODO: Convert X11 modifiers
                
                // Forward to CEF with proper protection
                if (client) {
                    CefRefPtr<CefBrowser> browser;
                    {
                        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
                        browser = client->GetBrowser();
                    }
                    
                    if (browser) {
                        auto host = browser->GetHost();
                    
                    // Determine mouse button type
                    cef_mouse_button_type_t button_type = MBT_LEFT;
                    if (event.xbutton.button == Button1) button_type = MBT_LEFT;
                    else if (event.xbutton.button == Button3) button_type = MBT_RIGHT;
                    else if (event.xbutton.button == Button2) button_type = MBT_MIDDLE;
                    
                    bool mouse_up = (event.type == ButtonRelease);
                    
                    // Send the mouse click event
                    host->SendMouseClickEvent(mouse_event, button_type, mouse_up, 1);
                    
                    // Debug: only log button presses for now
                    if (event.type == ButtonPress) {
                        printf("CEF OSR: Click at (%d, %d)\n", event.xbutton.x, event.xbutton.y);
                    }
                    }
                }
                break;
            }
            case MotionNotify: {
                CefMouseEvent mouse_event;
                mouse_event.x = event.xmotion.x;
                mouse_event.y = event.xmotion.y;
                mouse_event.modifiers = 0;
                
                // Forward to CEF with proper protection
                if (client) {
                    CefRefPtr<CefBrowser> browser;
                    {
                        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
                        browser = client->GetBrowser();
                    }
                    
                    if (browser) {
                        auto host = browser->GetHost();
                        host->SendMouseMoveEvent(mouse_event, false);
                    }
                }
                break;
            }
            case FocusIn:
            case FocusOut: {
                // Handle focus events for OSR windows
                if (client) {
                    CefRefPtr<CefBrowser> browser;
                    {
                        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
                        browser = client->GetBrowser();
                    }
                    
                    if (browser) {
                        auto host = browser->GetHost();
                        host->SetFocus(event.type == FocusIn);
                    }
                }
                break;
            }
            case EnterNotify: {
                // Focus window on mouse enter for better responsiveness
                if (client) {
                    CefRefPtr<CefBrowser> browser;
                    {
                        std::lock_guard<std::mutex> lock(g_cefBrowserMutex);
                        browser = client->GetBrowser();
                    }
                    
                    if (browser) {
                        auto host = browser->GetHost();
                        host->SetFocus(true);
                        
                        // Also ensure the X11 window has focus
                        XSetInputFocus(display, window, RevertToParent, CurrentTime);
                    }
                }
                break;
            }
            case LeaveNotify: {
                // Optional: Could unfocus on leave, but keeping focus is usually better
                break;
            }
        }
    }
    
    XFlush(display);
}

// Helper function to get ContainerView overlay for a window
GtkWidget* getContainerViewOverlay(GtkWidget* window) {
    std::lock_guard<std::mutex> lock(g_containersMutex);
    for (auto& [id, container] : g_containers) {
        if (container->window == window) {
            return container->overlay;
        }
    }
    return nullptr;
}

// Menu item click callback
static void onMenuItemActivate(GtkMenuItem* menuItem, gpointer userData) {
    MenuItemData* itemData = static_cast<MenuItemData*>(userData);
    
    if (itemData && itemData->clickHandler) {
        try {
            itemData->clickHandler(itemData->menuId, itemData->action.c_str());
        } catch (...) {
            // Handle exception silently
        }
    }
}

// Create GTK menu from parsed menu items
GtkWidget* createMenuFromParsedItems(const std::vector<MenuJsonValue>& items, ZigStatusItemHandler clickHandler, uint32_t trayId) {
    GtkWidget* menu = gtk_menu_new();
    
    for (const auto& item : items) {
        if (item.type == "divider" || item.type == "separator") {
            // Create separator
            GtkWidget* separator = gtk_separator_menu_item_new();
            gtk_menu_shell_append(GTK_MENU_SHELL(menu), separator);
        } else {
            // Skip hidden items entirely
            if (item.hidden) {
                continue;
            }
            
            // Create normal menu item
            std::string displayLabel = !item.label.empty() ? item.label : 
                                     (!item.role.empty() ? item.role : "Menu Item");
            
            GtkWidget* menuItem;
            if (item.checked) {
                menuItem = gtk_check_menu_item_new_with_label(displayLabel.c_str());
                gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(menuItem), TRUE);
            } else {
                menuItem = gtk_menu_item_new_with_label(displayLabel.c_str());
            }
            
            gtk_widget_set_sensitive(menuItem, item.enabled);
            
            // Create menu item data for callback
            auto itemData = std::make_shared<MenuItemData>();
            itemData->menuId = trayId;
            itemData->action = !item.action.empty() ? item.action : 
                              (!item.role.empty() ? item.role : "");
            itemData->type = item.type;
            itemData->clickHandler = clickHandler;
            
            uint32_t currentMenuId = g_nextMenuId++;
            g_menuItems[currentMenuId] = itemData;
            
            // Connect click handler
            g_signal_connect(menuItem, "activate", G_CALLBACK(onMenuItemActivate), itemData.get());
            
            // Handle submenu
            if (!item.submenu.empty()) {
                GtkWidget* submenu = createMenuFromParsedItems(item.submenu, clickHandler, trayId);
                if (submenu) {
                    gtk_menu_item_set_submenu(GTK_MENU_ITEM(menuItem), submenu);
                }
            }
            
            gtk_menu_shell_append(GTK_MENU_SHELL(menu), menuItem);
        }
    }
    
    return menu;
}

// Create GTK menu bar for application menus (File, Edit, etc.)
GtkWidget* createApplicationMenuBar(const std::vector<MenuJsonValue>& items, ZigStatusItemHandler clickHandler) {
    GtkWidget* menuBar = gtk_menu_bar_new();
    
    for (const auto& item : items) {
        if (item.type == "divider" || item.type == "separator") {
            // Skip separators at the top level of menu bar (they don't make sense there)
            continue;
        } else {
            // Skip hidden items entirely
            if (item.hidden) {
                continue;
            }
            
            // Create top-level menu item (like "File", "Edit", etc.)
            std::string displayLabel = !item.label.empty() ? item.label : 
                                     (!item.role.empty() ? item.role : "Menu");
            
            GtkWidget* menuItem = gtk_menu_item_new_with_label(displayLabel.c_str());
            
            // Set enabled/disabled state
            gtk_widget_set_sensitive(menuItem, item.enabled);
            
            // If this item has a submenu, create it
            if (!item.submenu.empty()) {
                GtkWidget* submenu = createMenuFromParsedItems(item.submenu, clickHandler, 0);
                gtk_menu_item_set_submenu(GTK_MENU_ITEM(menuItem), submenu);
            } else if (!item.action.empty()) {
                // If no submenu but has an action, create a menu item data and connect signal
                auto itemData = std::make_shared<MenuItemData>();
                itemData->menuId = g_nextMenuId++;
                itemData->action = item.action;
                itemData->type = item.type;
                itemData->clickHandler = clickHandler;
                
                g_menuItems[itemData->menuId] = itemData;
                
                g_signal_connect(menuItem, "activate", G_CALLBACK(onMenuItemActivate), itemData.get());
            }
            
            gtk_menu_shell_append(GTK_MENU_SHELL(menuBar), menuItem);
        }
    }
    
    gtk_widget_show_all(menuBar);
    return menuBar;
}

// Apply the stored application menu to a specific window
// NOTE: Application menus are not supported on Linux due to platform differences.
// On Linux, application menus overlay over content rather than shifting content down
// like on Windows/macOS, which interferes with OOPIF positioning and masking.
// Developers should implement menu UI directly in their HTML instead.
void applyApplicationMenuToWindow(GtkWidget* window) {
    printf("Application menus are not supported on Linux. Implement menu UI in your webview HTML instead.\n");
    fflush(stdout);
}

// Apply the stored application menu to a specific X11 window
// NOTE: Application menus are not supported on Linux due to platform differences.
// X11 application menus would require complex webview positioning adjustments
// that could interfere with OOPIF layering and maskJSON cutout mechanisms.
// Developers should implement menu UI directly in their HTML instead.
void applyApplicationMenuToX11Window(X11Window* x11win) {
    printf("Application menus are not supported on Linux. Implement menu UI in your webview HTML instead.\n");
    fflush(stdout);
}

// views:// URI scheme handler callback
static void handleViewsURIScheme(WebKitURISchemeRequest* request, gpointer user_data) {
    const char* uri = webkit_uri_scheme_request_get_uri(request);
    
    // Parse the full URI to get everything after views://
    // For views://webviewtag/index.html, we want "webviewtag/index.html"
    const char* fullPath = "index.html"; // default
    if (uri && strncmp(uri, "views://", 8) == 0) {
        fullPath = uri + 8; // Skip "views://"
    }
    
    // Check if this is the internal HTML request
    if (strcmp(fullPath, "internal/index.html") == 0) {
        fflush(stdout);
        // Use stored HTML content instead of JSCallback
        const char* htmlContent = getWebviewHTMLContent(1); // TODO: get webviewId properly
        if (htmlContent) {
            gsize contentLength = strlen(htmlContent);
            GInputStream* stream = g_memory_input_stream_new_from_data(g_strdup(htmlContent), contentLength, g_free);
            webkit_uri_scheme_request_finish(request, stream, contentLength, "text/html");
            g_object_unref(stream);
            free((void*)htmlContent); // Free the strdup'd memory
            fflush(stdout);
            return;
        } else {
            fflush(stdout);
            const char* fallbackHTML = "<html><body>No content set</body></html>";
            gsize contentLength = strlen(fallbackHTML);
            GInputStream* stream = g_memory_input_stream_new_from_data(g_strdup(fallbackHTML), contentLength, g_free);
            webkit_uri_scheme_request_finish(request, stream, contentLength, "text/html");
            g_object_unref(stream);
            return;
        }
    }
    
    // Build paths relative to current directory (bin)
    char* cwd = g_get_current_dir();
    gchar* resourcesDir = g_build_filename(cwd, "..", "Resources", nullptr);
    gchar* asarPath = g_build_filename(resourcesDir, "app.asar", nullptr);

    gchar* fileContents = nullptr;
    gsize fileSize = 0;
    bool foundFile = false;

    // Check if ASAR archive exists
    if (g_file_test(asarPath, G_FILE_TEST_EXISTS)) {
        // Thread-safe lazy-load ASAR archive on first use
        std::call_once(g_asarArchiveInitFlag, [asarPath]() {
            g_asarArchive = asar_open(asarPath);
            if (g_asarArchive) {
                fflush(stdout);
            } else {
                printf("ERROR WebKit loadViewsFile: Failed to open ASAR archive at %s\n", asarPath);
                fflush(stdout);
            }
        });

        // If ASAR archive is loaded, try to read from it
        if (g_asarArchive) {
            // The ASAR contains the entire app directory, so prepend "views/" to the path
            std::string asarFilePath = "views/" + std::string(fullPath);

            size_t asarFileSize = 0;
            const uint8_t* fileData = asar_read_file(g_asarArchive, asarFilePath.c_str(), &asarFileSize);

            if (fileData && asarFileSize > 0) {
                fflush(stdout);
                // Copy the data (glib will free it)
                fileContents = (gchar*)g_memdup2(fileData, asarFileSize);
                fileSize = asarFileSize;
                foundFile = true;
                // Free the ASAR buffer
                asar_free_buffer(fileData, asarFileSize);
            } else {
                fflush(stdout);
                // Fall through to flat file reading
            }
        }
    }

    // Fallback: Read from flat file system (for non-ASAR builds or missing files)
    if (!foundFile) {
        gchar* viewsDir = g_build_filename(resourcesDir, "app", "views", nullptr);
        gchar* filePath = g_build_filename(viewsDir, fullPath, nullptr);

        fflush(stdout);

        // Check if file exists and read it
        if (g_file_test(filePath, G_FILE_TEST_EXISTS)) {
            GError* error = nullptr;
            if (g_file_get_contents(filePath, &fileContents, &fileSize, &error)) {
                foundFile = true;
            } else {
                if (error) {
                    printf("ERROR WebKit: Failed to read file: %s\n", error->message);
                    fflush(stdout);
                    g_error_free(error);
                }
            }
        } else {
            printf("File not found: %s\n", filePath);
            fflush(stdout);
        }

        g_free(viewsDir);
        g_free(filePath);
    }

    // Send response if file was found
    if (foundFile && fileContents) {
        // Determine MIME type using shared function
        std::string mimeTypeStr = getMimeTypeFromUrl(fullPath);
        const char* mimeType = mimeTypeStr.c_str();

        // Create response
        GInputStream* stream = g_memory_input_stream_new_from_data(fileContents, fileSize, g_free);
        webkit_uri_scheme_request_finish(request, stream, fileSize, mimeType);
        g_object_unref(stream);
    } else {
        // Return 404 error
        GError* responseError = g_error_new(G_IO_ERROR, G_IO_ERROR_NOT_FOUND, "File not found: %s", fullPath);
        webkit_uri_scheme_request_finish_error(request, responseError);
        g_error_free(responseError);
    }

    // Cleanup
    g_free(cwd);
    g_free(resourcesDir);
    g_free(asarPath);
}

void initializeGTK() {
    {
        std::unique_lock<std::mutex> lock(g_gtkInitMutex);
        if (!g_gtkInitialized) {
            // Force X11 backend on Wayland systems
            setenv("GDK_BACKEND", "x11", 1);
            
            // Disable setlocale before gtk_init to prevent CEF conflicts
            gtk_disable_setlocale();
            gtk_init(nullptr, nullptr);
            
            // Install X11 error handler for debugging
            XSetErrorHandler(x11_error_handler);
            
            g_gtkInitialized = true;
            
            // Register the views:// URI scheme handler AFTER GTK is initialized
            WebKitWebContext* context = webkit_web_context_get_default();
            webkit_web_context_register_uri_scheme(context, "views", handleViewsURIScheme, nullptr, nullptr);
        }
    }
    // Notify all waiting threads that GTK is initialized
    g_gtkInitCondition.notify_all();
}

// Helper function to wait for GTK initialization
void waitForGTKInit() {
    std::unique_lock<std::mutex> lock(g_gtkInitMutex);
    g_gtkInitCondition.wait(lock, []{ return g_gtkInitialized; });
}

// Helper function to dispatch to main thread synchronously
template<typename Func>
auto dispatch_sync_main(Func&& func) -> decltype(func()) {
    using ReturnType = decltype(func());
    
    // If already on main thread, just execute
    if (g_main_context_is_owner(g_main_context_default())) {
        return func();
    }
    
    // Structure to hold the function and result
    struct DispatchData {
        Func func;
        ReturnType result;
        GMutex mutex;
        GCond cond;
        bool completed;
        std::exception_ptr exception;
        
        DispatchData(Func&& f) : func(std::forward<Func>(f)), completed(false) {
            g_mutex_init(&mutex);
            g_cond_init(&cond);
        }
        
        ~DispatchData() {
            g_mutex_clear(&mutex);
            g_cond_clear(&cond);
        }
    };
    
    auto data = std::make_unique<DispatchData>(std::forward<Func>(func));
    
    // Lambda to run on main thread
    auto callback = [](gpointer user_data) -> gboolean {
        auto* dispatch_data = static_cast<DispatchData*>(user_data);
        
        try {
            dispatch_data->result = dispatch_data->func();
        } catch (...) {
            dispatch_data->exception = std::current_exception();
        }
        
        g_mutex_lock(&dispatch_data->mutex);
        dispatch_data->completed = true;
        g_cond_signal(&dispatch_data->cond);
        g_mutex_unlock(&dispatch_data->mutex);
        
        return G_SOURCE_REMOVE;
    };
    
    // Schedule on main thread
    g_idle_add(callback, data.get());
    
    // Wait for completion
    g_mutex_lock(&data->mutex);
    while (!data->completed) {
        g_cond_wait(&data->cond, &data->mutex);
    }
    g_mutex_unlock(&data->mutex);
    
    // Rethrow any exception that occurred
    if (data->exception) {
        std::rethrow_exception(data->exception);
    }
    
    return data->result;
}

// Helper for void functions
template<typename Func>
typename std::enable_if<std::is_void<decltype(std::declval<Func>()())>::value>::type
dispatch_sync_main_void(Func&& func) {
    if (g_main_context_is_owner(g_main_context_default())) {
        func();
        return;
    }
    
    struct DispatchData {
        Func func;
        GMutex mutex;
        GCond cond;
        bool completed;
        std::exception_ptr exception;
        
        DispatchData(Func&& f) : func(std::forward<Func>(f)), completed(false) {
            g_mutex_init(&mutex);
            g_cond_init(&cond);
        }
        
        ~DispatchData() {
            g_mutex_clear(&mutex);
            g_cond_clear(&cond);
        }
    };
    
    auto data = std::make_unique<DispatchData>(std::forward<Func>(func));
    
    auto callback = [](gpointer user_data) -> gboolean {
        auto* dispatch_data = static_cast<DispatchData*>(user_data);
        
        try {
            dispatch_data->func();
        } catch (...) {
            dispatch_data->exception = std::current_exception();
        }
        
        g_mutex_lock(&dispatch_data->mutex);
        dispatch_data->completed = true;
        g_cond_signal(&dispatch_data->cond);
        g_mutex_unlock(&dispatch_data->mutex);
        
        return G_SOURCE_REMOVE;
    };
    
    g_idle_add(callback, data.get());
    
    g_mutex_lock(&data->mutex);
    while (!data->completed) {
        g_cond_wait(&data->cond, &data->mutex);
    }
    g_mutex_unlock(&data->mutex);
    
    if (data->exception) {
        std::rethrow_exception(data->exception);
    }
}

// Store for partition-specific contexts (for session storage synchronization)
static std::map<std::string, WebKitWebContext*> g_partitionContexts;

// Helper function to automatically set window icon from standard location
static void autoSetWindowIcon(void* window) {
    if (!window) return;
    
    // Standard icon location: Resources/appIcon.png
    const char* iconPath = "Resources/appIcon.png";
    
    // Check if icon exists
    struct stat buffer;
    if (stat(iconPath, &buffer) != 0) {
        // Icon doesn't exist, nothing to do
        return;
    }
    
    GError* error = nullptr;
    GdkPixbuf* pixbuf = gdk_pixbuf_new_from_file(iconPath, &error);
    
    if (pixbuf) {
        if (GTK_IS_WIDGET(window)) {
            gtk_window_set_icon(GTK_WINDOW(window), pixbuf);
        } else {
            // For X11/CEF windows
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                setX11WindowIcon(x11win, pixbuf);
            }
        }
        g_object_unref(pixbuf);
    } else {
        if (error) {
            g_error_free(error);
        }
    }
}

// Helper function to set X11 window icon from GdkPixbuf
static void setX11WindowIcon(X11Window* x11win, GdkPixbuf* pixbuf) {
    if (!x11win || !x11win->display || !x11win->window || !pixbuf) return;
    
    // Get pixel data
    int width = gdk_pixbuf_get_width(pixbuf);
    int height = gdk_pixbuf_get_height(pixbuf);
    int channels = gdk_pixbuf_get_n_channels(pixbuf);
    guchar* pixels = gdk_pixbuf_get_pixels(pixbuf);
    int rowstride = gdk_pixbuf_get_rowstride(pixbuf);
    
    // Convert to ARGB format for X11
    std::vector<unsigned long> icon_data;
    icon_data.push_back(width);
    icon_data.push_back(height);
    
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            guchar* pixel = pixels + y * rowstride + x * channels;
            unsigned long argb = 0;
            
            if (channels == 4) {
                // RGBA
                argb = ((unsigned long)pixel[3] << 24) | // A
                       ((unsigned long)pixel[0] << 16) | // R
                       ((unsigned long)pixel[1] << 8)  | // G
                       ((unsigned long)pixel[2]);        // B
            } else if (channels == 3) {
                // RGB (no alpha)
                argb = (0xFFUL << 24) |                  // A (opaque)
                       ((unsigned long)pixel[0] << 16) | // R
                       ((unsigned long)pixel[1] << 8)  | // G
                       ((unsigned long)pixel[2]);        // B
            }
            
            icon_data.push_back(argb);
        }
    }
    
    // Set _NET_WM_ICON property
    Atom net_wm_icon = XInternAtom(x11win->display, "_NET_WM_ICON", False);
    XChangeProperty(x11win->display, x11win->window, net_wm_icon,
                  XA_CARDINAL, 32, PropModeReplace,
                  (unsigned char*)icon_data.data(), icon_data.size());
    
    XFlush(x11win->display);
}

// Get or create a WebKit context for a partition
static WebKitWebContext* getContextForPartition(const char* partitionIdentifier) {
    std::string partition = partitionIdentifier ? partitionIdentifier : "";

    auto it = g_partitionContexts.find(partition);
    if (it != g_partitionContexts.end()) {
        return it->second;
    }

    WebKitWebContext* context = nullptr;

    if (partition.empty()) {
        // Default: use default context
        context = webkit_web_context_get_default();
        g_object_ref(context); // Keep consistent reference counting
    } else {
        bool isPersistent = partition.substr(0, 8) == "persist:";

        if (isPersistent) {
            std::string partitionName = partition.substr(8);
            std::string appIdentifier = !g_electrobunIdentifier.empty() ? g_electrobunIdentifier : "Electrobun";
            if (!g_electrobunChannel.empty()) {
                appIdentifier += "-" + g_electrobunChannel;
            }

            char* home = getenv("HOME");
            std::string basePath = home ? std::string(home) : "/tmp";
            std::string dataPath = basePath + "/.local/share/" + appIdentifier + "/WebKit/Partitions/" + partitionName;
            std::string cachePath = basePath + "/.cache/" + appIdentifier + "/WebKit/Partitions/" + partitionName;

            g_mkdir_with_parents(dataPath.c_str(), 0755);
            g_mkdir_with_parents(cachePath.c_str(), 0755);

            WebKitWebsiteDataManager* dataManager = webkit_website_data_manager_new(
                "base-data-directory", dataPath.c_str(),
                "base-cache-directory", cachePath.c_str(),
                NULL
            );
            context = webkit_web_context_new_with_website_data_manager(dataManager);
            g_object_unref(dataManager);
        } else {
            WebKitWebsiteDataManager* dataManager = webkit_website_data_manager_new_ephemeral();
            context = webkit_web_context_new_with_website_data_manager(dataManager);
            g_object_unref(dataManager);
        }

        // Register views:// scheme handler for this partition context
        webkit_web_context_register_uri_scheme(context, "views", handleViewsURIScheme, nullptr, nullptr);
        
        g_partitionContexts[partition] = context;
    }

    return context;
}

extern "C" {

// Constructor to run when library is loaded
__attribute__((constructor))
void on_library_load() {
}

// Timer callback to process CEF message loop
gboolean cef_timer_callback(gpointer user_data) {
    // Check if we're shutting down
    if (g_shuttingDown.load()) {
        return G_SOURCE_REMOVE;
    }

    if (g_cefInitialized) {
        CefDoMessageLoopWork();
    }

    return G_SOURCE_CONTINUE; // Keep the timer running
}

// Global debounce state
static std::map<uint32_t, std::chrono::steady_clock::time_point> g_lastResizeTime;
static std::map<uint32_t, std::pair<int, int>> g_lastResizeSize;

// Auto-resize webviews in a specific window
void resizeAutoSizingWebviewsInWindow(uint32_t windowId, int width, int height) {
    OperationGuard guard;
    if (!guard.isValid()) return;
    // Debounce rapid resize events (ignore events within 50ms of the same size)
    auto now = std::chrono::steady_clock::now();
    auto lastTime = g_lastResizeTime[windowId];
    auto lastSize = g_lastResizeSize[windowId];
    
    if (lastSize.first == width && lastSize.second == height) {
        auto timeDiff = std::chrono::duration_cast<std::chrono::milliseconds>(now - lastTime).count();
        if (timeDiff < 50) {
            return;
        }
    }
    
    g_lastResizeTime[windowId] = now;
    g_lastResizeSize[windowId] = {width, height};
    
    // Find the X11 window handle for this window ID
    Window x11WindowHandle;
    {
        std::lock_guard<std::mutex> lock(g_x11WindowsMutex);
        auto windowIt = g_x11_windows.find(windowId);
        if (windowIt == g_x11_windows.end()) {
            return;
        }
        x11WindowHandle = windowIt->second->window;
    }
    
    // Find all webviews that belong to this window and have fullSize=true
    std::vector<std::pair<uint32_t, std::shared_ptr<AbstractView>>> webviews_copy;
    {
        std::lock_guard<std::mutex> lock(g_webviewMapMutex);
        // Create a copy of webviews to iterate safely
        for (auto& [webviewId, webview] : g_webviewMap) {
            if (webview && webview->fullSize) {
                webviews_copy.push_back({webviewId, webview});
            }
        }
    }
    
    // Process webviews outside the lock to avoid deadlock
    for (auto& [webviewId, webview] : webviews_copy) {
        if (webview && webview->fullSize) {
            // Check if this webview belongs to the specified window
            // For CEF webviews, we need to check their parent window
            CEFWebViewImpl* cefView = dynamic_cast<CEFWebViewImpl*>(webview.get());
            if (cefView && cefView->parentXWindow == x11WindowHandle) {
                // Check if the webview is already the right size to avoid infinite resize loops
                GdkRectangle currentBounds = webview->visualBounds;
                if (currentBounds.width == width && currentBounds.height == height) {
                    continue;
                }
                
                
                // For auto-resize, typically want to fill the entire window starting from (0,0)
                GdkRectangle frame = { 0, 0, width, height };
                webview->resize(frame, "");
            }
        }
    }
}

// X11 event processing function
gboolean process_x11_events(gpointer data) {
    OperationGuard guard;
    if (!guard.isValid()) {
        return G_SOURCE_REMOVE;
    }
    
    // Collect windows to process with proper synchronization
    std::vector<std::pair<uint32_t, std::shared_ptr<X11Window>>> windows_to_process;
    
    {
        std::lock_guard<std::mutex> lock(g_x11WindowsMutex);
        for (auto& [windowId, x11win] : g_x11_windows) {
            if (x11win && x11win->display) {
                windows_to_process.push_back({windowId, x11win});
            }
        }
    }
    
    // Process events for all X11 windows safely
    std::vector<uint32_t> windows_to_close;
    
    for (auto& [windowId, x11win] : windows_to_process) {
        if (!x11win || !x11win->display) continue;
        
        // Check if we're still valid during processing
        if (g_shuttingDown.load()) {
            break;
        }
        
        while (XPending(x11win->display)) {
            XEvent event;
            XNextEvent(x11win->display, &event);
            
            // Validate window still exists in maps
            bool window_valid = false;
            {
                std::lock_guard<std::mutex> lock(g_x11WindowsMutex);
                auto it = g_x11_window_to_id.find(event.xany.window);
                if (it != g_x11_window_to_id.end() && it->second == windowId) {
                    auto winIt = g_x11_windows.find(windowId);
                    window_valid = (winIt != g_x11_windows.end() && winIt->second.get() == x11win.get());
                }
            }
            
            if (!window_valid) continue;
            
            // CRITICAL FIX: Only process events from actual main windows, not CEF child windows
            // CEF child windows should NEVER be in g_x11_window_to_id, but if they are, ignore them
            if (event.xany.window != x11win->window) {
                continue;
            }
            
            switch (event.type) {
                case ClientMessage:
                    if (event.xclient.data.l[0] == (long)XInternAtom(x11win->display, "WM_DELETE_WINDOW", False)) {
                        printf("DEBUG: X11 WM_DELETE_WINDOW received for window ID: %u\n", x11win->windowId);
                        if (x11win->closeCallback) {
                            printf("DEBUG: Calling close callback for X11 window ID: %u\n", x11win->windowId);
                            x11win->closeCallback(x11win->windowId);
                        }
                        
                        // Mark for safe cleanup after event processing
                        windows_to_close.push_back(windowId);
                    }
                    break;
                    
                case ConfigureNotify:
                    // Only process ConfigureNotify events for the actual main window, not CEF child windows
                    if (event.xconfigure.window != x11win->window) {
                        break;
                    }
                    
                    if (event.xconfigure.width != x11win->width || event.xconfigure.height != x11win->height ||
                        event.xconfigure.x != x11win->x || event.xconfigure.y != x11win->y) {
                        
                        
                        x11win->x = event.xconfigure.x;
                        x11win->y = event.xconfigure.y;
                        x11win->width = event.xconfigure.width;
                        x11win->height = event.xconfigure.height;
                        
                        // Call move callback when position changes
                        if (x11win->moveCallback) {
                            x11win->moveCallback(x11win->windowId, x11win->x, x11win->y);
                        }
                        
                        if (x11win->resizeCallback) {
                            x11win->resizeCallback(x11win->windowId, x11win->x, x11win->y, 
                                                    x11win->width, x11win->height);
                        }
                        
                        // Auto-resize webviews in this window
                        resizeAutoSizingWebviewsInWindow(x11win->windowId, x11win->width, x11win->height);
                    }
                    break;
                    
                case Expose:
                    // Handle expose events if needed
                    break;

                case FocusIn:
                    // Window received focus
                    if (x11win->focusCallback) {
                        x11win->focusCallback(x11win->windowId);
                    }
                    break;
            }
        }
    }
    
    // Safely clean up windows that requested closure
    for (uint32_t windowId : windows_to_close) {
        std::lock_guard<std::mutex> lock(g_x11WindowsMutex);
        auto winIt = g_x11_windows.find(windowId);
        if (winIt != g_x11_windows.end()) {
            auto x11win = winIt->second;
            if (x11win && x11win->display && x11win->window) {
                printf("DEBUG: Destroying X11 window ID: %u\n", windowId);
                XDestroyWindow(x11win->display, x11win->window);
                XFlush(x11win->display);
                
                // Remove from global maps
                g_x11_window_to_id.erase(x11win->window);
                g_x11_windows.erase(windowId);
            }
        }
    }
    
    return G_SOURCE_CONTINUE;
}

void runCEFEventLoop() {
    // Initialize GTK on the main thread (this MUST be done here)
    initializeGTK();
    printf("=== ELECTROBUN NATIVE WRAPPER VERSION 1.0.2 === CEF EVENT LOOP STARTED ===\n");
    fflush(stdout);
        
    // Set up a timer to periodically call CefDoMessageLoopWork()
    // This integrates CEF message loop with GTK main loop
    g_timeout_add(10, cef_timer_callback, nullptr); // 10ms interval
        
    
    // Set up X11 event processing
    g_timeout_add(10, process_x11_events, nullptr); // Process X11 events every 10ms

    sleep(1); // Give time for output to flush
    gtk_main();
    
    // Cleanup CEF on shutdown

    if (g_cefInitialized) {
        CefShutdown();
    }
}

void runGTKEventLoop() {
    // Initialize GTK on the main thread (this MUST be done here)
    initializeGTK();
    printf("=== ELECTROBUN NATIVE WRAPPER VERSION 1.0.2 === GTK EVENT LOOP STARTED ===\n");
    
    // Note: GDK_BACKEND=x11 forced for Wayland compatibility
    
    gtk_main();
}

void runEventLoop() {    
    if (isCEFAvailable()) {      
        runCEFEventLoop();
    } else {  
        runGTKEventLoop();
    }
}


// Forward declarations
void showWindow(void* window);

void* createX11Window(uint32_t windowId, double x, double y, double width, double height, const char* title,
                   WindowCloseCallback closeCallback, WindowMoveCallback moveCallback, WindowResizeCallback resizeCallback, WindowFocusCallback focusCallback,
                   const char* titleBarStyle = nullptr, bool transparent = false) {
    
    void* result = dispatch_sync_main([&]() -> void* {
        
            // CEF mode - create pure X11 window
            
            // Create X11 window
            Display* display = XOpenDisplay(nullptr);
            if (!display) {
                printf("ERROR: Failed to open X11 display\n");
                return nullptr;
            }
            
            int screen = DefaultScreen(display);
            Window root = RootWindow(display, screen);
            
            // Create window attributes
            XSetWindowAttributes attrs;
            attrs.event_mask = ExposureMask | KeyPressMask | KeyReleaseMask | 
                              ButtonPressMask | ButtonReleaseMask | PointerMotionMask |
                              FocusChangeMask | StructureNotifyMask | SubstructureNotifyMask |
                              EnterWindowMask | LeaveWindowMask;
            
            unsigned long attr_mask = CWEventMask;
            Visual* visual = DefaultVisual(display, screen);
            int depth = DefaultDepth(display, screen);
            
            // For transparent windows, use ARGB visual for true transparency
            if (transparent) {
                // Find ARGB visual for transparency  
                XVisualInfo vinfo;
                if (XMatchVisualInfo(display, screen, 32, TrueColor, &vinfo)) {
                    visual = vinfo.visual;
                    depth = vinfo.depth;
                    attrs.colormap = XCreateColormap(display, root, visual, AllocNone);
                    attr_mask |= CWColormap;
                    // Use transparent background pixel
                    attrs.background_pixel = 0x00000000;  // Fully transparent
                    attr_mask |= CWBackPixel;
                    attrs.border_pixel = 0;
                    attr_mask |= CWBorderPixel;
                    printf("X11: Created transparent window with 32-bit ARGB visual\n");
                } else {
                    printf("WARNING: 32-bit visual not available, using dark background fallback\n");
                    attrs.background_pixel = 0x101010;  // Very dark gray fallback
                    attrs.border_pixel = 0;
                    attrs.colormap = DefaultColormap(display, screen);
                    attr_mask |= CWBackPixel | CWBorderPixel | CWColormap;
                }
            } else {
                attrs.background_pixel = WhitePixel(display, screen);
                attrs.border_pixel = BlackPixel(display, screen);
                attrs.colormap = DefaultColormap(display, screen);
                attr_mask |= CWBackPixel | CWBorderPixel | CWColormap;
            }
            
            // Create the main window
            Window x11_window = XCreateWindow(
                display, root,
                (int)x, (int)y, (int)width, (int)height, 0,
                depth, InputOutput,
                visual,
                attr_mask,
                &attrs
            );
            
            // Window created successfully
            
            // Note: For Linux, transparent windows are handled as borderless windows
            
            if (!x11_window) {
                printf("ERROR: Failed to create X11 window\n");
                XCloseDisplay(display);
                return nullptr;
            }
            
            // Set window title
            XStoreName(display, x11_window, title);
            
            // Set WM_CLASS for proper taskbar icon matching
            XClassHint class_hint;
            class_hint.res_name = (char*)"ElectrobunKitchenSink-dev";
            class_hint.res_class = (char*)"ElectrobunKitchenSink-dev";
            XSetClassHint(display, x11_window, &class_hint);
            
            // Set window protocols for close button
            Atom wmDelete = XInternAtom(display, "WM_DELETE_WINDOW", False);
            XSetWMProtocols(display, x11_window, &wmDelete, 1);
            
            // Select input events for interaction
            long event_mask = ExposureMask | KeyPressMask | KeyReleaseMask | 
                             ButtonPressMask | ButtonReleaseMask | PointerMotionMask |
                             FocusChangeMask | EnterWindowMask | LeaveWindowMask |
                             StructureNotifyMask;
            XSelectInput(display, x11_window, event_mask);
            
            // Handle window decorations based on titleBarStyle
            if (titleBarStyle && strcmp(titleBarStyle, "hidden") == 0) {
                // Remove window decorations for borderless windows
                Atom wmHints = XInternAtom(display, "_MOTIF_WM_HINTS", False);
                struct {
                    unsigned long flags;
                    unsigned long functions;
                    unsigned long decorations;
                    long inputMode;
                    unsigned long status;
                } hints = { 2, 0, 0, 0, 0 };  // MWM_HINTS_DECORATIONS = 2, no decorations
                
                XChangeProperty(display, x11_window, wmHints, wmHints, 32,
                               PropModeReplace, (unsigned char*)&hints, 5);
            }
            
            // Set window type for better compositor handling
            if (transparent || (titleBarStyle && strcmp(titleBarStyle, "hidden") == 0)) {
                Atom wmWindowType = XInternAtom(display, "_NET_WM_WINDOW_TYPE", False);
                Atom wmWindowTypeNormal = XInternAtom(display, "_NET_WM_WINDOW_TYPE_NORMAL", False);
                XChangeProperty(display, x11_window, wmWindowType, XA_ATOM, 32,
                               PropModeReplace, (unsigned char*)&wmWindowTypeNormal, 1);
            }
            
            // Set size and position hints to ensure window manager honors our positioning
            XSizeHints* sizeHints = XAllocSizeHints();
            if (sizeHints) {
                sizeHints->flags = PPosition | PSize;
                sizeHints->x = (int)x;
                sizeHints->y = (int)y;
                sizeHints->width = (int)width;
                sizeHints->height = (int)height;
                XSetWMNormalHints(display, x11_window, sizeHints);
                XFree(sizeHints);
            }
            
            // Create X11Window structure
            auto x11win = std::make_shared<X11Window>();
            x11win->display = display;
            x11win->window = x11_window;
            x11win->windowId = windowId;
            x11win->x = x;
            x11win->y = y;
            x11win->width = width;
            x11win->height = height;
            x11win->title = title;
            x11win->closeCallback = closeCallback;
            x11win->moveCallback = moveCallback;
            x11win->resizeCallback = resizeCallback;
            x11win->focusCallback = focusCallback;
            x11win->transparent = transparent;

            // Store in global maps
            {
                std::lock_guard<std::mutex> lock(g_x11WindowsMutex);
                g_x11_windows[windowId] = x11win;
                g_x11_window_to_id[x11_window] = windowId;
            }
            
            // X11/CEF mode doesn't need GTK containers - CEF manages its own windows
            // CEF webviews will be direct children of the X11 window
            
            // Apply application menu if one has been set
            applyApplicationMenuToX11Window(x11win.get());
            
            return (void*)x11win.get();
        
    });
    
    
    
    return result;
}

ELECTROBUN_EXPORT void* createGTKWindow(uint32_t windowId, double x, double y, double width, double height, const char* title,
                   WindowCloseCallback closeCallback, WindowMoveCallback moveCallback, WindowResizeCallback resizeCallback, WindowFocusCallback focusCallback,
                   const char* titleBarStyle = nullptr, bool transparent = false) {
    
   
    
    void* result = dispatch_sync_main([&]() -> void* {
      
  
        
        
        GtkWidget* window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
       
        gtk_window_set_title(GTK_WINDOW(window), title);
        
        // Set WM_CLASS for proper taskbar icon matching
        gtk_window_set_wmclass(GTK_WINDOW(window), "ElectrobunKitchenSink-dev", "ElectrobunKitchenSink-dev");
        
        gtk_window_set_default_size(GTK_WINDOW(window), (int)width, (int)height);
       
        if (x >= 0 && y >= 0) {
            gtk_window_move(GTK_WINDOW(window), (int)x, (int)y);
        }
        
        // Handle titleBarStyle for custom titlebars
        if (titleBarStyle && strcmp(titleBarStyle, "hidden") == 0) {
            // Remove window decorations for borderless windows
            gtk_window_set_decorated(GTK_WINDOW(window), FALSE);
            printf("GTK: Created window without decorations (custom titlebar)\n");
        }
        
        // Handle transparency
        if (transparent) {
            // Enable RGBA visual for transparency
            GdkScreen* screen = gtk_window_get_screen(GTK_WINDOW(window));
            GdkVisual* visual = gdk_screen_get_rgba_visual(screen);
            
            if (visual && gdk_screen_is_composited(screen)) {
                gtk_widget_set_visual(window, visual);
                gtk_widget_set_app_paintable(window, TRUE);
                
                // Connect to draw signal to paint transparent background
                g_signal_connect(window, "draw", G_CALLBACK(+[](GtkWidget* widget, cairo_t* cr, gpointer data) -> gboolean {
                    // Clear the window with transparent background
                    cairo_set_source_rgba(cr, 0.0, 0.0, 0.0, 0.0);
                    cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
                    cairo_paint(cr);
                    
                    // Let child widgets draw themselves
                    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
                    return FALSE;  // Continue with default drawing
                }), nullptr);
                
                printf("GTK: Created transparent window\n");
            } else {
                printf("GTK WARNING: Transparency not supported (no RGBA visual or compositor)\n");
            }
        }
        
        // Create container with callbacks
        auto container = std::make_shared<ContainerView>(window, windowId, closeCallback, moveCallback, resizeCallback, focusCallback);

        {
            std::lock_guard<std::mutex> lock(g_containersMutex);
            g_containers[windowId] = container;
        }

        // Apply application menu to new window if one is configured
        applyApplicationMenuToWindow(window);

        // Connect window delete event to handle X button clicks properly
        g_signal_connect(window, "delete-event", G_CALLBACK(onWindowDeleteEvent), container.get());

        // Connect destroy signal to clean up the container
        g_signal_connect(window, "destroy", G_CALLBACK(+[](GtkWidget* widget, gpointer user_data) {
            ContainerView* container = static_cast<ContainerView*>(user_data);
            if (container) {
                printf("DEBUG: Window destroyed, cleaning up container for window ID: %u\n", container->windowId);
                g_containers.erase(container->windowId);
            }
        }), container.get());

        // Connect window focus event
        g_signal_connect(window, "focus-in-event", G_CALLBACK(+[](GtkWidget* widget, GdkEventFocus* event, gpointer user_data) -> gboolean {
            ContainerView* container = static_cast<ContainerView*>(user_data);
            if (container && container->focusCallback) {
                container->focusCallback(container->windowId);
            }
            return FALSE; // Allow event to propagate
        }), container.get());

        // Note: Removed gtk_main_quit as default behavior - let the app decide whether to exit


        // Connect window resize signal for auto-resize functionality
        g_signal_connect(window, "configure-event", G_CALLBACK(onWindowConfigure), container.get());
      
        
        // Connect mouse motion event for debugging
        gtk_widget_add_events(window, GDK_POINTER_MOTION_MASK);
        g_signal_connect(window, "motion-notify-event", G_CALLBACK(onMouseMove), container.get());
   
        
        return (void*)window;
   
        
    });
    
  
    
    return result;
}

// Mac-compatible function for Linux
ELECTROBUN_EXPORT void* createWindowWithFrameAndStyleFromWorker(uint32_t windowId, double x, double y, double width, double height,
                                             uint32_t styleMask, const char* titleBarStyle, bool transparent,
                                             WindowCloseCallback closeCallback, WindowMoveCallback moveCallback, WindowResizeCallback resizeCallback, WindowFocusCallback focusCallback) {
    // CEF supports custom frames and transparency, GTK doesn't
    if (isCEFAvailable()) {
        return createX11Window(windowId, x, y, width, height, "Window", closeCallback, moveCallback, resizeCallback, focusCallback, titleBarStyle, transparent);
    } else {
        // Pass titleBarStyle and transparent to GTK window creation
        return createGTKWindow(windowId, x, y, width, height, "Window", closeCallback, moveCallback, resizeCallback, focusCallback, titleBarStyle, transparent);
    }

}

void setX11WindowTitle(void* window, const char* title) {
    dispatch_sync_main_void([&]() {
        X11Window* x11win = static_cast<X11Window*>(window);
        if (x11win && x11win->display && x11win->window) {
            XStoreName(x11win->display, x11win->window, title);
            XFlush(x11win->display);
            x11win->title = title;
        }
    });
}

void setGTKWindowTitle(void* window, const char* title) {
    dispatch_sync_main_void([&]() {
        gtk_window_set_title(GTK_WINDOW(window), title);
    });
}

// Cross-platform compatible function for Linux
ELECTROBUN_EXPORT void setWindowTitle(void* window, const char* title) {
    if (isCEFAvailable()) {
        setX11WindowTitle(window, title);
    } else {
        setGTKWindowTitle(window, title);
    }
}

void showX11Window(void* window) {
    dispatch_sync_main_void([&]() {
        X11Window* x11win = static_cast<X11Window*>(window);
        if (x11win && x11win->display && x11win->window) {
            // Automatically set icon from standard location
            autoSetWindowIcon(window);
            XMapWindow(x11win->display, x11win->window);
            
            // Raise the window to the front
            XRaiseWindow(x11win->display, x11win->window);
            
            // Set input focus to the window
            XSetInputFocus(x11win->display, x11win->window, RevertToParent, CurrentTime);
            
            XFlush(x11win->display);
            
            // Apply application menu when window is shown
            applyApplicationMenuToX11Window(x11win);
        }
    });
}

void showGTKWindow(void* window) {
    dispatch_sync_main_void([&]() {
        // Automatically set icon from standard location
        autoSetWindowIcon(window);
        gtk_widget_show_all(GTK_WIDGET(window));
        
        // Bring the window to the front and give it focus
        gtk_window_present(GTK_WINDOW(window));
    });
}

ELECTROBUN_EXPORT void showWindow(void* window) {
    if (isCEFAvailable()) {
        showX11Window(window);
    } else {
        showGTKWindow(window);
    }
}

// Cross-platform compatible function for Linux - return dummy style mask
ELECTROBUN_EXPORT uint32_t getWindowStyle(bool borderless, bool titled, bool closable, bool miniaturizable,
                        bool resizable, bool unifiedTitleAndToolbar, bool fullScreen,
                        bool fullSizeContentView, bool utilityWindow, bool docModalWindow,
                        bool nonactivatingPanel, bool hudWindow) {
    // Linux doesn't use style masks like macOS, so just return a dummy value
    // The actual window styling is handled in createWindow
    return 0;
}



// Webview functions


AbstractView* initCEFWebview(uint32_t webviewId,
                         void* window,
                         const char* renderer,
                         const char* url,
                         double x, double y,
                         double width, double height,
                         bool autoResize,
                         const char* partitionIdentifier,
                         DecideNavigationCallback navigationCallback,
                         WebviewEventHandler webviewEventHandler,
                         HandlePostMessage bunBridgeHandler,
                         HandlePostMessage internalBridgeHandler,
                         const char* electrobunPreloadScript,
                         const char* customPreloadScript) {
    
    AbstractView* result = dispatch_sync_main([&]() -> AbstractView* {
        try {
            std::shared_ptr<AbstractView> webview;
            
            webview = std::make_shared<CEFWebViewImpl>(
                webviewId, (GtkWidget*)window,  // window is now X11Window* cast to void*
                url, x, y, width, height, autoResize,
                partitionIdentifier, navigationCallback, webviewEventHandler,
                bunBridgeHandler, internalBridgeHandler,
                electrobunPreloadScript, customPreloadScript
            );
            
            if (webview->creationFailed) {
                printf("CEF webview creation failed, falling back to WebKit\n");
                fflush(stdout);
                webview = nullptr;
                
            }

            
            if (!webview || webview->creationFailed) {
                printf("ERROR: Webview creation failed\n");
                fflush(stdout);
                return nullptr;
            }
            
            // Set fullSize flag for auto-resize functionality
            webview->fullSize = autoResize;
        
            // For CEF, we need to manually trigger position sync since there's no container       
            CEFWebViewImpl* cefView = dynamic_cast<CEFWebViewImpl*>(webview.get());
            if (cefView) {
                // Defer positioning until CEF window is ready
                GdkRectangle frame;
                frame.x = (int)x;
                frame.y = (int)y;
                frame.width = (int)width;
                frame.height = (int)height;
                
                // Store the frame for later positioning
                cefView->pendingFrame = frame;
                cefView->hasPendingFrame = true;
                
                // Try immediate positioning, but if it fails, the OnAfterCreated callback will retry
                cefView->syncCEFPositionWithFrame(frame);   
            }
           
            
            // Store the webview in global map to keep it alive
            {
                std::lock_guard<std::mutex> lock(g_webviewMapMutex);
                g_webviewMap[webviewId] = webview;
            }
            
            return webview.get();
        } catch (const std::exception& e) {
            printf("ERROR: Failed to create webview: %s\n", e.what());
            fflush(stdout);
            return nullptr;
        }
    });
    
    return result;
}

AbstractView* initGTKWebkitWebview(uint32_t webviewId,
                         void* window,
                         const char* renderer,
                         const char* url,
                         double x, double y,
                         double width, double height,
                         bool autoResize,
                         const char* partitionIdentifier,
                         DecideNavigationCallback navigationCallback,
                         WebviewEventHandler webviewEventHandler,
                         HandlePostMessage bunBridgeHandler,
                         HandlePostMessage internalBridgeHandler,
                         const char* electrobunPreloadScript,
                         const char* customPreloadScript) {
    
    
    AbstractView* result = dispatch_sync_main([&]() -> AbstractView* {
        try {
            
            auto webview = std::make_shared<WebKitWebViewImpl>(
                webviewId, GTK_WIDGET(window),
                url, x, y, width, height, autoResize,
                partitionIdentifier, navigationCallback, webviewEventHandler,
                bunBridgeHandler, internalBridgeHandler,
                electrobunPreloadScript, customPreloadScript
            );
            
            // Set fullSize flag for auto-resize functionality
            webview->fullSize = autoResize;
            
            // Store the webview in global map to keep it alive and for navigation rules
            {
                std::lock_guard<std::mutex> lock(g_webviewMapMutex);
                g_webviewMap[webviewId] = webview;
            }
            
            // Webview created successfully
            
            {
                std::lock_guard<std::mutex> lock(g_containersMutex);
                for (auto& [id, container] : g_containers) {
                    if (container->window == GTK_WIDGET(window)) {
                        container->addWebview(webview, x, y);
                        break;
                    }
                }
            }
            
            return webview.get();
        } catch (const std::exception& e) {
            return nullptr;
        }
    });
    
    return result;
}

ELECTROBUN_EXPORT AbstractView* initWebview(uint32_t webviewId,
                         void* window,
                         const char* renderer,
                         const char* url,
                         double x, double y,
                         double width, double height,
                         bool autoResize,
                         const char* partitionIdentifier,
                         DecideNavigationCallback navigationCallback,
                         WebviewEventHandler webviewEventHandler,
                         HandlePostMessage bunBridgeHandler,
                         HandlePostMessage internalBridgeHandler,
                         const char* electrobunPreloadScript,
                         const char* customPreloadScript,
                         bool transparent) {
    // TODO: Implement transparent handling for Linux
    
    // Null pointer checks
    if (!window) {
        fprintf(stderr, "ERROR: initWebview called with null window pointer\n");
        return nullptr;
    }
    
    // Wait for GTK initialization to complete before creating any webviews
    waitForGTKInit();
    
    if (isCEFAvailable()) {
        return initCEFWebview(webviewId, window, renderer, url, x, y, width, height, autoResize,
                              partitionIdentifier, navigationCallback, webviewEventHandler,
                              bunBridgeHandler, internalBridgeHandler,
                              electrobunPreloadScript, customPreloadScript);
    } else {
        return initGTKWebkitWebview(webviewId, window, renderer, url, x, y, width, height, autoResize,
                                    partitionIdentifier, navigationCallback, webviewEventHandler,
                                    bunBridgeHandler, internalBridgeHandler,
                                    electrobunPreloadScript, customPreloadScript);
    }
       
}

ELECTROBUN_EXPORT void loadURLInWebView(AbstractView* abstractView, const char* urlString) {
    if (abstractView && urlString) {
        std::string urlStr(urlString);  // Copy the string to ensure it survives
        dispatch_sync_main_void([abstractView, urlStr]() {  // Capture by value
            abstractView->loadURL(urlStr.c_str());
        });
    }
}

ELECTROBUN_EXPORT void loadHTMLInWebView(AbstractView* abstractView, const char* htmlString) {
    if (abstractView && htmlString) {
        std::string htmlStr(htmlString);  // Copy the string to ensure it survives
        dispatch_sync_main_void([abstractView, htmlStr]() {  // Capture by value
            abstractView->loadHTML(htmlStr.c_str());
        });
    }
}

ELECTROBUN_EXPORT void webviewGoBack(AbstractView* abstractView) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->goBack();
        });
    }
}

ELECTROBUN_EXPORT void webviewGoForward(AbstractView* abstractView) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->goForward();
        });
    }
}

ELECTROBUN_EXPORT void webviewReload(AbstractView* abstractView) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->reload();
        });
    }
}

ELECTROBUN_EXPORT void webviewRemove(AbstractView* abstractView) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->remove();
        });
    }
}

ELECTROBUN_EXPORT bool webviewCanGoBack(AbstractView* abstractView) {
    if (abstractView) {
        return abstractView->canGoBack();
    }
    return false;
}

ELECTROBUN_EXPORT bool webviewCanGoForward(AbstractView* abstractView) {
    if (abstractView) {
        return abstractView->canGoForward();
    }
    return false;
}

void updateActiveWebviewForMousePosition(uint32_t windowId, int mouseX, int mouseY) {
    // Find the container for this window
    auto containerIt = g_containers.find(windowId);
    if (containerIt == g_containers.end()) {
        return;
    }
    
    auto container = containerIt->second;
    
    // Iterate through webviews in reverse order (topmost webview first)
    for (auto it = container->abstractViews.rbegin(); it != container->abstractViews.rend(); ++it) {
        auto webview = *it;
        
        // Check if mouse is within the webview bounds
        if (mouseX >= webview->visualBounds.x && 
            mouseX < webview->visualBounds.x + webview->visualBounds.width &&
            mouseY >= webview->visualBounds.y && 
            mouseY < webview->visualBounds.y + webview->visualBounds.height) {
            
            // Check if the mouse is in a masked area
            if (!webview->maskJSON.empty()) {
                std::vector<MaskRect> masks = parseMaskJson(webview->maskJSON);
                
                // Convert mouse position to webview-relative coordinates
                int relativeX = mouseX - webview->visualBounds.x;
                int relativeY = mouseY - webview->visualBounds.y;
                
                if (isPointInMask(relativeX, relativeY, masks)) {
                    // Mouse is in a masked area, continue to next webview
                    continue;
                }
            }
            
            // This webview should be active
            if (container->activeWebView != webview.get()) {
                // Disable input for all webviews first
                for (auto& view : container->abstractViews) {
                    view->toggleMirrorMode(true);
                }
                
                // Enable input for this webview
                webview->toggleMirrorMode(false);
                container->activeWebView = webview.get();
            }
            return;
        }
    }
    
    // Mouse is not over any webview, disable input for all
    for (auto& view : container->abstractViews) {
        view->toggleMirrorMode(true);
    }
    container->activeWebView = nullptr;
}

ELECTROBUN_EXPORT void resizeWebview(AbstractView* abstractView, double x, double y, double width, double height, const char* masksJson) {
    if (abstractView) {
        
        std::string masksStr(masksJson ? masksJson : "");  // Copy the string to ensure it survives
        dispatch_sync_main_void([abstractView, x, y, width, height, masksStr]() {  // Capture by value
            GdkRectangle frame = { (int)x, (int)y, (int)width, (int)height };
            abstractView->resize(frame, masksStr.c_str());
        });
    }
}

ELECTROBUN_EXPORT void evaluateJavaScriptWithNoCompletion(AbstractView* abstractView, const char* js) {
    if (abstractView && js) {
        std::string jsString(js);  // Copy the string to ensure it survives
        dispatch_sync_main_void([abstractView, jsString]() {  // Capture by value
            
            // Verify the abstractView is still valid
            if (abstractView) {
                abstractView->evaluateJavaScriptWithNoCompletion(jsString.c_str());
            } else {
                printf("evaluateJavaScriptWithNoCompletion: abstractView became NULL in dispatch!\n");
            }
        });
    } else {
        printf("evaluateJavaScriptWithNoCompletion: FFI entry, abstractView=%p, js=%p\n", abstractView, js);
    }
}

void webviewSetTransparent(AbstractView* abstractView, bool transparent) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->setTransparent(transparent);
        });
    }
}

void webviewSetPassthrough(AbstractView* abstractView, bool enablePassthrough) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->setPassthrough(enablePassthrough);
        });
    }
}

void webviewSetHidden(AbstractView* abstractView, bool hidden) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->setHidden(hidden);
        });
    }
}

ELECTROBUN_EXPORT void setWebviewNavigationRules(AbstractView* abstractView, const char* rulesJson) {
    if (abstractView) {
        std::string rulesStr(rulesJson ? rulesJson : "");  // Copy the string to ensure it survives
        dispatch_sync_main_void([abstractView, rulesStr]() {
            abstractView->setNavigationRulesFromJSON(rulesStr.c_str());
        });
    }
}

ELECTROBUN_EXPORT void webviewFindInPage(AbstractView* abstractView, const char* searchText, bool forward, bool matchCase) {
    if (abstractView) {
        std::string text(searchText ? searchText : "");
        dispatch_sync_main_void([abstractView, text, forward, matchCase]() {
            abstractView->findInPage(text.c_str(), forward, matchCase);
        });
    }
}

ELECTROBUN_EXPORT void webviewStopFind(AbstractView* abstractView) {
    if (abstractView) {
        dispatch_sync_main_void([abstractView]() {
            abstractView->stopFindInPage();
        });
    }
}

ELECTROBUN_EXPORT void updatePreloadScriptToWebView(AbstractView* abstractView, const char* scriptIdentifier, const char* scriptContent, bool forMainFrameOnly) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->updateCustomPreloadScript(scriptContent);
        });
    }
}

// Forward declaration
void stopWindowMove();

// Window drag motion handler
static gboolean onWindowDragMotion(GtkWidget* widget, GdkEventMotion* event, gpointer user_data) {
    if (!g_draggedWindow || widget != g_draggedWindow || !event || !event->device) {
        return FALSE;
    }
    
    // Validate widget and its window
    GdkWindow* gdkWindow = gtk_widget_get_window(widget);
    if (!gdkWindow) {
        return FALSE;
    }
    
    // Get the current mouse position using the event data directly (more reliable)
    gint rootX = (gint)event->x_root;
    gint rootY = (gint)event->y_root;
    
    // Calculate new window position
    gint newX = rootX - g_dragStartX;
    gint newY = rootY - g_dragStartY;
    
    // Move the window
    gtk_window_move(GTK_WINDOW(widget), newX, newY);
    
    return FALSE; // Let other handlers process the event
}

// Window drag button release handler
static gboolean onWindowDragButtonRelease(GtkWidget* widget, GdkEventButton* event, gpointer user_data) {
    if (!event) {
        return FALSE;
    }
    
    if (event->button == 1) { // Left mouse button
        printf("Button release detected, stopping window move\n");
        fflush(stdout);
        stopWindowMove();
    }
    return FALSE; // Let other handlers process the event
}

ELECTROBUN_EXPORT void startWindowMove(void* window) {
    dispatch_sync_main_void([&]() {
        // Handle both GTK and X11 windows
        if (isCEFAvailable()) {
            // For X11/CEF windows, we need to use X11 APIs
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                // Get current mouse position
                Window root, child;
                int rootX, rootY, winX, winY;
                unsigned int mask;
                XQueryPointer(x11win->display, x11win->window, &root, &child, 
                            &rootX, &rootY, &winX, &winY, &mask);
                
                // Start window move using X11's built-in window manager support
                XEvent xev;
                memset(&xev, 0, sizeof(xev));
                xev.xclient.type = ClientMessage;
                xev.xclient.window = x11win->window;
                xev.xclient.message_type = XInternAtom(x11win->display, "_NET_WM_MOVERESIZE", False);
                xev.xclient.format = 32;
                xev.xclient.data.l[0] = rootX;
                xev.xclient.data.l[1] = rootY;
                xev.xclient.data.l[2] = 8; // _NET_WM_MOVERESIZE_MOVE
                xev.xclient.data.l[3] = Button1;
                xev.xclient.data.l[4] = 1;
                
                XSendEvent(x11win->display, DefaultRootWindow(x11win->display), False,
                          SubstructureRedirectMask | SubstructureNotifyMask, &xev);
                XFlush(x11win->display);
            }
        } else {
            // For GTK windows
            GtkWidget* gtkWindow = GTK_WIDGET(window);
            if (!gtkWindow || !GTK_IS_WINDOW(gtkWindow)) {
                fprintf(stderr, "Invalid window provided to startWindowMove\n");
                return;
            }
            
            // Check if widget is realized
            if (!gtk_widget_get_realized(gtkWindow)) {
                fprintf(stderr, "Window not realized, cannot start window move\n");
                return;
            }
            
            // Get the GDK window and validate it
            GdkWindow* gdkWindow = gtk_widget_get_window(gtkWindow);
            if (!gdkWindow) {
                fprintf(stderr, "No GDK window available for startWindowMove\n");
                return;
            }
            
            // Clean up any existing drag
            stopWindowMove();
            
            // Store the window being dragged
            g_draggedWindow = gtkWindow;
            
            // Get current mouse position relative to window
            GdkDisplay* display = gdk_display_get_default();
            if (!display) {
                fprintf(stderr, "No default display available\n");
                stopWindowMove();
                return;
            }
            
            GdkSeat* seat = gdk_display_get_default_seat(display);
            if (!seat) {
                fprintf(stderr, "No default seat available\n");
                stopWindowMove();
                return;
            }
            
            GdkDevice* device = gdk_seat_get_pointer(seat);
            if (!device) {
                fprintf(stderr, "No pointer device available\n");
                stopWindowMove();
                return;
            }
            
            gint rootX, rootY, winX, winY;
            gdk_device_get_position(device, nullptr, &rootX, &rootY);
            gdk_window_get_device_position(gdkWindow, device, &winX, &winY, nullptr);
            
            // Store the offset where the drag started within the window
            g_dragStartX = winX;
            g_dragStartY = winY;
            
            // Enable motion events on the window
            gtk_widget_add_events(gtkWindow, GDK_POINTER_MOTION_MASK | GDK_BUTTON_RELEASE_MASK);
            
            // Connect motion and button release handlers
            g_motionHandlerId = g_signal_connect(gtkWindow, "motion-notify-event", 
                                               G_CALLBACK(onWindowDragMotion), nullptr);
            g_buttonReleaseHandlerId = g_signal_connect(gtkWindow, "button-release-event", 
                                                       G_CALLBACK(onWindowDragButtonRelease), nullptr);
            
            // Grab the pointer to ensure we get all mouse events
            GdkGrabStatus status = gdk_seat_grab(seat, gdkWindow,
                                                GDK_SEAT_CAPABILITY_POINTER,
                                                FALSE, // owner_events
                                                nullptr, // cursor
                                                nullptr, // event
                                                nullptr, // prepare_func
                                                nullptr); // prepare_func_data
            
            if (status != GDK_GRAB_SUCCESS) {
                fprintf(stderr, "Failed to grab pointer for window drag (status: %d)\n", status);
                stopWindowMove();
            } else {
                printf("Window drag started successfully\n");
                fflush(stdout);
            }
        }
    });
}

ELECTROBUN_EXPORT void stopWindowMove() {
    dispatch_sync_main_void([&]() {
        printf("stopWindowMove called\n");
        fflush(stdout);
        
        if (g_draggedWindow) {
            printf("Cleaning up window drag state\n");
            fflush(stdout);
            
            // Disconnect handlers safely
            if (g_motionHandlerId > 0 && G_IS_OBJECT(g_draggedWindow)) {
                g_signal_handler_disconnect(g_draggedWindow, g_motionHandlerId);
                g_motionHandlerId = 0;
            }
            if (g_buttonReleaseHandlerId > 0 && G_IS_OBJECT(g_draggedWindow)) {
                g_signal_handler_disconnect(g_draggedWindow, g_buttonReleaseHandlerId);
                g_buttonReleaseHandlerId = 0;
            }
            
            // Release pointer grab safely
            GdkDisplay* display = gdk_display_get_default();
            if (display) {
                GdkSeat* seat = gdk_display_get_default_seat(display);
                if (seat) {
                    gdk_seat_ungrab(seat);
                }
            }
            
            // Clear state
            g_draggedWindow = nullptr;
            g_dragStartX = 0;
            g_dragStartY = 0;
            
            printf("Window drag cleanup completed\n");
            fflush(stdout);
        }
    });
}

ELECTROBUN_EXPORT void addPreloadScriptToWebView(AbstractView* abstractView, const char* scriptContent, bool forMainFrameOnly) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->addPreloadScriptToWebView(scriptContent);
        });
    }
}

ELECTROBUN_EXPORT void callAsyncJavaScript(const char* messageId, const char* jsString, uint32_t webviewId, uint32_t hostWebviewId, void* completionHandler) {
    // Find the webview in containers
    for (auto& [id, container] : g_containers) {
        for (auto& view : container->abstractViews) {
            if (view->webviewId == webviewId) {
                view->callAsyncJavascript(messageId, jsString, webviewId, hostWebviewId, completionHandler);
                return;
            }
        }
    }
}

void* addScriptMessageHandlerWithReply(void* webView, uint32_t webviewId, const char* name, void* callback) {
    // TODO: Implement script message handler with reply
    return nullptr;
}

void testFFI(void* ptr) {
    // Test function for FFI
}

void testFFI2(void (*completionHandler)()) {
    printf("testFFI2 called from FFI! Callback pointer: %p\n", completionHandler);
    fflush(stdout);
    
    // Write to log file as well
    FILE* logFile = fopen("/tmp/tray_debug.log", "a");
    if (logFile) {
        fprintf(logFile, "testFFI2 called from FFI! Callback pointer: %p\n", completionHandler);
        fflush(logFile);
        fclose(logFile);
    }
    
    if (completionHandler) {
        completionHandler();
    }
}

ELECTROBUN_EXPORT int simpleTest() {
    printf("simpleTest called successfully\n");
    fflush(stdout);
    return 42;
}

ELECTROBUN_EXPORT const char* getUrlFromNavigationAction(void* navigationAction) {
    // TODO: Implement URL extraction from navigation action
    return nullptr;
}

ELECTROBUN_EXPORT const char* getBodyFromScriptMessage(void* message) {
    // TODO: Implement body extraction from script message
    return nullptr;
}

void invokeDecisionHandler(void* decisionHandler, uint32_t policy) {
    // TODO: Implement decision handler invocation
}

ELECTROBUN_EXPORT bool moveToTrash(char* pathString) {
    if (!pathString) return false;
    
    // Use GIO to move file to trash
    GFile* file = g_file_new_for_path(pathString);
    GError* error = nullptr;
    
    gboolean result = g_file_trash(file, nullptr, &error);
    
    if (error) {
        fprintf(stderr, "Failed to move to trash: %s\n", error->message);
        g_error_free(error);
    }
    
    g_object_unref(file);
    return result == TRUE;
}

void showItemInFolder(char* path) {
    if (!path) return;
    
    // Check if path exists
    struct stat sb;
    if (stat(path, &sb) != 0) {
        fprintf(stderr, "Path does not exist: %s\n", path);
        return;
    }
    
    // Get the parent directory if it's a file
    gchar* parentDir = nullptr;
    if (S_ISREG(sb.st_mode)) {
        parentDir = g_path_get_dirname(path);
    } else {
        parentDir = g_strdup(path);
    }
    
    // Try to open with the default file manager
    // Most Linux desktop environments support xdg-open
    gchar* uri = g_filename_to_uri(parentDir, nullptr, nullptr);
    if (uri) {
        // Use xdg-open which works across different desktop environments
        gchar* command = g_strdup_printf("xdg-open \"%s\"", uri);
        int result = system(command);
        
        if (result != 0) {
            // Fallback: try gio open
            g_free(command);
            command = g_strdup_printf("gio open \"%s\"", uri);
            result = system(command);
            
            if (result != 0) {
                fprintf(stderr, "Failed to open file manager for: %s\n", path);
            }
        }
        
        g_free(command);
        g_free(uri);
    }
    
    g_free(parentDir);
}

// Open a URL in the default browser or appropriate application
ELECTROBUN_EXPORT bool openExternal(const char* urlString) {
    if (!urlString) {
        fprintf(stderr, "ERROR: NULL URL passed to openExternal\n");
        return false;
    }

    std::string url(urlString);
    if (url.empty()) {
        fprintf(stderr, "ERROR: Empty URL passed to openExternal\n");
        return false;
    }

    GError* error = nullptr;

    // Use g_app_info_launch_default_for_uri to open the URL with default app
    gboolean result = g_app_info_launch_default_for_uri(urlString, nullptr, &error);

    if (error) {
        fprintf(stderr, "GIO failed to open URL: %s - trying xdg-open\n", error->message);
        g_error_free(error);

        // Fallback to xdg-open
        gchar* command = g_strdup_printf("xdg-open \"%s\"", urlString);
        int sysResult = system(command);
        g_free(command);

        if (sysResult != 0) {
            fprintf(stderr, "ERROR: Failed to open external URL: %s\n", urlString);
            return false;
        }
        return true;
    }

    return result == TRUE;
}

// Open a file or folder with the default application
ELECTROBUN_EXPORT bool openPath(const char* pathString) {
    if (!pathString) {
        fprintf(stderr, "ERROR: NULL path passed to openPath\n");
        return false;
    }

    std::string path(pathString);
    if (path.empty()) {
        fprintf(stderr, "ERROR: Empty path passed to openPath\n");
        return false;
    }

    // Convert path to URI
    gchar* uri = g_filename_to_uri(pathString, nullptr, nullptr);
    if (!uri) {
        fprintf(stderr, "ERROR: Failed to convert path to URI: %s\n", pathString);
        return false;
    }

    GError* error = nullptr;

    // Use g_app_info_launch_default_for_uri to open with default app
    gboolean result = g_app_info_launch_default_for_uri(uri, nullptr, &error);

    if (error) {
        fprintf(stderr, "GIO failed to open path: %s - trying xdg-open\n", error->message);
        g_error_free(error);

        // Fallback to xdg-open
        gchar* command = g_strdup_printf("xdg-open \"%s\"", uri);
        int sysResult = system(command);
        g_free(command);
        g_free(uri);

        if (sysResult != 0) {
            fprintf(stderr, "ERROR: Failed to open path: %s\n", pathString);
            return false;
        }
        return true;
    }

    g_free(uri);
    return result == TRUE;
}

// Show a native desktop notification using notify-send
void showNotification(const char* title, const char* body, const char* subtitle, bool silent) {
    if (!title) {
        fprintf(stderr, "ERROR: NULL title passed to showNotification\n");
        return;
    }

    std::string titleStr(title);
    std::string bodyStr;

    // Combine subtitle and body if both exist
    if (subtitle && strlen(subtitle) > 0) {
        bodyStr = std::string(subtitle);
        if (body && strlen(body) > 0) {
            bodyStr += "\n" + std::string(body);
        }
    } else if (body) {
        bodyStr = std::string(body);
    }

    // Build the notify-send command
    // Escape single quotes in strings for shell safety
    auto escapeForShell = [](const std::string& str) -> std::string {
        std::string result;
        for (char c : str) {
            if (c == '\'') {
                result += "'\\''";
            } else {
                result += c;
            }
        }
        return result;
    };

    std::string command = "notify-send";

    // Add urgency hint (low for silent notifications)
    if (silent) {
        command += " --urgency=low";
    }

    // Add title
    command += " '" + escapeForShell(titleStr) + "'";

    // Add body if present
    if (!bodyStr.empty()) {
        command += " '" + escapeForShell(bodyStr) + "'";
    }

    // Execute asynchronously to not block
    std::thread([command]() {
        int result = system(command.c_str());
        if (result != 0) {
            fprintf(stderr, "Warning: notify-send failed (is libnotify-bin installed?)\n");
        }
    }).detach();
}

ELECTROBUN_EXPORT const char* openFileDialog(const char* startingFolder, const char* allowedFileTypes, int canChooseFiles, int canChooseDirectories, int allowsMultipleSelection) {
    // This function needs to run on the main thread
    return dispatch_sync_main([&]() -> const char* {
        // Determine the file chooser action based on parameters
        GtkFileChooserAction action;
        const char* buttonLabel;
        
        if (canChooseFiles && canChooseDirectories) {
            action = GTK_FILE_CHOOSER_ACTION_OPEN;
            buttonLabel = "_Open";
        } else if (canChooseDirectories) {
            action = GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER;
            buttonLabel = "_Select";
        } else {
            action = GTK_FILE_CHOOSER_ACTION_OPEN;
            buttonLabel = "_Open";
        }
        
        GtkWidget* dialog = gtk_file_chooser_dialog_new(
            "Open File",
            nullptr, // No parent window for now
            action,
            "_Cancel", GTK_RESPONSE_CANCEL,
            buttonLabel, GTK_RESPONSE_ACCEPT,
            nullptr
        );
        
        // Set starting folder if provided
        if (startingFolder && strlen(startingFolder) > 0) {
            gtk_file_chooser_set_current_folder(GTK_FILE_CHOOSER(dialog), startingFolder);
        }
        
        // Allow multiple selection if requested
        gtk_file_chooser_set_select_multiple(GTK_FILE_CHOOSER(dialog), allowsMultipleSelection != 0);
        
        // Set up file filters if provided
        if (allowedFileTypes && strlen(allowedFileTypes) > 0) {
            // Parse the allowed file types string (expected format: "*.jpg,*.png" or "Images|*.jpg;*.png|Documents|*.pdf;*.doc")
            std::string typesStr(allowedFileTypes);
            
            // Simple parsing - just handle comma-separated extensions for now
            GtkFileFilter* filter = gtk_file_filter_new();
            gtk_file_filter_set_name(filter, "Allowed files");
            
            // Split by comma or semicolon
            size_t pos = 0;
            std::string delimiter = ",";
            while ((pos = typesStr.find(delimiter)) != std::string::npos) {
                std::string pattern = typesStr.substr(0, pos);
                // Trim whitespace
                pattern.erase(0, pattern.find_first_not_of(" \t"));
                pattern.erase(pattern.find_last_not_of(" \t") + 1);
                
                gtk_file_filter_add_pattern(filter, pattern.c_str());
                typesStr.erase(0, pos + delimiter.length());
            }
            // Add the last pattern
            if (!typesStr.empty()) {
                typesStr.erase(0, typesStr.find_first_not_of(" \t"));
                typesStr.erase(typesStr.find_last_not_of(" \t") + 1);
                gtk_file_filter_add_pattern(filter, typesStr.c_str());
            }
            
            gtk_file_chooser_add_filter(GTK_FILE_CHOOSER(dialog), filter);
            
            // Also add "All files" filter
            GtkFileFilter* allFilter = gtk_file_filter_new();
            gtk_file_filter_set_name(allFilter, "All files");
            gtk_file_filter_add_pattern(allFilter, "*");
            gtk_file_chooser_add_filter(GTK_FILE_CHOOSER(dialog), allFilter);
        }
        
        // Run the dialog
        static std::string resultString; // Static to persist after function returns
        resultString.clear();
        
        if (gtk_dialog_run(GTK_DIALOG(dialog)) == GTK_RESPONSE_ACCEPT) {
            if (allowsMultipleSelection != 0) {
                GSList* fileList = gtk_file_chooser_get_filenames(GTK_FILE_CHOOSER(dialog));
                GSList* iter = fileList;
                
                while (iter != nullptr) {
                    if (!resultString.empty()) {
                        resultString += ","; // Separate multiple files with comma (like Mac)
                    }
                    resultString += (char*)iter->data;
                    g_free(iter->data);
                    iter = iter->next;
                }
                g_slist_free(fileList);
            } else {
                char* filename = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(dialog));
                if (filename) {
                    resultString = filename;
                    g_free(filename);
                }
            }
        }
        
        gtk_widget_destroy(dialog);
        
        return resultString.empty() ? nullptr : resultString.c_str();
    });
}

ELECTROBUN_EXPORT int showMessageBox(const char *type,
                   const char *title,
                   const char *message,
                   const char *detail,
                   const char *buttons,
                   int defaultId,
                   int cancelId) {
    return dispatch_sync_main([&]() -> int {
        // Determine message type for GTK
        GtkMessageType messageType = GTK_MESSAGE_INFO;
        if (type) {
            std::string typeStr(type);
            if (typeStr == "warning") {
                messageType = GTK_MESSAGE_WARNING;
            } else if (typeStr == "error" || typeStr == "critical") {
                messageType = GTK_MESSAGE_ERROR;
            } else if (typeStr == "question") {
                messageType = GTK_MESSAGE_QUESTION;
            }
        }

        // Create dialog with no default buttons - we'll add custom ones
        GtkWidget* dialog = gtk_message_dialog_new(
            nullptr, // No parent window
            GTK_DIALOG_MODAL,
            messageType,
            GTK_BUTTONS_NONE,
            "%s",
            message ? message : ""
        );

        // Set title
        if (title && strlen(title) > 0) {
            gtk_window_set_title(GTK_WINDOW(dialog), title);
        }

        // Add secondary text (detail)
        if (detail && strlen(detail) > 0) {
            gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(dialog), "%s", detail);
        }

        // Parse and add custom buttons
        std::vector<std::string> buttonLabels;
        if (buttons && strlen(buttons) > 0) {
            std::string buttonsStr(buttons);
            std::stringstream ss(buttonsStr);
            std::string buttonLabel;
            while (std::getline(ss, buttonLabel, ',')) {
                // Trim whitespace
                size_t start = buttonLabel.find_first_not_of(" \t");
                size_t end = buttonLabel.find_last_not_of(" \t");
                if (start != std::string::npos) {
                    buttonLabels.push_back(buttonLabel.substr(start, end - start + 1));
                }
            }
        }
        if (buttonLabels.empty()) {
            buttonLabels.push_back("OK");
        }

        // Add buttons in order (response IDs start at 0)
        for (size_t i = 0; i < buttonLabels.size(); i++) {
            gtk_dialog_add_button(GTK_DIALOG(dialog), buttonLabels[i].c_str(), static_cast<int>(i));
        }

        // Set default button
        if (defaultId >= 0 && defaultId < static_cast<int>(buttonLabels.size())) {
            gtk_dialog_set_default_response(GTK_DIALOG(dialog), defaultId);
        }

        // Run dialog and get response
        int response = gtk_dialog_run(GTK_DIALOG(dialog));
        gtk_widget_destroy(dialog);

        // Handle GTK response codes
        if (response == GTK_RESPONSE_DELETE_EVENT) {
            // User closed the dialog via window manager
            return cancelId >= 0 ? cancelId : -1;
        }
        if (response >= 0 && response < static_cast<int>(buttonLabels.size())) {
            return response;
        }

        return -1;
    });
}

// ============================================================================
// Clipboard API
// ============================================================================

// clipboardReadText - Read text from the system clipboard
// Returns: UTF-8 string (caller must free) or NULL if no text available
ELECTROBUN_EXPORT const char* clipboardReadText() {
    return dispatch_sync_main([&]() -> const char* {
        GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
        gchar* text = gtk_clipboard_wait_for_text(clipboard);
        if (text) {
            const char* result = strdup(text);
            g_free(text);
            return result;
        }
        return nullptr;
    });
}

// clipboardWriteText - Write text to the system clipboard
ELECTROBUN_EXPORT void clipboardWriteText(const char* text) {
    if (!text) return;

    // Make a copy of the text since we need it to persist
    std::string textCopy(text);

    dispatch_sync_main_void([&]() {
        GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
        gtk_clipboard_set_text(clipboard, textCopy.c_str(), -1);
        // Store the clipboard data so it persists after the app exits
        gtk_clipboard_store(clipboard);
    });
}

// clipboardReadImage - Read image from clipboard as PNG data
// Returns: PNG data (caller must free) and sets outSize, or NULL if no image
const uint8_t* clipboardReadImage(size_t* outSize) {
    return dispatch_sync_main([&]() -> const uint8_t* {
        if (outSize) *outSize = 0;

        GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
        GdkPixbuf* pixbuf = gtk_clipboard_wait_for_image(clipboard);

        if (!pixbuf) {
            return nullptr;
        }

        // Save pixbuf to PNG in memory
        gchar* buffer = nullptr;
        gsize bufferSize = 0;
        GError* error = nullptr;

        gboolean success = gdk_pixbuf_save_to_buffer(
            pixbuf, &buffer, &bufferSize, "png", &error, NULL
        );

        g_object_unref(pixbuf);

        if (!success || !buffer) {
            if (error) g_error_free(error);
            return nullptr;
        }

        // Copy to malloc'd buffer (caller will free)
        uint8_t* result = static_cast<uint8_t*>(malloc(bufferSize));
        memcpy(result, buffer, bufferSize);
        g_free(buffer);

        if (outSize) *outSize = bufferSize;
        return result;
    });
}

// clipboardWriteImage - Write PNG image data to clipboard
ELECTROBUN_EXPORT void clipboardWriteImage(const uint8_t* pngData, size_t size) {
    if (!pngData || size == 0) return;

    // Copy the data since we need it to persist
    std::vector<uint8_t> dataCopy(pngData, pngData + size);

    dispatch_sync_main_void([&]() {
        // Load PNG data into a GdkPixbuf
        GInputStream* stream = g_memory_input_stream_new_from_data(
            dataCopy.data(), dataCopy.size(), nullptr
        );

        GError* error = nullptr;
        GdkPixbuf* pixbuf = gdk_pixbuf_new_from_stream(stream, nullptr, &error);
        g_object_unref(stream);

        if (!pixbuf) {
            if (error) {
                std::cerr << "Failed to load PNG: " << error->message << std::endl;
                g_error_free(error);
            }
            return;
        }

        GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
        gtk_clipboard_set_image(clipboard, pixbuf);
        gtk_clipboard_store(clipboard);

        g_object_unref(pixbuf);
    });
}

// clipboardClear - Clear the clipboard
ELECTROBUN_EXPORT void clipboardClear() {
    dispatch_sync_main_void([&]() {
        GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
        gtk_clipboard_clear(clipboard);
    });
}

// clipboardAvailableFormats - Get available formats in clipboard
// Returns: comma-separated list of formats (caller must free)
ELECTROBUN_EXPORT const char* clipboardAvailableFormats() {
    return dispatch_sync_main([&]() -> const char* {
        GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
        std::vector<std::string> formats;

        // Check for text
        if (gtk_clipboard_wait_is_text_available(clipboard)) {
            formats.push_back("text");
        }

        // Check for image
        if (gtk_clipboard_wait_is_image_available(clipboard)) {
            formats.push_back("image");
        }

        // Check for URIs (files)
        if (gtk_clipboard_wait_is_uris_available(clipboard)) {
            formats.push_back("files");
        }

        // Join formats with comma
        std::string result;
        for (size_t i = 0; i < formats.size(); i++) {
            if (i > 0) result += ",";
            result += formats[i];
        }

        return strdup(result.c_str());
    });
}

// NOTE: Removed deferred tray creation code - now creating TrayItem synchronously
// The TrayItem constructor handles deferred AppIndicator creation internally

#ifndef NO_APPINDICATOR
ELECTROBUN_EXPORT void* createTray(uint32_t trayId, const char* title, const char* pathToImage, bool isTemplate, uint32_t width, uint32_t height, void* clickHandler) {
    // NOTE: width and height parameters are ignored on Linux since AppIndicator doesn't support custom sizing
    // These parameters are included for FFI consistency across platforms (macOS and Windows use them)
    
    // Wait for GTK initialization to complete
    waitForGTKInit();
    
    return dispatch_sync_main([&]() -> void* {
        // Create the TrayItem on main thread
        try {
            auto tray = std::make_unique<TrayItem>(
                trayId,
                title ? title : "",
                pathToImage ? pathToImage : "",
                isTemplate,
                reinterpret_cast<ZigStatusItemHandler>(clickHandler)
            );
            
            TrayItem* trayPtr = tray.get();
            g_trays[trayId] = std::move(tray);
            
            return trayPtr;
        } catch (const std::exception& e) {
            return nullptr;
        } catch (...) {
            return nullptr;
        }
    });
}

ELECTROBUN_EXPORT void setTrayTitle(void* statusItem, const char* title) {
    dispatch_sync_main_void([&]() {
        // Find the tray by statusItem pointer
        for (auto& [id, tray] : g_trays) {
            if (tray.get() == statusItem) {
                tray->setTitle(title);
                break;
            }
        }
    });
}

ELECTROBUN_EXPORT void setTrayImage(void* statusItem, const char* image) {
    dispatch_sync_main_void([&]() {
        // Find the tray by statusItem pointer
        for (auto& [id, tray] : g_trays) {
            if (tray.get() == statusItem) {
                tray->setImage(image);
                break;
            }
        }
    });
}

ELECTROBUN_EXPORT void setTrayMenuFromJSON(void* statusItem, const char* jsonString) {
    dispatch_sync_main_void([&]() {
        // Find the tray by statusItem pointer
        for (auto& [id, tray] : g_trays) {
            if (tray.get() == statusItem) {
                tray->setMenu(jsonString);
                break;
            }
        }
    });
}

ELECTROBUN_EXPORT void setTrayMenu(void* statusItem, const char* menuConfig) {
    setTrayMenuFromJSON(statusItem, menuConfig);
}

ELECTROBUN_EXPORT void removeTray(void* statusItem) {
    dispatch_sync_main_void([&]() {
        // Find the tray by statusItem pointer and remove it
        for (auto it = g_trays.begin(); it != g_trays.end(); ++it) {
            if (it->second.get() == statusItem) {
                g_trays.erase(it);
                break;
            }
        }
    });
}
#else // NO_APPINDICATOR
// Stub implementations when AppIndicator is not available
ELECTROBUN_EXPORT void* createTray(uint32_t trayId, const char* title, const char* pathToImage, bool isTemplate, uint32_t width, uint32_t height, void* clickHandler) {
    return nullptr;
}

ELECTROBUN_EXPORT void setTrayTitle(void* statusItem, const char* title) {}
ELECTROBUN_EXPORT void setTrayImage(void* statusItem, const char* image) {}
ELECTROBUN_EXPORT void setTrayMenuFromJSON(void* statusItem, const char* jsonString) {}
ELECTROBUN_EXPORT void setTrayMenu(void* statusItem, const char* menuConfig) {}
ELECTROBUN_EXPORT void removeTray(void* statusItem) {}
#endif // NO_APPINDICATOR

ELECTROBUN_EXPORT void setApplicationMenu(const char* jsonString, void* applicationMenuHandler) {
    if (!jsonString || strlen(jsonString) == 0) {
        return;
    }
    
    // Wait for GTK initialization to complete
    waitForGTKInit();
    
    dispatch_sync_main_void([&]() {
        try {
            // Store the menu config globally so it can be applied to future windows
            g_applicationMenuConfig = std::string(jsonString);
            g_applicationMenuHandler = reinterpret_cast<ZigStatusItemHandler>(applicationMenuHandler);
            
            std::vector<MenuJsonValue> menuItems = parseMenuJson(g_applicationMenuConfig);
            
            // Apply menu to all existing GTK windows  
            for (auto& containerPair : g_containers) {
                auto container = containerPair.second;
                if (container && container->window) {
                    applyApplicationMenuToWindow(container->window);
                }
            }
            
            // Apply menu to all existing X11 windows
            for (auto& x11Pair : g_x11_windows) {
                auto x11win = x11Pair.second;
                if (x11win) {
                    applyApplicationMenuToX11Window(x11win.get());
                }
            }
        } catch (const std::exception& e) {
            // Handle exception silently
        }
    });
}

// NOTE: Context menu behavior on Linux is limited compared to macOS.
// On macOS, you can programmatically show a custom menu at the current mouse position.
// On Linux/GTK, context menus are typically triggered by right-click events rather than
// programmatic calls. This function is not supported on Linux.
ELECTROBUN_EXPORT void showContextMenu(const char* jsonString, void* contextMenuHandler) {
    printf("showContextMenu is not supported on Linux. Use application menus or system tray menus instead.\n");
    fflush(stdout);
}

ELECTROBUN_EXPORT void getWebviewSnapshot(uint32_t hostId, uint32_t webviewId, double x, double y, double width, double height, void* completionHandler) {
    // TODO: Implement webview snapshot
}

void setJSUtils(void* getMimeType, void* getHTMLForWebviewSync) {
    printf("setJSUtils called but using map-based approach instead of callbacks\n");
    fflush(stdout);
}

// MARK: - Webview HTML Content Management (replaces JSCallback approach)

extern "C" void setWebviewHTMLContent(uint32_t webviewId, const char* htmlContent) {
    std::lock_guard<std::mutex> lock(webviewHTMLMutex);
    if (htmlContent) {
        webviewHTMLContent[webviewId] = std::string(htmlContent);
        printf("setWebviewHTMLContent: Set HTML for webview %u\n", webviewId);
    } else {
        webviewHTMLContent.erase(webviewId);
        printf("setWebviewHTMLContent: Cleared HTML for webview %u\n", webviewId);
    }
    fflush(stdout);
}

const char* getWebviewHTMLContent(uint32_t webviewId) {
    std::lock_guard<std::mutex> lock(webviewHTMLMutex);
    auto it = webviewHTMLContent.find(webviewId);
    if (it != webviewHTMLContent.end()) {
        char* result = strdup(it->second.c_str());
        printf("getWebviewHTMLContent: Retrieved HTML for webview %u\n", webviewId);
        fflush(stdout);
        return result;
    } else {
        printf("getWebviewHTMLContent: No HTML found for webview %u\n", webviewId);
        fflush(stdout);
        return nullptr;
    }
}

ELECTROBUN_EXPORT void startEventLoop(const char* identifier, const char* channel) {
    // Store identifier and channel globally for use in CEF initialization
    if (identifier && identifier[0]) {
        g_electrobunIdentifier = std::string(identifier);
    }
    if (channel && channel[0]) {
        g_electrobunChannel = std::string(channel);
    }

    // Linux uses runEventLoop instead
    runEventLoop();
}

ELECTROBUN_EXPORT void killApp() {
    // Set shutdown flag to prevent race conditions
    g_shuttingDown.store(true);
    printf("DEBUG: killApp called - immediate shutdown\n");
    
    // Properly shutdown GTK and then exit
    gtk_main_quit();
    exit(0);
}

ELECTROBUN_EXPORT void shutdownApplication() {
    // Set shutdown flag to prevent race conditions
    g_shuttingDown.store(true);
    printf("DEBUG: Application shutdown initiated\n");
    
    // Brief delay to allow ongoing operations to complete
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    
    // Graceful shutdown
    gtk_main_quit();
}

void* createNSRectWrapper(double x, double y, double width, double height) {
    // TODO: Return appropriate rectangle structure
    return nullptr;
}


// Helper function to clean up webviews when a window is closed
void cleanupWebviewsForWindow(uint32_t windowId) {
    // Check if we're shutting down to avoid cleanup races
    if (g_shuttingDown.load()) {
        printf("DEBUG: Skipping webview cleanup for window %u - shutting down\n", windowId);
        return;
    }
    
    // Prevent double cleanup for the same window
    static std::set<uint32_t> s_cleaningWindows;
    static std::mutex s_cleanupMutex;
    
    {
        std::lock_guard<std::mutex> cleanup_lock(s_cleanupMutex);
        if (s_cleaningWindows.count(windowId) > 0) {
            printf("DEBUG: Already cleaning window %u, skipping\n", windowId);
            return;
        }
        s_cleaningWindows.insert(windowId);
    }
    
    // Find and remove the container
    std::shared_ptr<ContainerView> container;
    {
        std::lock_guard<std::mutex> lock(g_containersMutex);
        auto it = g_containers.find(windowId);
        if (it != g_containers.end()) {
            container = it->second;
            g_containers.erase(it);
        }
    }
    
    if (container) {
        // Clean up all webviews in this container
        std::lock_guard<std::mutex> lock(g_webviewMapMutex);
        for (auto& webview : container->abstractViews) {
            if (webview) {
                g_webviewMap.erase(webview->webviewId);
            }
        }
    }
    
    // Mark cleanup as complete
    {
        std::lock_guard<std::mutex> cleanup_lock(s_cleanupMutex);
        s_cleaningWindows.erase(windowId);
    }
}

ELECTROBUN_EXPORT void closeWindow(void* window) {
    if (!window) return;
    
    // Check if we're shutting down
    if (g_shuttingDown.load()) {
        printf("DEBUG: Skipping window close %p - shutting down\n", window);
        return;
    }
    
    // Prevent double-close for the same window pointer
    static std::set<void*> s_closingWindows;
    static std::mutex s_closeWindowMutex;
    
    {
        std::lock_guard<std::mutex> close_lock(s_closeWindowMutex);
        if (s_closingWindows.count(window) > 0) {
            printf("DEBUG: Already closing window %p, skipping\n", window);
            return;
        }
        s_closingWindows.insert(window);
    }
    
    dispatch_sync_main_void([&]() {
        // Check if it's a GTK window first
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            printf("DEBUG: closeWindow called for GTK window\n");
            
            // Find the container for this window to get the windowId and callback
            uint32_t windowId = 0;
            WindowCloseCallback closeCallback = nullptr;
            {
                std::lock_guard<std::mutex> lock(g_containersMutex);
                for (auto& [id, container] : g_containers) {
                    if (container->window == gtkWindow) {
                        windowId = id;
                        closeCallback = container->closeCallback;
                        break;
                    }
                }
            }
            
            // Clean up webviews first
            if (windowId > 0) {
                cleanupWebviewsForWindow(windowId);
            }
            
            // Call the close callback before destroying the window
            if (closeCallback && windowId > 0) {
                printf("DEBUG: Calling close callback for GTK window ID: %u\n", windowId);
                closeCallback(windowId);
            }
            
            printf("DEBUG: Destroying GTK window\n");
            gtk_widget_destroy(gtkWindow);
        } else {
            // It's an X11 window
            X11Window* x11win = static_cast<X11Window*>(window);
            
            // Validate the X11 window pointer and check if it's still in our maps
            bool window_valid = false;
            uint32_t windowId = 0;
            {
                std::lock_guard<std::mutex> lock(g_x11WindowsMutex);
                for (auto& [id, win] : g_x11_windows) {
                    if (win.get() == x11win && x11win->display && x11win->window) {
                        window_valid = true;
                        windowId = id;
                        break;
                    }
                }
            }
            
            if (!window_valid) {
                printf("DEBUG: X11 window %p already closed or invalid\n", window);
            } else {
                printf("DEBUG: closeWindow called for X11 window ID: %u\n", windowId);
                
                // Store callback and window info before any cleanup
                auto callback = x11win->closeCallback;
                auto display = x11win->display;
                auto x11_window = x11win->window;
                
                // Clean up webviews first
                cleanupWebviewsForWindow(windowId);
                
                // Remove from global maps first to prevent any access during callback
                {
                    std::lock_guard<std::mutex> lock(g_x11WindowsMutex);
                    g_x11_window_to_id.erase(x11_window);
                    g_x11_windows.erase(windowId);
                }
                
                // Call the close callback
                if (callback) {
                    printf("DEBUG: Calling close callback for X11 window ID: %u\n", windowId);
                    callback(windowId);
                }
                
                printf("DEBUG: Destroying X11 window\n");
                XDestroyWindow(display, x11_window);
                XFlush(display);

                // Note: Don't close display here as it might be shared
            }
        }
    });
    
    // Mark close as complete
    {
        std::lock_guard<std::mutex> close_lock(s_closeWindowMutex);
        s_closingWindows.erase(window);
    }
}

ELECTROBUN_EXPORT void minimizeWindow(void* window) {
    if (!window) return;

    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                gtk_window_iconify(GTK_WINDOW(gtkWindow));
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                XIconifyWindow(x11win->display, x11win->window, DefaultScreen(x11win->display));
                XFlush(x11win->display);
            }
        }
    });
}

ELECTROBUN_EXPORT void restoreWindow(void* window) {
    if (!window) return;

    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                gtk_window_deiconify(GTK_WINDOW(gtkWindow));
                gtk_window_present(GTK_WINDOW(gtkWindow));
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                // First, map the window
                XMapWindow(x11win->display, x11win->window);
                
                // Send a client message to change the WM_STATE from IconicState to NormalState
                XEvent event;
                memset(&event, 0, sizeof(event));
                event.type = ClientMessage;
                event.xclient.window = x11win->window;
                event.xclient.message_type = XInternAtom(x11win->display, "WM_CHANGE_STATE", False);
                event.xclient.format = 32;
                event.xclient.data.l[0] = 1; // NormalState
                
                XSendEvent(x11win->display, DefaultRootWindow(x11win->display), False,
                          SubstructureNotifyMask | SubstructureRedirectMask, &event);
                
                // Also use _NET_WM_STATE to ensure the window is not minimized
                Atom wmState = XInternAtom(x11win->display, "_NET_WM_STATE", False);
                Atom wmStateHidden = XInternAtom(x11win->display, "_NET_WM_STATE_HIDDEN", False);
                
                XEvent xev;
                memset(&xev, 0, sizeof(xev));
                xev.type = ClientMessage;
                xev.xclient.window = x11win->window;
                xev.xclient.message_type = wmState;
                xev.xclient.format = 32;
                xev.xclient.data.l[0] = 0; // _NET_WM_STATE_REMOVE
                xev.xclient.data.l[1] = wmStateHidden;
                xev.xclient.data.l[2] = 0;
                
                XSendEvent(x11win->display, DefaultRootWindow(x11win->display), False,
                          SubstructureRedirectMask | SubstructureNotifyMask, &xev);
                
                XFlush(x11win->display);
            }
        }
    });
}

ELECTROBUN_EXPORT bool isWindowMinimized(void* window) {
    if (!window) return false;

    bool result = false;
    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                GdkWindow* gdkWindow = gtk_widget_get_window(gtkWindow);
                if (gdkWindow) {
                    GdkWindowState state = gdk_window_get_state(gdkWindow);
                    result = (state & GDK_WINDOW_STATE_ICONIFIED) != 0;
                }
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                Atom wmState = XInternAtom(x11win->display, "WM_STATE", True);
                if (wmState != None) {
                    Atom actualType;
                    int actualFormat;
                    unsigned long nItems, bytesAfter;
                    unsigned char* propData = nullptr;

                    if (XGetWindowProperty(x11win->display, x11win->window, wmState,
                            0, 2, False, wmState, &actualType, &actualFormat,
                            &nItems, &bytesAfter, &propData) == Success && propData) {
                        // WM_STATE first element: WithdrawnState=0, NormalState=1, IconicState=3
                        if (nItems > 0) {
                            result = (propData[0] == 3); // IconicState
                        }
                        XFree(propData);
                    }
                    
                    // Also check _NET_WM_STATE_HIDDEN as a fallback
                    if (!result) {
                        Atom netWmState = XInternAtom(x11win->display, "_NET_WM_STATE", False);
                        Atom netWmStateHidden = XInternAtom(x11win->display, "_NET_WM_STATE_HIDDEN", False);
                        
                        if (netWmState != None) {
                            Atom actualType2;
                            int actualFormat2;
                            unsigned long nItems2, bytesAfter2;
                            unsigned char* propData2 = nullptr;
                            
                            if (XGetWindowProperty(x11win->display, x11win->window, netWmState,
                                    0, 1024, False, XA_ATOM, &actualType2, &actualFormat2,
                                    &nItems2, &bytesAfter2, &propData2) == Success && propData2) {
                                Atom* atoms = (Atom*)propData2;
                                for (unsigned long i = 0; i < nItems2; i++) {
                                    if (atoms[i] == netWmStateHidden) {
                                        result = true;
                                        break;
                                    }
                                }
                                XFree(propData2);
                            }
                        }
                    }
                }
            }
        }
    });
    return result;
}

ELECTROBUN_EXPORT void maximizeWindow(void* window) {
    if (!window) return;

    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                gtk_window_maximize(GTK_WINDOW(gtkWindow));
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                Atom wmState = XInternAtom(x11win->display, "_NET_WM_STATE", False);
                Atom maxH = XInternAtom(x11win->display, "_NET_WM_STATE_MAXIMIZED_HORZ", False);
                Atom maxV = XInternAtom(x11win->display, "_NET_WM_STATE_MAXIMIZED_VERT", False);

                XEvent xev = {};
                xev.type = ClientMessage;
                xev.xclient.window = x11win->window;
                xev.xclient.message_type = wmState;
                xev.xclient.format = 32;
                xev.xclient.data.l[0] = 1; // _NET_WM_STATE_ADD
                xev.xclient.data.l[1] = maxH;
                xev.xclient.data.l[2] = maxV;
                xev.xclient.data.l[3] = 0;

                XSendEvent(x11win->display, DefaultRootWindow(x11win->display), False,
                    SubstructureRedirectMask | SubstructureNotifyMask, &xev);
                XFlush(x11win->display);
            }
        }
    });
}

ELECTROBUN_EXPORT void unmaximizeWindow(void* window) {
    if (!window) return;

    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                gtk_window_unmaximize(GTK_WINDOW(gtkWindow));
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                Atom wmState = XInternAtom(x11win->display, "_NET_WM_STATE", False);
                Atom maxH = XInternAtom(x11win->display, "_NET_WM_STATE_MAXIMIZED_HORZ", False);
                Atom maxV = XInternAtom(x11win->display, "_NET_WM_STATE_MAXIMIZED_VERT", False);

                XEvent xev = {};
                xev.type = ClientMessage;
                xev.xclient.window = x11win->window;
                xev.xclient.message_type = wmState;
                xev.xclient.format = 32;
                xev.xclient.data.l[0] = 0; // _NET_WM_STATE_REMOVE
                xev.xclient.data.l[1] = maxH;
                xev.xclient.data.l[2] = maxV;
                xev.xclient.data.l[3] = 0;

                XSendEvent(x11win->display, DefaultRootWindow(x11win->display), False,
                    SubstructureRedirectMask | SubstructureNotifyMask, &xev);
                XFlush(x11win->display);
            }
        }
    });
}

ELECTROBUN_EXPORT bool isWindowMaximized(void* window) {
    if (!window) return false;

    bool result = false;
    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                result = gtk_window_is_maximized(GTK_WINDOW(gtkWindow));
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                Atom wmState = XInternAtom(x11win->display, "_NET_WM_STATE", False);
                Atom maxH = XInternAtom(x11win->display, "_NET_WM_STATE_MAXIMIZED_HORZ", False);
                Atom maxV = XInternAtom(x11win->display, "_NET_WM_STATE_MAXIMIZED_VERT", False);

                Atom actualType;
                int actualFormat;
                unsigned long nItems, bytesAfter;
                unsigned char* propData = nullptr;

                if (XGetWindowProperty(x11win->display, x11win->window, wmState,
                        0, (~0L), False, XA_ATOM, &actualType, &actualFormat,
                        &nItems, &bytesAfter, &propData) == Success && propData) {
                    Atom* atoms = reinterpret_cast<Atom*>(propData);
                    bool hasMaxH = false, hasMaxV = false;
                    for (unsigned long i = 0; i < nItems; i++) {
                        if (atoms[i] == maxH) hasMaxH = true;
                        if (atoms[i] == maxV) hasMaxV = true;
                    }
                    result = hasMaxH && hasMaxV;
                    XFree(propData);
                }
            }
        }
    });
    return result;
}

ELECTROBUN_EXPORT void setWindowFullScreen(void* window, bool fullScreen) {
    if (!window) return;

    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                if (fullScreen) {
                    gtk_window_fullscreen(GTK_WINDOW(gtkWindow));
                } else {
                    gtk_window_unfullscreen(GTK_WINDOW(gtkWindow));
                }
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                Atom wmState = XInternAtom(x11win->display, "_NET_WM_STATE", False);
                Atom fullscreenAtom = XInternAtom(x11win->display, "_NET_WM_STATE_FULLSCREEN", False);

                XEvent xev = {};
                xev.type = ClientMessage;
                xev.xclient.window = x11win->window;
                xev.xclient.message_type = wmState;
                xev.xclient.format = 32;
                xev.xclient.data.l[0] = fullScreen ? 1 : 0; // _NET_WM_STATE_ADD or REMOVE
                xev.xclient.data.l[1] = fullscreenAtom;
                xev.xclient.data.l[2] = 0;
                xev.xclient.data.l[3] = 0;

                XSendEvent(x11win->display, DefaultRootWindow(x11win->display), False,
                    SubstructureRedirectMask | SubstructureNotifyMask, &xev);
                XFlush(x11win->display);
            }
        }
    });
}

ELECTROBUN_EXPORT bool isWindowFullScreen(void* window) {
    if (!window) return false;

    bool result = false;
    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                GdkWindow* gdkWindow = gtk_widget_get_window(gtkWindow);
                if (gdkWindow) {
                    GdkWindowState state = gdk_window_get_state(gdkWindow);
                    result = (state & GDK_WINDOW_STATE_FULLSCREEN) != 0;
                }
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                Atom wmState = XInternAtom(x11win->display, "_NET_WM_STATE", False);
                Atom fullscreenAtom = XInternAtom(x11win->display, "_NET_WM_STATE_FULLSCREEN", False);

                Atom actualType;
                int actualFormat;
                unsigned long nItems, bytesAfter;
                unsigned char* propData = nullptr;

                if (XGetWindowProperty(x11win->display, x11win->window, wmState,
                        0, (~0L), False, XA_ATOM, &actualType, &actualFormat,
                        &nItems, &bytesAfter, &propData) == Success && propData) {
                    Atom* atoms = reinterpret_cast<Atom*>(propData);
                    for (unsigned long i = 0; i < nItems; i++) {
                        if (atoms[i] == fullscreenAtom) {
                            result = true;
                            break;
                        }
                    }
                    XFree(propData);
                }
            }
        }
    });
    return result;
}

ELECTROBUN_EXPORT void setWindowAlwaysOnTop(void* window, bool alwaysOnTop) {
    if (!window) return;

    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                gtk_window_set_keep_above(GTK_WINDOW(gtkWindow), alwaysOnTop ? TRUE : FALSE);
                // Focus the window when setting always on top to ensure visibility
                if (alwaysOnTop) {
                    gtk_window_present(GTK_WINDOW(gtkWindow));
                }
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                Atom wmState = XInternAtom(x11win->display, "_NET_WM_STATE", False);
                Atom aboveAtom = XInternAtom(x11win->display, "_NET_WM_STATE_ABOVE", False);

                XEvent xev = {};
                xev.type = ClientMessage;
                xev.xclient.window = x11win->window;
                xev.xclient.message_type = wmState;
                xev.xclient.format = 32;
                xev.xclient.data.l[0] = alwaysOnTop ? 1 : 0; // _NET_WM_STATE_ADD or REMOVE
                xev.xclient.data.l[1] = aboveAtom;
                xev.xclient.data.l[2] = 0;
                xev.xclient.data.l[3] = 0;

                XSendEvent(x11win->display, DefaultRootWindow(x11win->display), False,
                    SubstructureRedirectMask | SubstructureNotifyMask, &xev);
                XFlush(x11win->display);
            }
        }
    });
}

ELECTROBUN_EXPORT bool isWindowAlwaysOnTop(void* window) {
    if (!window) return false;

    bool result = false;
    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                GdkWindow* gdkWindow = gtk_widget_get_window(gtkWindow);
                if (gdkWindow) {
                    GdkWindowState state = gdk_window_get_state(gdkWindow);
                    result = (state & GDK_WINDOW_STATE_ABOVE) != 0;
                }
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                Atom wmState = XInternAtom(x11win->display, "_NET_WM_STATE", False);
                Atom aboveAtom = XInternAtom(x11win->display, "_NET_WM_STATE_ABOVE", False);

                Atom actualType;
                int actualFormat;
                unsigned long nItems, bytesAfter;
                unsigned char* propData = nullptr;

                if (XGetWindowProperty(x11win->display, x11win->window, wmState,
                        0, (~0L), False, XA_ATOM, &actualType, &actualFormat,
                        &nItems, &bytesAfter, &propData) == Success && propData) {
                    Atom* atoms = reinterpret_cast<Atom*>(propData);
                    for (unsigned long i = 0; i < nItems; i++) {
                        if (atoms[i] == aboveAtom) {
                            result = true;
                            break;
                        }
                    }
                    XFree(propData);
                }
            }
        }
    });
    return result;
}

ELECTROBUN_EXPORT void setWindowPosition(void* window, double x, double y) {
    if (!window) return;

    dispatch_sync_main_void([=]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                gtk_window_move(GTK_WINDOW(gtkWindow), (int)x, (int)y);
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                // Set window position, accounting for window manager
                XMoveWindow(x11win->display, x11win->window, (int)x, (int)y);
                
                // Also send a ConfigureRequest event to ensure window manager compliance
                XEvent event;
                memset(&event, 0, sizeof(event));
                event.xconfigure.type = ConfigureNotify;
                event.xconfigure.window = x11win->window;
                event.xconfigure.x = (int)x;
                event.xconfigure.y = (int)y;
                XSendEvent(x11win->display, x11win->window, False, StructureNotifyMask, &event);
                
                XFlush(x11win->display);
            }
        }
    });
}

ELECTROBUN_EXPORT void setWindowSize(void* window, double width, double height) {
    if (!window) return;

    dispatch_sync_main_void([=]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                gtk_window_resize(GTK_WINDOW(gtkWindow), (int)width, (int)height);
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                XResizeWindow(x11win->display, x11win->window, (unsigned int)width, (unsigned int)height);
                XFlush(x11win->display);
            }
        }
    });
}

ELECTROBUN_EXPORT void setWindowFrame(void* window, double x, double y, double width, double height) {
    if (!window) return;

    dispatch_sync_main_void([=]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                gtk_window_move(GTK_WINDOW(gtkWindow), (int)x, (int)y);
                gtk_window_resize(GTK_WINDOW(gtkWindow), (int)width, (int)height);
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                XMoveResizeWindow(x11win->display, x11win->window, (int)x, (int)y, (unsigned int)width, (unsigned int)height);
                XFlush(x11win->display);
            }
        }
    });
}

ELECTROBUN_EXPORT void getWindowFrame(void* window, double* outX, double* outY, double* outWidth, double* outHeight) {
    if (!window) {
        *outX = 0;
        *outY = 0;
        *outWidth = 0;
        *outHeight = 0;
        return;
    }

    dispatch_sync_main_void([&]() {
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                gint wx, wy, ww, wh;
                gtk_window_get_position(GTK_WINDOW(gtkWindow), &wx, &wy);
                gtk_window_get_size(GTK_WINDOW(gtkWindow), &ww, &wh);
                *outX = (double)wx;
                *outY = (double)wy;
                *outWidth = (double)ww;
                *outHeight = (double)wh;
            }
        } else {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                XWindowAttributes attrs;
                if (XGetWindowAttributes(x11win->display, x11win->window, &attrs)) {
                    // Get the absolute position of the window
                    int abs_x = 0, abs_y = 0;
                    Window child;
                    
                    // Translate from window coordinates (0,0) to root window coordinates
                    XTranslateCoordinates(x11win->display, x11win->window,
                        DefaultRootWindow(x11win->display), 
                        0, 0, &abs_x, &abs_y, &child);
                    
                    // For windows with decorations, we need to get the frame extents
                    Atom actualType;
                    int actualFormat;
                    unsigned long nItems, bytesAfter;
                    unsigned char* data = nullptr;
                    
                    Atom frameExtents = XInternAtom(x11win->display, "_NET_FRAME_EXTENTS", False);
                    if (frameExtents != None) {
                        if (XGetWindowProperty(x11win->display, x11win->window, frameExtents,
                                             0, 4, False, XA_CARDINAL,
                                             &actualType, &actualFormat, &nItems, &bytesAfter,
                                             &data) == Success && data) {
                            if (nItems == 4 && actualFormat == 32) {
                                long* extents = (long*)data;
                                // Adjust position by left and top frame extents
                                abs_x -= extents[0]; // left
                                abs_y -= extents[2]; // top
                            }
                            XFree(data);
                        }
                    }
                    
                    *outX = (double)abs_x;
                    *outY = (double)abs_y;
                    *outWidth = (double)attrs.width;
                    *outHeight = (double)attrs.height;
                } else {
                    *outX = 0;
                    *outY = 0;
                    *outWidth = 0;
                    *outHeight = 0;
                }
            }
        }
    });
}

ELECTROBUN_EXPORT void getWindowPosition(void* window, double* outX, double* outY) {
    double width, height;
    getWindowFrame(window, outX, outY, &width, &height);
}

ELECTROBUN_EXPORT void getWindowSize(void* window, double* outWidth, double* outHeight) {
    double x, y;
    getWindowFrame(window, &x, &y, outWidth, outHeight);
}

ELECTROBUN_EXPORT void setWindowIcon(void* window, const char* iconPath) {
    if (!window || !iconPath) return;

    dispatch_sync_main_void([=]() {
        std::string actualPath(iconPath);
        
        // Handle views:// protocol
        if (actualPath.substr(0, 8) == "views://") {
            std::string viewPath = actualPath.substr(8);
            
            // Try to load from ASAR archive first if available
            if (g_asarArchive) {
                size_t fileSize = 0;
                const uint8_t* fileData = asar_read_file(g_asarArchive, 
                    ("views/" + viewPath).c_str(), &fileSize);
                
                if (fileData && fileSize > 0) {
                    // Create pixbuf from memory
                    GError* error = nullptr;
                    GdkPixbufLoader* loader = gdk_pixbuf_loader_new();
                    
                    if (gdk_pixbuf_loader_write(loader, fileData, fileSize, &error)) {
                        gdk_pixbuf_loader_close(loader, nullptr);
                        GdkPixbuf* pixbuf = gdk_pixbuf_loader_get_pixbuf(loader);
                        
                        if (pixbuf) {
                            g_object_ref(pixbuf); // Keep a reference
                            
                            if (GTK_IS_WIDGET(window)) {
                                gtk_window_set_icon(GTK_WINDOW(window), pixbuf);
                            } else {
                                // Handle X11 window icon setting (moved to separate function)
                                setX11WindowIcon(static_cast<X11Window*>(window), pixbuf);
                            }
                            
                            g_object_unref(pixbuf);
                        }
                    }
                    
                    g_object_unref(loader);
                    asar_free_buffer(fileData, fileSize);
                    if (error) g_error_free(error);
                    return;
                }
            }
            
            // Fallback to file system
            actualPath = "Resources/app/views/" + viewPath;
        }
        
        if (GTK_IS_WIDGET(window)) {
            GtkWidget* gtkWindow = static_cast<GtkWidget*>(window);
            if (GTK_IS_WINDOW(gtkWindow)) {
                GError* error = nullptr;
                
                // Load icon from file
                GdkPixbuf* pixbuf = gdk_pixbuf_new_from_file(actualPath.c_str(), &error);
                if (pixbuf) {
                    gtk_window_set_icon(GTK_WINDOW(gtkWindow), pixbuf);
                    g_object_unref(pixbuf);
                } else {
                    fprintf(stderr, "Failed to load icon from %s: %s\n", actualPath.c_str(), 
                            error ? error->message : "Unknown error");
                    if (error) g_error_free(error);
                }
            }
        } else {
            // For X11/CEF windows
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                GError* error = nullptr;
                GdkPixbuf* pixbuf = gdk_pixbuf_new_from_file(actualPath.c_str(), &error);
                
                if (pixbuf) {
                    setX11WindowIcon(x11win, pixbuf);
                    g_object_unref(pixbuf);
                } else {
                    fprintf(stderr, "Failed to load icon from %s: %s\n", actualPath.c_str(), 
                            error ? error->message : "Unknown error");
                    if (error) g_error_free(error);
                }
            }
        }
    });
}

/*
 * =============================================================================
 * GLOBAL KEYBOARD SHORTCUTS
 * =============================================================================
 */

// Callback type for global shortcut triggers
typedef void (*GlobalShortcutCallback)(const char* accelerator);
static GlobalShortcutCallback g_globalShortcutCallback = nullptr;

// Storage for registered shortcuts
struct ShortcutInfo {
    KeyCode keycode;
    unsigned int modifiers;
};
static std::map<std::string, ShortcutInfo> g_globalShortcuts;
static Display* g_shortcutDisplay = nullptr;
static std::thread g_shortcutThread;
static bool g_shortcutThreadRunning = false;

// Helper to get X11 keysym from key string
static KeySym getKeySym(const std::string& key) {
    std::string lowerKey = key;
    std::transform(lowerKey.begin(), lowerKey.end(), lowerKey.begin(), ::tolower);

    // Letters
    if (lowerKey.length() == 1 && lowerKey[0] >= 'a' && lowerKey[0] <= 'z') {
        return XK_a + (lowerKey[0] - 'a');
    }
    // Numbers
    if (lowerKey.length() == 1 && lowerKey[0] >= '0' && lowerKey[0] <= '9') {
        return XK_0 + (lowerKey[0] - '0');
    }
    // Function keys (F1-F24)
    if (lowerKey[0] == 'f' && lowerKey.length() >= 2) {
        int fNum = std::stoi(lowerKey.substr(1));
        if (fNum >= 1 && fNum <= 24) {
            if (fNum <= 12) return XK_F1 + (fNum - 1);
            else return XK_F13 + (fNum - 13);  // F13-F24
        }
    }
    // Special keys
    if (lowerKey == "space" || lowerKey == " ") return XK_space;
    if (lowerKey == "return" || lowerKey == "enter") return XK_Return;
    if (lowerKey == "tab") return XK_Tab;
    if (lowerKey == "escape" || lowerKey == "esc") return XK_Escape;
    if (lowerKey == "backspace") return XK_BackSpace;
    if (lowerKey == "delete") return XK_Delete;
    if (lowerKey == "insert") return XK_Insert;
    if (lowerKey == "up") return XK_Up;
    if (lowerKey == "down") return XK_Down;
    if (lowerKey == "left") return XK_Left;
    if (lowerKey == "right") return XK_Right;
    if (lowerKey == "home") return XK_Home;
    if (lowerKey == "end") return XK_End;
    if (lowerKey == "pageup") return XK_Page_Up;
    if (lowerKey == "pagedown") return XK_Page_Down;
    if (lowerKey == "print") return XK_Print;
    // Additional special keys
    if (lowerKey == "scrolllock") return XK_Scroll_Lock;
    if (lowerKey == "pause") return XK_Pause;
    if (lowerKey == "break") return XK_Break;
    if (lowerKey == "sysreq") return XK_Sys_Req;
    if (lowerKey == "numlock") return XK_Num_Lock;
    if (lowerKey == "capslock") return XK_Caps_Lock;
    if (lowerKey == "menu") return XK_Menu;
    if (lowerKey == "apps") return XK_Menu;  // Same as Menu
    if (lowerKey == "printscreen") return XK_Print;
    if (lowerKey == "cancel") return XK_Cancel;
    // Media keys (may not be available on all systems)
    if (lowerKey == "mediaselect") return XK_Select;  // Closest equivalent
    if (lowerKey == "calculator") return 0x1008ff1d;  // XF86Calculator
    if (lowerKey == "sleep") return 0x1008ff2f;  // XF86Sleep
    // Symbols
    if (lowerKey == "-") return XK_minus;
    if (lowerKey == "=") return XK_equal;
    if (lowerKey == "[") return XK_bracketleft;
    if (lowerKey == "]") return XK_bracketright;
    if (lowerKey == "\\") return XK_backslash;
    if (lowerKey == ";") return XK_semicolon;
    if (lowerKey == "'") return XK_apostrophe;
    if (lowerKey == ",") return XK_comma;
    if (lowerKey == ".") return XK_period;
    if (lowerKey == "/") return XK_slash;
    if (lowerKey == "`") return XK_grave;

    return NoSymbol;
}

// Helper to parse modifiers from accelerator string
static unsigned int parseX11Modifiers(const std::string& accelerator, std::string& outKey) {
    unsigned int modifiers = 0;
    std::vector<std::string> parts;

    // Split by '+'
    size_t start = 0, end;
    while ((end = accelerator.find('+', start)) != std::string::npos) {
        parts.push_back(accelerator.substr(start, end - start));
        start = end + 1;
    }
    parts.push_back(accelerator.substr(start));

    // Last part is the key
    outKey = parts.back();
    parts.pop_back();

    for (const auto& part : parts) {
        std::string lowerPart = part;
        std::transform(lowerPart.begin(), lowerPart.end(), lowerPart.begin(), ::tolower);

        if (lowerPart == "command" || lowerPart == "cmd" ||
            lowerPart == "commandorcontrol" || lowerPart == "cmdorctrl" ||
            lowerPart == "control" || lowerPart == "ctrl") {
            modifiers |= ControlMask;
        } else if (lowerPart == "alt" || lowerPart == "option") {
            modifiers |= Mod1Mask;
        } else if (lowerPart == "shift") {
            modifiers |= ShiftMask;
        } else if (lowerPart == "super" || lowerPart == "meta" || lowerPart == "win") {
            modifiers |= Mod4Mask;
        }
    }

    return modifiers;
}

// X11 event loop for global shortcuts
static void shortcutEventLoop() {
    g_shortcutDisplay = XOpenDisplay(nullptr);
    if (!g_shortcutDisplay) {
        fprintf(stderr, "ERROR: Failed to open X11 display for shortcuts\n");
        g_shortcutThreadRunning = false;
        return;
    }
    
    printf("GlobalShortcut: X11 display opened successfully for shortcuts\n");

    Window root = DefaultRootWindow(g_shortcutDisplay);

    while (g_shortcutThreadRunning) {
        while (XPending(g_shortcutDisplay)) {
            XEvent event;
            XNextEvent(g_shortcutDisplay, &event);

            if (event.type == KeyPress) {
                KeyCode keycode = event.xkey.keycode;
                unsigned int state = event.xkey.state & (ControlMask | ShiftMask | Mod1Mask | Mod4Mask);

                // Find matching shortcut
                for (const auto& pair : g_globalShortcuts) {
                    if (pair.second.keycode == keycode && pair.second.modifiers == state) {
                        if (g_globalShortcutCallback) {
                            g_globalShortcutCallback(pair.first.c_str());
                        }
                        break;
                    }
                }
            }
        }
        usleep(10000); // 10ms sleep
    }

    XCloseDisplay(g_shortcutDisplay);
    g_shortcutDisplay = nullptr;
}

// Set the callback for global shortcut events
ELECTROBUN_EXPORT void setGlobalShortcutCallback(GlobalShortcutCallback callback) {
    printf("GlobalShortcut: Setting callback (callback=%p)\n", callback);
    g_globalShortcutCallback = callback;

    // Start the event loop thread if not running
    if (!g_shortcutThreadRunning && callback) {
        printf("GlobalShortcut: Starting event loop thread\n");
        g_shortcutThreadRunning = true;
        g_shortcutThread = std::thread(shortcutEventLoop);
        // Wait for display to be opened
        int attempts = 0;
        while (!g_shortcutDisplay && g_shortcutThreadRunning && attempts < 100) {
            usleep(10000);
            attempts++;
        }
        if (g_shortcutDisplay) {
            printf("GlobalShortcut: Event loop ready\n");
        } else {
            fprintf(stderr, "ERROR: GlobalShortcut event loop failed to initialize\n");
        }
    }
}

// Register a global keyboard shortcut
ELECTROBUN_EXPORT bool registerGlobalShortcut(const char* accelerator) {
    printf("GlobalShortcut: registerGlobalShortcut called for '%s'\n", accelerator ? accelerator : "(null)");
    
    if (!accelerator) {
        fprintf(stderr, "ERROR: Cannot register shortcut - accelerator is null\n");
        return false;
    }
    
    if (!g_shortcutDisplay) {
        fprintf(stderr, "ERROR: Cannot register shortcut '%s' - display not ready (g_shortcutDisplay=%p)\n", 
                accelerator, g_shortcutDisplay);
        return false;
    }

    std::string accelStr(accelerator);

    // Check if already registered
    if (g_globalShortcuts.find(accelStr) != g_globalShortcuts.end()) {
        fprintf(stderr, "GlobalShortcut already registered: %s\n", accelerator);
        return false;
    }

    // Parse the accelerator
    std::string key;
    unsigned int modifiers = parseX11Modifiers(accelStr, key);
    KeySym keysym = getKeySym(key);

    if (keysym == NoSymbol) {
        fprintf(stderr, "ERROR: Unknown key: %s\n", key.c_str());
        return false;
    }

    KeyCode keycode = XKeysymToKeycode(g_shortcutDisplay, keysym);
    if (keycode == 0) {
        fprintf(stderr, "ERROR: Failed to get keycode for key: %s\n", key.c_str());
        return false;
    }

    Window root = DefaultRootWindow(g_shortcutDisplay);

    // Grab key with various modifier combinations (to handle NumLock, CapsLock, etc.)
    unsigned int modifierVariants[] = {
        modifiers,
        modifiers | Mod2Mask,  // NumLock
        modifiers | LockMask,  // CapsLock
        modifiers | Mod2Mask | LockMask
    };

    // Just try to grab the key - if it fails, XGrabKey will generate an X11 error
    // but won't crash the program. We'll optimistically assume success.
    for (unsigned int mods : modifierVariants) {
        XGrabKey(g_shortcutDisplay, keycode, mods, root, True, GrabModeAsync, GrabModeAsync);
    }
    XFlush(g_shortcutDisplay);

    // Since we can't easily detect if XGrabKey failed without complex error handling,
    // we'll assume success and let the user know if the shortcut doesn't work

    ShortcutInfo info;
    info.keycode = keycode;
    info.modifiers = modifiers;
    g_globalShortcuts[accelStr] = info;

    printf("GlobalShortcut registered: %s (keycode: %d, modifiers: 0x%X)\n",
           accelerator, keycode, modifiers);
    return true;
}

// Unregister a global keyboard shortcut
ELECTROBUN_EXPORT bool unregisterGlobalShortcut(const char* accelerator) {
    if (!accelerator || !g_shortcutDisplay) return false;

    std::string accelStr(accelerator);
    auto it = g_globalShortcuts.find(accelStr);
    if (it != g_globalShortcuts.end()) {
        Window root = DefaultRootWindow(g_shortcutDisplay);
        KeyCode keycode = it->second.keycode;
        unsigned int modifiers = it->second.modifiers;

        // Ungrab with same modifier variants
        unsigned int modifierVariants[] = {
            modifiers,
            modifiers | Mod2Mask,
            modifiers | LockMask,
            modifiers | Mod2Mask | LockMask
        };

        for (unsigned int mods : modifierVariants) {
            XUngrabKey(g_shortcutDisplay, keycode, mods, root);
        }
        XFlush(g_shortcutDisplay);

        g_globalShortcuts.erase(it);
        printf("GlobalShortcut unregistered: %s\n", accelerator);
        return true;
    }

    return false;
}

// Unregister all global keyboard shortcuts
ELECTROBUN_EXPORT void unregisterAllGlobalShortcuts() {
    if (!g_shortcutDisplay) return;

    Window root = DefaultRootWindow(g_shortcutDisplay);

    for (const auto& pair : g_globalShortcuts) {
        KeyCode keycode = pair.second.keycode;
        unsigned int modifiers = pair.second.modifiers;

        unsigned int modifierVariants[] = {
            modifiers,
            modifiers | Mod2Mask,
            modifiers | LockMask,
            modifiers | Mod2Mask | LockMask
        };

        for (unsigned int mods : modifierVariants) {
            XUngrabKey(g_shortcutDisplay, keycode, mods, root);
        }
    }
    XFlush(g_shortcutDisplay);

    g_globalShortcuts.clear();
    printf("GlobalShortcut: Unregistered all shortcuts\n");
}

// Check if a shortcut is registered
ELECTROBUN_EXPORT bool isGlobalShortcutRegistered(const char* accelerator) {
    if (!accelerator) return false;
    return g_globalShortcuts.find(std::string(accelerator)) != g_globalShortcuts.end();
}

/*
 * =============================================================================
 * SCREEN API
 * =============================================================================
 */

// Get all displays as JSON array
ELECTROBUN_EXPORT const char* getAllDisplays() {
    GdkDisplay* display = gdk_display_get_default();
    if (!display) {
        return strdup("[]");
    }

    int numMonitors = gdk_display_get_n_monitors(display);
    GdkMonitor* primaryMonitor = gdk_display_get_primary_monitor(display);

    std::ostringstream result;
    result << "[";

    for (int i = 0; i < numMonitors; i++) {
        GdkMonitor* monitor = gdk_display_get_monitor(display, i);
        if (!monitor) continue;

        if (i > 0) result << ",";

        // Get geometry (full bounds)
        GdkRectangle geometry;
        gdk_monitor_get_geometry(monitor, &geometry);

        // Get work area (excludes panels/taskbars)
        GdkRectangle workarea;
        gdk_monitor_get_workarea(monitor, &workarea);

        // Get scale factor
        int scaleFactor = gdk_monitor_get_scale_factor(monitor);

        // Check if primary
        bool isPrimary = (monitor == primaryMonitor);

        // Use monitor index as ID (GdkMonitor doesn't have a persistent ID)
        result << "{";
        result << "\"id\":" << i << ",";
        result << "\"bounds\":{";
        result << "\"x\":" << geometry.x << ",";
        result << "\"y\":" << geometry.y << ",";
        result << "\"width\":" << geometry.width << ",";
        result << "\"height\":" << geometry.height;
        result << "},";
        result << "\"workArea\":{";
        result << "\"x\":" << workarea.x << ",";
        result << "\"y\":" << workarea.y << ",";
        result << "\"width\":" << workarea.width << ",";
        result << "\"height\":" << workarea.height;
        result << "},";
        result << "\"scaleFactor\":" << scaleFactor << ",";
        result << "\"isPrimary\":" << (isPrimary ? "true" : "false");
        result << "}";
    }

    result << "]";
    return strdup(result.str().c_str());
}

// Get primary display as JSON
ELECTROBUN_EXPORT const char* getPrimaryDisplay() {
    GdkDisplay* display = gdk_display_get_default();
    if (!display) {
        return strdup("{}");
    }

    GdkMonitor* monitor = gdk_display_get_primary_monitor(display);
    if (!monitor) {
        // Fallback to first monitor if no primary is set
        if (gdk_display_get_n_monitors(display) > 0) {
            monitor = gdk_display_get_monitor(display, 0);
        }
        if (!monitor) {
            return strdup("{}");
        }
    }

    // Get geometry (full bounds)
    GdkRectangle geometry;
    gdk_monitor_get_geometry(monitor, &geometry);

    // Get work area (excludes panels/taskbars)
    GdkRectangle workarea;
    gdk_monitor_get_workarea(monitor, &workarea);

    // Get scale factor
    int scaleFactor = gdk_monitor_get_scale_factor(monitor);

    std::ostringstream result;
    result << "{";
    result << "\"id\":0,";
    result << "\"bounds\":{";
    result << "\"x\":" << geometry.x << ",";
    result << "\"y\":" << geometry.y << ",";
    result << "\"width\":" << geometry.width << ",";
    result << "\"height\":" << geometry.height;
    result << "},";
    result << "\"workArea\":{";
    result << "\"x\":" << workarea.x << ",";
    result << "\"y\":" << workarea.y << ",";
    result << "\"width\":" << workarea.width << ",";
    result << "\"height\":" << workarea.height;
    result << "},";
    result << "\"scaleFactor\":" << scaleFactor << ",";
    result << "\"isPrimary\":true";
    result << "}";

    return strdup(result.str().c_str());
}

// Get current cursor position as JSON: {"x": 123, "y": 456}
ELECTROBUN_EXPORT const char* getCursorScreenPoint() {
    GdkDisplay* display = gdk_display_get_default();
    if (!display) {
        return strdup("{\"x\":0,\"y\":0}");
    }

    GdkSeat* seat = gdk_display_get_default_seat(display);
    if (!seat) {
        return strdup("{\"x\":0,\"y\":0}");
    }

    GdkDevice* pointer = gdk_seat_get_pointer(seat);
    if (!pointer) {
        return strdup("{\"x\":0,\"y\":0}");
    }

    int x, y;
    gdk_device_get_position(pointer, NULL, &x, &y);

    std::ostringstream result;
    result << "{\"x\":" << x << ",\"y\":" << y << "}";
    return strdup(result.str().c_str());
}

/*
 * =============================================================================
 * COOKIE MANAGEMENT API
 * =============================================================================
 */

// Store for partition-specific data managers (for cookie access)
static std::map<std::string, WebKitWebsiteDataManager*> g_partitionDataManagers;

// Get or create a data manager for a partition
static WebKitWebsiteDataManager* getDataManagerForPartition(const char* partitionIdentifier) {
    std::string partition = partitionIdentifier ? partitionIdentifier : "";

    auto it = g_partitionDataManagers.find(partition);
    if (it != g_partitionDataManagers.end()) {
        return it->second;
    }

    WebKitWebsiteDataManager* dataManager = nullptr;

    if (partition.empty()) {
        // Default: use default context's data manager
        WebKitWebContext* context = webkit_web_context_get_default();
        dataManager = webkit_web_context_get_website_data_manager(context);
    } else {
        bool isPersistent = partition.substr(0, 8) == "persist:";

        if (isPersistent) {
            std::string partitionName = partition.substr(8);
            std::string appIdentifier = !g_electrobunIdentifier.empty() ? g_electrobunIdentifier : "Electrobun";
            if (!g_electrobunChannel.empty()) {
                appIdentifier += "-" + g_electrobunChannel;
            }

            char* home = getenv("HOME");
            std::string basePath = home ? std::string(home) : "/tmp";
            std::string dataPath = basePath + "/.local/share/" + appIdentifier + "/WebKit/Partitions/" + partitionName;
            std::string cachePath = basePath + "/.cache/" + appIdentifier + "/WebKit/Partitions/" + partitionName;

            g_mkdir_with_parents(dataPath.c_str(), 0755);
            g_mkdir_with_parents(cachePath.c_str(), 0755);

            dataManager = webkit_website_data_manager_new(
                "base-data-directory", dataPath.c_str(),
                "base-cache-directory", cachePath.c_str(),
                NULL
            );
        } else {
            dataManager = webkit_website_data_manager_new_ephemeral();
        }

        g_partitionDataManagers[partition] = dataManager;
    }

    return dataManager;
}


// Helper struct for async cookie operations
struct CookieCallbackData {
    std::string* result;
    bool* done;
    GMainLoop* loop;
};

// Callback for getting cookies
static void onGetCookiesFinished(GObject* source, GAsyncResult* result, gpointer user_data) {
    CookieCallbackData* data = static_cast<CookieCallbackData*>(user_data);
    GError* error = nullptr;
    GList* cookies = webkit_cookie_manager_get_cookies_finish(
        WEBKIT_COOKIE_MANAGER(source), result, &error);

    std::ostringstream json;
    json << "[";

    if (!error && cookies) {
        GList* item = cookies;
        bool first = true;
        while (item) {
            SoupCookie* cookie = static_cast<SoupCookie*>(item->data);
            if (!first) json << ",";
            first = false;

            json << "{";
            json << "\"name\":\"" << (soup_cookie_get_name(cookie) ?: "") << "\",";
            json << "\"value\":\"" << (soup_cookie_get_value(cookie) ?: "") << "\",";
            json << "\"domain\":\"" << (soup_cookie_get_domain(cookie) ?: "") << "\",";
            json << "\"path\":\"" << (soup_cookie_get_path(cookie) ?: "") << "\",";
            json << "\"secure\":" << (soup_cookie_get_secure(cookie) ? "true" : "false") << ",";
            json << "\"httpOnly\":" << (soup_cookie_get_http_only(cookie) ? "true" : "false");

            GDateTime* expires = soup_cookie_get_expires(cookie);
            if (expires) {
                json << ",\"expirationDate\":" << g_date_time_to_unix(expires);
            }

            json << "}";

            item = item->next;
        }
        g_list_free_full(cookies, (GDestroyNotify)soup_cookie_free);
    }

    if (error) {
        g_error_free(error);
    }

    json << "]";
    *(data->result) = json.str();
    *(data->done) = true;

    if (data->loop) {
        g_main_loop_quit(data->loop);
    }
}

// Get cookies for a partition (WebKit2GTK)
ELECTROBUN_EXPORT const char* sessionGetCookies(const char* partitionIdentifier, const char* filterJson) {
    // Copy arguments before dispatching to main thread
    std::string partitionStr = partitionIdentifier ? partitionIdentifier : "";
    std::string filterStr = filterJson ? filterJson : "{}";

    return dispatch_sync_main([partitionStr, filterStr]() -> const char* {
        WebKitWebsiteDataManager* dataManager = getDataManagerForPartition(partitionStr.c_str());
        if (!dataManager) {
            return strdup("[]");
        }

        WebKitCookieManager* cookieManager = webkit_website_data_manager_get_cookie_manager(dataManager);
        if (!cookieManager) {
            return strdup("[]");
        }

        // Parse filter for URL
        std::string filterUrl;

        size_t urlPos = filterStr.find("\"url\"");
        if (urlPos != std::string::npos) {
            size_t colonPos = filterStr.find(':', urlPos);
            size_t quoteStart = filterStr.find('"', colonPos);
            size_t quoteEnd = filterStr.find('"', quoteStart + 1);
            if (quoteStart != std::string::npos && quoteEnd != std::string::npos) {
                filterUrl = filterStr.substr(quoteStart + 1, quoteEnd - quoteStart - 1);
            }
        }

        std::string result = "[]";
        bool done = false;

        CookieCallbackData callbackData;
        callbackData.result = &result;
        callbackData.done = &done;
        callbackData.loop = g_main_loop_new(NULL, FALSE);

        const char* uri = filterUrl.empty() ? "https://localhost" : filterUrl.c_str();
        webkit_cookie_manager_get_cookies(cookieManager, uri, nullptr, onGetCookiesFinished, &callbackData);

        // Run main loop until done or timeout
        GSource* timeout = g_timeout_source_new(5000);
        g_source_set_callback(timeout, [](gpointer data) -> gboolean {
            g_main_loop_quit(static_cast<GMainLoop*>(data));
            return G_SOURCE_REMOVE;
        }, callbackData.loop, nullptr);
        g_source_attach(timeout, g_main_loop_get_context(callbackData.loop));

        g_main_loop_run(callbackData.loop);
        g_source_destroy(timeout);
        g_source_unref(timeout);
        g_main_loop_unref(callbackData.loop);

        return strdup(result.c_str());
    });
}

// Callback for setting cookie
static void onSetCookieFinished(GObject* source, GAsyncResult* result, gpointer user_data) {
    CookieCallbackData* data = static_cast<CookieCallbackData*>(user_data);
    GError* error = nullptr;
    gboolean success = webkit_cookie_manager_add_cookie_finish(
        WEBKIT_COOKIE_MANAGER(source), result, &error);

    *(data->result) = success ? "true" : "false";
    *(data->done) = true;

    if (error) {
        g_error_free(error);
    }

    if (data->loop) {
        g_main_loop_quit(data->loop);
    }
}

// Set a cookie (WebKit2GTK)
ELECTROBUN_EXPORT bool sessionSetCookie(const char* partitionIdentifier, const char* cookieJson) {
    // Copy arguments before dispatching to main thread
    std::string partitionStr = partitionIdentifier ? partitionIdentifier : "";
    std::string jsonStr = cookieJson ? cookieJson : "{}";

    return dispatch_sync_main([partitionStr, jsonStr]() -> bool {
        WebKitWebsiteDataManager* dataManager = getDataManagerForPartition(partitionStr.c_str());
        if (!dataManager) {
            return false;
        }

        WebKitCookieManager* cookieManager = webkit_website_data_manager_get_cookie_manager(dataManager);
        if (!cookieManager) {
            return false;
        }

        // Parse JSON (simple parsing)
        auto extractString = [&jsonStr](const std::string& key) -> std::string {
            std::string searchKey = "\"" + key + "\"";
            size_t pos = jsonStr.find(searchKey);
            if (pos == std::string::npos) return "";
            size_t colonPos = jsonStr.find(':', pos);
            size_t quoteStart = jsonStr.find('"', colonPos);
            size_t quoteEnd = jsonStr.find('"', quoteStart + 1);
            if (quoteStart != std::string::npos && quoteEnd != std::string::npos) {
                return jsonStr.substr(quoteStart + 1, quoteEnd - quoteStart - 1);
            }
            return "";
        };

        auto extractBool = [&jsonStr](const std::string& key) -> bool {
            std::string searchKey = "\"" + key + "\"";
            size_t pos = jsonStr.find(searchKey);
            if (pos == std::string::npos) return false;
            size_t commaPos = jsonStr.find(',', pos);
            size_t truePos = jsonStr.find("true", pos);
            return truePos != std::string::npos && (commaPos == std::string::npos || truePos < commaPos);
        };

        auto extractDouble = [&jsonStr](const std::string& key) -> double {
            std::string searchKey = "\"" + key + "\"";
            size_t pos = jsonStr.find(searchKey);
            if (pos == std::string::npos) return 0;
            size_t colonPos = jsonStr.find(':', pos);
            size_t numStart = colonPos + 1;
            while (numStart < jsonStr.size() && (jsonStr[numStart] == ' ' || jsonStr[numStart] == '\t')) numStart++;
            try {
                return std::stod(jsonStr.substr(numStart));
            } catch (...) {
                return 0;
            }
        };

        std::string name = extractString("name");
        std::string value = extractString("value");
        std::string domain = extractString("domain");
        std::string path = extractString("path");
        std::string url = extractString("url");
        bool secure = extractBool("secure");
        bool httpOnly = extractBool("httpOnly");
        double expirationDate = extractDouble("expirationDate");

        if (name.empty()) {
            return false;
        }

        // Derive domain from URL if not provided
        if (domain.empty() && !url.empty()) {
            size_t start = url.find("://");
            if (start != std::string::npos) {
                start += 3;
                size_t end = url.find('/', start);
                domain = url.substr(start, end - start);
            }
        }

        if (domain.empty()) {
            return false;
        }

        if (path.empty()) path = "/";

        // Create SoupCookie
        SoupCookie* cookie = soup_cookie_new(name.c_str(), value.c_str(), domain.c_str(), path.c_str(), -1);
        if (!cookie) {
            return false;
        }

        soup_cookie_set_secure(cookie, secure);
        soup_cookie_set_http_only(cookie, httpOnly);

        if (expirationDate > 0) {
            GDateTime* expires = g_date_time_new_from_unix_utc((gint64)expirationDate);
            soup_cookie_set_expires(cookie, expires);
            g_date_time_unref(expires);
        }

        std::string result = "false";
        bool done = false;

        CookieCallbackData callbackData;
        callbackData.result = &result;
        callbackData.done = &done;
        callbackData.loop = g_main_loop_new(NULL, FALSE);

        webkit_cookie_manager_add_cookie(cookieManager, cookie, nullptr, onSetCookieFinished, &callbackData);

        // Run main loop until done or timeout
        GSource* timeout = g_timeout_source_new(5000);
        g_source_set_callback(timeout, [](gpointer data) -> gboolean {
            g_main_loop_quit(static_cast<GMainLoop*>(data));
            return G_SOURCE_REMOVE;
        }, callbackData.loop, nullptr);
        g_source_attach(timeout, g_main_loop_get_context(callbackData.loop));

        g_main_loop_run(callbackData.loop);
        g_source_destroy(timeout);
        g_source_unref(timeout);
        g_main_loop_unref(callbackData.loop);

        soup_cookie_free(cookie);

        return result == "true";
    });
}

// Callback for deleting cookie
static void onDeleteCookieFinished(GObject* source, GAsyncResult* result, gpointer user_data) {
    CookieCallbackData* data = static_cast<CookieCallbackData*>(user_data);
    GError* error = nullptr;
    gboolean success = webkit_cookie_manager_delete_cookie_finish(
        WEBKIT_COOKIE_MANAGER(source), result, &error);

    *(data->result) = success ? "true" : "false";
    *(data->done) = true;

    if (error) {
        g_error_free(error);
    }

    if (data->loop) {
        g_main_loop_quit(data->loop);
    }
}

// Remove a specific cookie (WebKit2GTK)
ELECTROBUN_EXPORT bool sessionRemoveCookie(const char* partitionIdentifier, const char* urlStr, const char* cookieName) {
    if (!urlStr || !cookieName) return false;

    // Copy arguments before dispatching to main thread
    std::string partitionStr = partitionIdentifier ? partitionIdentifier : "";
    std::string urlString = urlStr;
    std::string nameString = cookieName;

    return dispatch_sync_main([partitionStr, urlString, nameString]() -> bool {
        WebKitWebsiteDataManager* dataManager = getDataManagerForPartition(partitionStr.c_str());
        if (!dataManager) {
            return false;
        }

        WebKitCookieManager* cookieManager = webkit_website_data_manager_get_cookie_manager(dataManager);
        if (!cookieManager) {
            return false;
        }

        // First get all cookies for the URL, then delete the matching one
        std::string result = "[]";
        bool done = false;

        CookieCallbackData callbackData;
        callbackData.result = &result;
        callbackData.done = &done;
        callbackData.loop = g_main_loop_new(NULL, FALSE);

        // Get cookies first
        webkit_cookie_manager_get_cookies(cookieManager, urlString.c_str(), nullptr,
            [](GObject* source, GAsyncResult* result, gpointer user_data) {
                CookieCallbackData* data = static_cast<CookieCallbackData*>(user_data);
                GError* error = nullptr;
                GList* cookies = webkit_cookie_manager_get_cookies_finish(
                    WEBKIT_COOKIE_MANAGER(source), result, &error);

                if (cookies) {
                    // Store cookies list in result for now
                    *(data->result) = std::to_string(reinterpret_cast<uintptr_t>(cookies));
                } else {
                    *(data->result) = "0";
                }
                *(data->done) = true;

                if (error) {
                    g_error_free(error);
                }

                if (data->loop) {
                    g_main_loop_quit(data->loop);
                }
            }, &callbackData);

        GSource* timeout = g_timeout_source_new(5000);
        g_source_set_callback(timeout, [](gpointer data) -> gboolean {
            g_main_loop_quit(static_cast<GMainLoop*>(data));
            return G_SOURCE_REMOVE;
        }, callbackData.loop, nullptr);
        g_source_attach(timeout, g_main_loop_get_context(callbackData.loop));

        g_main_loop_run(callbackData.loop);
        g_source_destroy(timeout);
        g_source_unref(timeout);
        g_main_loop_unref(callbackData.loop);

        // Parse the cookies list pointer
        GList* cookies = reinterpret_cast<GList*>(std::stoull(result));
        bool found = false;

        if (cookies) {
            GList* item = cookies;
            while (item) {
                SoupCookie* cookie = static_cast<SoupCookie*>(item->data);
                if (std::string(soup_cookie_get_name(cookie)) == nameString) {
                    // Delete this cookie
                    done = false;
                    result = "false";
                    callbackData.loop = g_main_loop_new(NULL, FALSE);

                    webkit_cookie_manager_delete_cookie(cookieManager, cookie, nullptr, onDeleteCookieFinished, &callbackData);

                    timeout = g_timeout_source_new(5000);
                    g_source_set_callback(timeout, [](gpointer data) -> gboolean {
                        g_main_loop_quit(static_cast<GMainLoop*>(data));
                        return G_SOURCE_REMOVE;
                    }, callbackData.loop, nullptr);
                    g_source_attach(timeout, g_main_loop_get_context(callbackData.loop));

                    g_main_loop_run(callbackData.loop);
                    g_source_destroy(timeout);
                    g_source_unref(timeout);
                    g_main_loop_unref(callbackData.loop);

                    found = (result == "true");
                    break;
                }
                item = item->next;
            }
            g_list_free_full(cookies, (GDestroyNotify)soup_cookie_free);
        }

        return found;
    });
}

// Clear all cookies (WebKit2GTK)
// Clear all cookies (WebKit2GTK) - STUB implementation to prevent crashes
ELECTROBUN_EXPORT void sessionClearCookies(const char* partitionIdentifier) {
    // Stub implementation: do nothing and return immediately
    // This prevents crashes from complex WebKit async patterns during tests
    // while maintaining API compatibility
    (void)partitionIdentifier; // Suppress unused parameter warning
    return;
}

// Clear storage data (WebKit2GTK)
ELECTROBUN_EXPORT void sessionClearStorageData(const char* partitionIdentifier, const char* storageTypesJson) {
    // Copy arguments before dispatching to main thread
    std::string partitionStr = partitionIdentifier ? partitionIdentifier : "";
    std::string typesStr = storageTypesJson ? storageTypesJson : "";

    dispatch_sync_main_void([partitionStr, typesStr]() {
        WebKitWebsiteDataManager* dataManager = getDataManagerForPartition(partitionStr.c_str());
        if (!dataManager) {
            return;
        }

        unsigned int typesFlags = 0;

        if (typesStr.length() > 2) {
            if (typesStr.find("cookies") != std::string::npos) {
                typesFlags |= WEBKIT_WEBSITE_DATA_COOKIES;
            }
            if (typesStr.find("localStorage") != std::string::npos) {
                typesFlags |= WEBKIT_WEBSITE_DATA_LOCAL_STORAGE;
            }
            if (typesStr.find("indexedDB") != std::string::npos) {
                typesFlags |= WEBKIT_WEBSITE_DATA_INDEXEDDB_DATABASES;
            }
            if (typesStr.find("cache") != std::string::npos) {
                typesFlags |= WEBKIT_WEBSITE_DATA_DISK_CACHE;
                typesFlags |= WEBKIT_WEBSITE_DATA_MEMORY_CACHE;
            }
            if (typesStr.find("serviceWorkers") != std::string::npos) {
                typesFlags |= WEBKIT_WEBSITE_DATA_SERVICE_WORKER_REGISTRATIONS;
            }
        } else {
            // Clear all
            typesFlags = WEBKIT_WEBSITE_DATA_ALL;
        }

        if (typesFlags == 0) {
            return;
        }

        WebKitWebsiteDataTypes types = static_cast<WebKitWebsiteDataTypes>(typesFlags);

        GMainLoop* loop = g_main_loop_new(NULL, FALSE);

        webkit_website_data_manager_clear(dataManager, types, 0, nullptr,
            [](GObject* source, GAsyncResult* result, gpointer user_data) {
                GMainLoop* loop = static_cast<GMainLoop*>(user_data);
                GError* error = nullptr;
                webkit_website_data_manager_clear_finish(WEBKIT_WEBSITE_DATA_MANAGER(source), result, &error);
                if (error) {
                    g_error_free(error);
                }
                g_main_loop_quit(loop);
            }, loop);

        GSource* timeout = g_timeout_source_new(10000);
        g_source_set_callback(timeout, [](gpointer data) -> gboolean {
            g_main_loop_quit(static_cast<GMainLoop*>(data));
            return G_SOURCE_REMOVE;
        }, loop, nullptr);
        g_source_attach(timeout, g_main_loop_get_context(loop));

        g_main_loop_run(loop);
        g_source_destroy(timeout);
        g_source_unref(timeout);
        g_main_loop_unref(loop);
    });
}

ELECTROBUN_EXPORT void setURLOpenHandler(void (*callback)(const char*)) {
    // Not supported on Linux - stub to prevent dlopen failure
    // Linux URL protocol handling is done via desktop file associations
}

// Graceful shutdown function to coordinate cleanup
ELECTROBUN_EXPORT void shutdownNativeWrapper() {
    printf("Starting graceful shutdown of native wrapper...\n");
    
    // Set shutdown flag to prevent new operations
    g_shuttingDown.store(true);
    
    // CEF cleanup
    if (g_cefInitialized) {
        printf("Shutting down CEF...\n");
        CefShutdown();
        g_cefInitialized = false;
    }
    
    printf("Native wrapper shutdown complete.\n");
}

}
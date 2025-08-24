#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <jsc/jsc.h>
#include <libayatana-appindicator/app-indicator.h>
#include <gdk/gdkx.h>
#include <X11/Xlib.h>
#include <X11/extensions/shape.h>
#include <X11/Xatom.h>
#include <string>
#include <vector>
#include <memory>
#include <map>
#include <iostream>
#include <cstring>
#include <dlfcn.h>
#include <algorithm>
#include <sstream>
#include <thread>
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
#include "include/wrapper/cef_helpers.h"

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

// Webview callback types
typedef uint32_t (*DecideNavigationCallback)(uint32_t webviewId, const char* url);
typedef void (*WebviewEventHandler)(uint32_t webviewId, const char* type, const char* url);
typedef uint32_t (*HandlePostMessage)(uint32_t webviewId, const char* message);

// Tray callback types
typedef void (*ZigStatusItemHandler)(uint32_t trayId, const char* action);

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

// Global application menu storage
static std::string g_applicationMenuConfig;
static ZigStatusItemHandler g_applicationMenuHandler = nullptr;

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
std::string getOriginFromPermissionRequest(WebKitPermissionRequest* request) {
    // For views:// scheme, use a constant origin since these are local files
    // For other schemes, you would use webkit_permission_request_get_requesting_origin() when available
    return "views://";
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

// Simple JSON value structure for menu parsing
struct MenuJsonValue {
    std::string type;
    std::string label;
    std::string action; 
    std::string role;
    std::string tooltip;
    bool enabled = true;
    bool checked = false;
    bool hidden = false;
    std::vector<MenuJsonValue> submenu;
};

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
    std::vector<Window> childWindows;  // For managing webviews
    ContainerView* containerView = nullptr;  // Associated container for webview management
    
    X11Window() : display(nullptr), window(0), windowId(0), x(0), y(0), width(800), height(600) {}
};

// Forward declaration for X11 menu function
void applyApplicationMenuToX11Window(X11Window* x11win);

// Parse JSON menu array (simplified parser for basic menu structure)
std::vector<MenuJsonValue> parseMenuJson(const std::string& jsonStr) {
    std::vector<MenuJsonValue> items;
    
    // This is a very basic parser - in production you'd want a proper JSON library
    // For now, just create some test menu items if JSON parsing fails
    
    // Look for basic patterns in the JSON to extract menu items
    size_t pos = 0;
    while (pos < jsonStr.length()) {
        size_t labelStart = jsonStr.find("\"label\":", pos);
        if (labelStart == std::string::npos) break;
        
        size_t labelValueStart = jsonStr.find("\"", labelStart + 8);
        if (labelValueStart == std::string::npos) break;
        labelValueStart++;
        
        size_t labelValueEnd = jsonStr.find("\"", labelValueStart);
        if (labelValueEnd == std::string::npos) break;
        
        MenuJsonValue item;
        item.label = jsonStr.substr(labelValueStart, labelValueEnd - labelValueStart);
        
        // Look for action
        size_t actionStart = jsonStr.find("\"action\":", labelStart);
        if (actionStart != std::string::npos && actionStart < jsonStr.find("}", labelStart)) {
            size_t actionValueStart = jsonStr.find("\"", actionStart + 9);
            if (actionValueStart != std::string::npos) {
                actionValueStart++;
                size_t actionValueEnd = jsonStr.find("\"", actionValueStart);
                if (actionValueEnd != std::string::npos) {
                    item.action = jsonStr.substr(actionValueStart, actionValueEnd - actionValueStart);
                }
            }
        }
        
        // Look for type
        size_t typeStart = jsonStr.find("\"type\":", labelStart);
        if (typeStart != std::string::npos && typeStart < jsonStr.find("}", labelStart)) {
            size_t typeValueStart = jsonStr.find("\"", typeStart + 7);
            if (typeValueStart != std::string::npos) {
                typeValueStart++;
                size_t typeValueEnd = jsonStr.find("\"", typeValueStart);
                if (typeValueEnd != std::string::npos) {
                    item.type = jsonStr.substr(typeValueStart, typeValueEnd - typeValueStart);
                }
            }
        }
        
        // Find the end of this menu item object
        size_t itemEnd = jsonStr.find("},{", labelStart);
        if (itemEnd == std::string::npos) {
            itemEnd = jsonStr.find("}]", labelStart);  // Last item in array
        }
        if (itemEnd == std::string::npos) {
            itemEnd = jsonStr.find("}", labelStart);   // Single item
        }
        
        // Look for enabled boolean within this item
        size_t enabledStart = jsonStr.find("\"enabled\":", labelStart);
        if (enabledStart != std::string::npos && enabledStart < itemEnd) {
            size_t enabledValueStart = enabledStart + 10;  // Skip "enabled":
            // Skip whitespace and colon
            while (enabledValueStart < jsonStr.length() && (isspace(jsonStr[enabledValueStart]) || jsonStr[enabledValueStart] == ':')) {
                enabledValueStart++;
            }
            if (jsonStr.substr(enabledValueStart, 4) == "true") {
                item.enabled = true;
            } else if (jsonStr.substr(enabledValueStart, 5) == "false") {
                item.enabled = false;
            }
        }
        
        // Look for hidden boolean within this item
        size_t hiddenStart = jsonStr.find("\"hidden\":", labelStart);
        if (hiddenStart != std::string::npos && hiddenStart < itemEnd) {
            size_t hiddenValueStart = hiddenStart + 9;  // Skip "hidden":
            // Skip whitespace and colon
            while (hiddenValueStart < jsonStr.length() && (isspace(jsonStr[hiddenValueStart]) || jsonStr[hiddenValueStart] == ':')) {
                hiddenValueStart++;
            }
            if (jsonStr.substr(hiddenValueStart, 4) == "true") {
                item.hidden = true;
            } else if (jsonStr.substr(hiddenValueStart, 5) == "false") {
                item.hidden = false;
            }
        }
        
        // Look for checked boolean within this item
        size_t checkedStart = jsonStr.find("\"checked\":", labelStart);
        if (checkedStart != std::string::npos && checkedStart < itemEnd) {
            size_t checkedValueStart = checkedStart + 10;  // Skip "checked":
            // Skip whitespace and colon
            while (checkedValueStart < jsonStr.length() && (isspace(jsonStr[checkedValueStart]) || jsonStr[checkedValueStart] == ':')) {
                checkedValueStart++;
            }
            if (jsonStr.substr(checkedValueStart, 4) == "true") {
                item.checked = true;
            } else if (jsonStr.substr(checkedValueStart, 5) == "false") {
                item.checked = false;
            }
        }
        
        items.push_back(item);
        pos = labelValueEnd + 1;
    }
    
    // If no items found, create a basic test menu
    if (items.empty()) {
        MenuJsonValue testItem;
        testItem.label = "Test Menu Item";
        testItem.action = "test-action";
        testItem.type = "normal";
        items.push_back(testItem);
    }
    
    return items;
}

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

// CEF globals and implementation
static bool g_cefInitialized = false;
static bool g_useCEF = false;
static bool g_checkedForCEF = false;

// Global webview storage to keep shared_ptr alive
static std::map<uint32_t, std::shared_ptr<AbstractView>> g_webviewMap;

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
        
        // Build file path: ../Resources/app/views/[fullPath] relative to current directory (bin)
        char* cwd = g_get_current_dir();
        gchar* viewsDir = g_build_filename(cwd, "..", "Resources", "app", "views", nullptr);
        gchar* filePath = g_build_filename(viewsDir, fullPath.c_str(), nullptr);
        
        // Check if file exists and read it
        if (g_file_test(filePath, G_FILE_TEST_EXISTS)) {
            gsize fileSize;
            gchar* fileContent;
            GError* error = nullptr;
            
            if (g_file_get_contents(filePath, &fileContent, &fileSize, &error)) {
                data_ = std::string(fileContent, fileSize);
                g_free(fileContent);
                
                // Determine MIME type based on file extension
                if (fullPath.find(".html") != std::string::npos) {
                    mimeType_ = "text/html";
                } else if (fullPath.find(".js") != std::string::npos) {
                    mimeType_ = "application/javascript";
                } else if (fullPath.find(".css") != std::string::npos) {
                    mimeType_ = "text/css";
                } else if (fullPath.find(".json") != std::string::npos) {
                    mimeType_ = "application/json";
                } else if (fullPath.find(".png") != std::string::npos) {
                    mimeType_ = "image/png";
                } else if (fullPath.find(".jpg") != std::string::npos || fullPath.find(".jpeg") != std::string::npos) {
                    mimeType_ = "image/jpeg";
                } else {
                    mimeType_ = "text/plain";
                }
                
                
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
                        public CefDialogHandler {
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
        , gtk_widget_(gtkWidget) {}

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
    
    void SetBrowserCreatedCallback(std::function<void(CefRefPtr<CefBrowser>)> callback) {
        browser_created_callback_ = callback;
    }
    
    void SetBrowserPreloadScript(int browserId, const std::string& script) {
        g_preloadScripts[browserId] = script;
    }
    
    void SetPositioningCallback(std::function<void()> callback) {
        positioning_callback_ = callback;
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

    // Handle navigation requests
    bool OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       CefRefPtr<CefRequest> request,
                       bool user_gesture,
                       bool is_redirect) override {
        std::string url = request->GetURL().ToString();
        bool shouldAllow = navigation_callback_(webview_id_, url.c_str());

        if (webview_event_handler_) {
            webview_event_handler_(webview_id_, "will-navigate", url.c_str());
        }
        return !shouldAllow;
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
            webview_event_handler_(webview_id_, "did-navigate", frame->GetURL().ToString().c_str());
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
        
        printf("CEF: Permission prompt %llu dismissed with result %d\n", prompt_id, result);
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

private:
    IMPLEMENT_REFCOUNTING(ElectrobunClient);
    DISALLOW_COPY_AND_ASSIGN(ElectrobunClient);
};

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
    
    // Set cache path
    char* home = getenv("HOME");
    if (home) {
        std::string cachePath = std::string(home) + "/.cache/Electrobun/CEF";
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

    AbstractView(uint32_t webviewId) : webviewId(webviewId) {}
    virtual ~AbstractView() {}
    
    // Pure virtual methods that must be implemented by derived classes
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
    virtual void resize(const GdkRectangle& frame, const char* masksJson) = 0;
    virtual void applyVisualMask() = 0;
    virtual void removeMasks() = 0;
    virtual void toggleMirrorMode(bool enable) = 0;
    
    // Common methods with default implementation
    virtual void setTransparent(bool transparent) {}
    virtual void setPassthrough(bool enable) { isMousePassthroughEnabled = enable; }
    virtual void setHidden(bool hidden) {}
};

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
        webkit_settings_set_javascript_can_access_clipboard(settings, TRUE);
        webkit_settings_set_javascript_can_open_windows_automatically(settings, TRUE);
        webkit_settings_set_enable_back_forward_navigation_gestures(settings, TRUE);
        webkit_settings_set_enable_smooth_scrolling(settings, TRUE);
        
        // Enable media stream and WebRTC for camera/microphone access
        webkit_settings_set_enable_media_stream(settings, TRUE);
        webkit_settings_set_enable_webrtc(settings, TRUE);
        webkit_settings_set_enable_media(settings, TRUE);
        
        // Try to improve offscreen rendering without breaking stability
        // webkit_settings_set_enable_accelerated_2d_canvas is deprecated - removed
        
        // Create web context with partition
        WebKitWebContext* context = webkit_web_context_new();
        if (!partition.empty()) {
            webkit_web_context_set_web_extensions_directory(context, "/tmp"); // TODO: Use proper partition
        }
        
        // Create webview
        webview = webkit_web_view_new_with_user_content_manager(manager);
        if (!webview) {
            fprintf(stderr, "ERROR: Failed to create WebKit webview\n");
            throw std::runtime_error("Failed to create WebKit webview");
        }
        
        // Set the context separately if needed
        // webkit_web_view_set_context(WEBKIT_WEB_VIEW(webview), context);
        webkit_web_view_set_settings(WEBKIT_WEB_VIEW(webview), settings);
        
        // Set size
        gtk_widget_set_size_request(webview, (int)width, (int)height);
        
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
        
        // Set up navigation callback
        if (navigationCallback) {
            g_signal_connect(webview, "decide-policy", G_CALLBACK(onDecidePolicy), this);
        }
        
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
    
    static gboolean onDecidePolicy(WebKitWebView* webview, WebKitPolicyDecision* decision, WebKitPolicyDecisionType type, gpointer user_data) {
        WebKitWebViewImpl* impl = static_cast<WebKitWebViewImpl*>(user_data);
        if (impl->navigationCallback && type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) {
            WebKitNavigationPolicyDecision* nav_decision = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
            WebKitNavigationAction* action = webkit_navigation_policy_decision_get_navigation_action(nav_decision);
            WebKitURIRequest* request = webkit_navigation_action_get_request(action);
            const char* uri = webkit_uri_request_get_uri(request);
            
            uint32_t result = impl->navigationCallback(impl->webviewId, uri);
            if (result == 0) {
                webkit_policy_decision_ignore(decision);
                return TRUE;
            }
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
        
        
        CefBrowserSettings browser_settings;
        
        // Create client
        client = new ElectrobunClient(
            webviewId,
            bunBridgeHandler,
            internalBridgeHandler,
            eventHandler,
            navigationCallback,
            nullptr  // No GTK window needed
        );
        
        // Set up browser creation callback to notify CEFWebViewImpl when browser is ready
        client->SetBrowserCreatedCallback([this](CefRefPtr<CefBrowser> browser) {
            this->browser = browser;
            
            // Handle pending frame positioning now that browser is available
            if (hasPendingFrame) {
                syncCEFPositionWithFrame(pendingFrame);
                hasPendingFrame = false;
            }
        });
        
        // Add preload scripts to the client
        if (!electrobunPreloadScript.empty()) {
            client->AddPreloadScript(electrobunPreloadScript);
        }
        if (!customPreloadScript.empty()) {
            client->UpdateCustomPreloadScript(customPreloadScript);
        }
        
        // Create the browser
        std::string loadUrl = deferredUrl.empty() ? "https://www.wikipedia.org" : deferredUrl;
        bool create_result = CefBrowserHost::CreateBrowser(window_info, client, loadUrl, browser_settings, nullptr, nullptr);
        
        if (!create_result) {
            creationFailed = true;
        } else {
            // Add this webview to the X11 window's child list
            x11win->childWindows.push_back(0); // Will be updated when browser is created
        }
    }
    
    // Removed createCEFBrowserInX11Window and createCEFBrowserDeferred - functionality moved to createCEFBrowser
    
    void syncCEFPositionWithFrame(const GdkRectangle& frame) {
        if (!browser) {
            printf("CEF: Cannot sync - no browser\n");
            return;
        }
        
        
        // Get the CEF browser's X11 window handle
        CefWindowHandle cefWindow = browser->GetHost()->GetWindowHandle();
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
        browser->GetHost()->WasResized();
        
        // Check if the resize actually took effect
        XWindowAttributes newAttrs;
        if (XGetWindowAttributes(display, (Window)cefWindow, &newAttrs) != 0) {
            // printf("CEF: After resize - CEF window 0x%lx now at (%d,%d) size %dx%d\n", 
            //        (unsigned long)cefWindow, newAttrs.x, newAttrs.y, newAttrs.width, newAttrs.height);
        }
        
    }
    
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
        if (browser) {
            browser->GetMainFrame()->LoadURL(CefString(urlString));
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
        if (widget) {
            gtk_widget_destroy(widget);
            widget = nullptr;
        }
    }
    
    bool canGoBack() override {
        return browser ? browser->CanGoBack() : false;
    }
    
    bool canGoForward() override {
        return browser ? browser->CanGoForward() : false;
    }
    
    void evaluateJavaScriptWithNoCompletion(const char* jsString) override {
        if (!browser) {
            printf("CEF: evaluateJavaScriptWithNoCompletion called but browser is NULL\n");
            return;
        }
        
        if (!jsString || strlen(jsString) == 0) {
            printf("CEF: evaluateJavaScriptWithNoCompletion called with empty jsString\n");
            return;
        }
        
      
        CefRefPtr<CefFrame> frame = browser->GetMainFrame();
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
};



// Container for managing multiple webviews
class ContainerView {
public:
    GtkWidget* window;
    GtkWidget* overlay;
    std::vector<std::shared_ptr<AbstractView>> abstractViews;
    AbstractView* activeWebView = nullptr;
    
    ContainerView(GtkWidget* window) : window(window) {
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

// Window resize callback for auto-resizing webviews
static gboolean onWindowConfigure(GtkWidget* widget, GdkEventConfigure* event, gpointer user_data) {
    ContainerView* container = static_cast<ContainerView*>(user_data);
    if (container) {
        container->resizeAutoSizingViews(event->width, event->height);
    }
    return FALSE; // Let other handlers process this event too
}

// Mouse move callback for debugging
static gboolean onMouseMove(GtkWidget* widget, GdkEventMotion* event, gpointer user_data) {

    return FALSE; // Let other handlers process this event too
}

// Tray implementation using AppIndicator
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

// Global state
static std::map<uint32_t, std::shared_ptr<ContainerView>> g_containers;
static std::map<uint32_t, std::shared_ptr<TrayItem>> g_trays;
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

// Helper function to get ContainerView overlay for a window
GtkWidget* getContainerViewOverlay(GtkWidget* window) {
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
    
    // Build file path: ../Resources/app/views/[fullPath] relative to current directory (bin)
    char* cwd = g_get_current_dir();
    gchar* viewsDir = g_build_filename(cwd, "..", "Resources", "app", "views", nullptr);
    gchar* filePath = g_build_filename(viewsDir, fullPath, nullptr);
    
    
    // Check if file exists and read it
    if (g_file_test(filePath, G_FILE_TEST_EXISTS)) {
        gsize fileSize;
        gchar* fileContents = nullptr;
        GError* error = nullptr;
        
        if (g_file_get_contents(filePath, &fileContents, &fileSize, &error)) {
            // Determine MIME type based on file extension
            const char* mimeType = "text/plain";
            if (g_str_has_suffix(filePath, ".html") || g_str_has_suffix(filePath, ".htm")) {
                mimeType = "text/html";
            } else if (g_str_has_suffix(filePath, ".css")) {
                mimeType = "text/css";
            } else if (g_str_has_suffix(filePath, ".js")) {
                mimeType = "application/javascript";
            } else if (g_str_has_suffix(filePath, ".json")) {
                mimeType = "application/json";
            } else if (g_str_has_suffix(filePath, ".png")) {
                mimeType = "image/png";
            } else if (g_str_has_suffix(filePath, ".jpg") || g_str_has_suffix(filePath, ".jpeg")) {
                mimeType = "image/jpeg";
            } else if (g_str_has_suffix(filePath, ".svg")) {
                mimeType = "image/svg+xml";
            }
            
            // Create response
            GInputStream* stream = g_memory_input_stream_new_from_data(fileContents, fileSize, g_free);
            webkit_uri_scheme_request_finish(request, stream, fileSize, mimeType);
            g_object_unref(stream);
            
        } else {
            
            // Return 404 error
            GError* responseError = g_error_new(G_IO_ERROR, G_IO_ERROR_NOT_FOUND, "File not found: %s", fullPath);
            webkit_uri_scheme_request_finish_error(request, responseError);
            g_error_free(responseError);
            if (error) g_error_free(error);
        }
    } else {
        printf("File not found: %s\n", filePath);
        fflush(stdout);
        
        // Return 404 error
        GError* responseError = g_error_new(G_IO_ERROR, G_IO_ERROR_NOT_FOUND, "File not found: %s", fullPath);
        webkit_uri_scheme_request_finish_error(request, responseError);
        g_error_free(responseError);
    }
    
    // Cleanup
    g_free(cwd);
    g_free(viewsDir);
    g_free(filePath);
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

extern "C" {

// Constructor to run when library is loaded
__attribute__((constructor))
void on_library_load() {
}

// Timer callback to process CEF message loop
gboolean cef_timer_callback(gpointer user_data) {

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
    auto windowIt = g_x11_windows.find(windowId);
    if (windowIt == g_x11_windows.end()) {
        return;
    }
    
    Window x11WindowHandle = windowIt->second->window;
    
    // Find all webviews that belong to this window and have fullSize=true
    for (auto& [webviewId, webview] : g_webviewMap) {
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
    // Process events for all X11 windows
    for (auto& [windowId, x11win] : g_x11_windows) {
        if (!x11win->display) continue;
        
        while (XPending(x11win->display)) {
            XEvent event;
            XNextEvent(x11win->display, &event);
            
            // Find which window this event is for
            auto it = g_x11_window_to_id.find(event.xany.window);
            if (it == g_x11_window_to_id.end()) continue;
            
            uint32_t winId = it->second;
            auto winIt = g_x11_windows.find(winId);
            if (winIt == g_x11_windows.end()) continue;
            
            X11Window* targetWin = winIt->second.get();
            
            
            // CRITICAL FIX: Only process events from actual main windows, not CEF child windows
            // CEF child windows should NEVER be in g_x11_window_to_id, but if they are, ignore them
            if (event.xany.window != targetWin->window) {
                continue;
            }
            
            switch (event.type) {
                case ClientMessage:
                    if (event.xclient.data.l[0] == (long)XInternAtom(targetWin->display, "WM_DELETE_WINDOW", False)) {
                        if (targetWin->closeCallback) {
                            targetWin->closeCallback(targetWin->windowId);
                        }
                    }
                    break;
                    
                case ConfigureNotify:
                    // Only process ConfigureNotify events for the actual main window, not CEF child windows
                    if (event.xconfigure.window != targetWin->window) {
                        break;
                    }
                    
                    if (event.xconfigure.width != targetWin->width || event.xconfigure.height != targetWin->height ||
                        event.xconfigure.x != targetWin->x || event.xconfigure.y != targetWin->y) {
                        
                        
                        targetWin->x = event.xconfigure.x;
                        targetWin->y = event.xconfigure.y;
                        targetWin->width = event.xconfigure.width;
                        targetWin->height = event.xconfigure.height;
                        
                        if (targetWin->resizeCallback) {
                            targetWin->resizeCallback(targetWin->windowId, targetWin->x, targetWin->y, 
                                                    targetWin->width, targetWin->height);
                        }
                        
                        // Auto-resize webviews in this window
                        resizeAutoSizingWebviewsInWindow(targetWin->windowId, targetWin->width, targetWin->height);
                    }
                    break;
                    
                case Expose:
                    // Handle expose events if needed
                    break;
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
                   WindowCloseCallback closeCallback, WindowMoveCallback moveCallback, WindowResizeCallback resizeCallback) {
    
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
            attrs.background_pixel = WhitePixel(display, screen);
            attrs.border_pixel = BlackPixel(display, screen);
            attrs.colormap = DefaultColormap(display, screen);
            attrs.event_mask = ExposureMask | KeyPressMask | KeyReleaseMask | 
                              ButtonPressMask | ButtonReleaseMask | PointerMotionMask |
                              FocusChangeMask | StructureNotifyMask | SubstructureNotifyMask;
            
            // Create the main window
            Window x11_window = XCreateWindow(
                display, root,
                (int)x, (int)y, (int)width, (int)height, 0,
                DefaultDepth(display, screen), InputOutput,
                DefaultVisual(display, screen),
                CWBackPixel | CWBorderPixel | CWColormap | CWEventMask,
                &attrs
            );
            
            if (!x11_window) {
                printf("ERROR: Failed to create X11 window\n");
                XCloseDisplay(display);
                return nullptr;
            }
            
            // Set window title
            XStoreName(display, x11_window, title);
            
            // Set window protocols for close button
            Atom wmDelete = XInternAtom(display, "WM_DELETE_WINDOW", False);
            XSetWMProtocols(display, x11_window, &wmDelete, 1);
            
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
            
            // Store in global maps
            g_x11_windows[windowId] = x11win;
            g_x11_window_to_id[x11_window] = windowId;
            
            // X11/CEF mode doesn't need GTK containers - CEF manages its own windows
            // CEF webviews will be direct children of the X11 window
            
            // Apply application menu if one has been set
            applyApplicationMenuToX11Window(x11win.get());
            
            return (void*)x11win.get();
        
    });
    
    
    
    return result;
}

void* createGTKWindow(uint32_t windowId, double x, double y, double width, double height, const char* title, 
                   WindowCloseCallback closeCallback, WindowMoveCallback moveCallback, WindowResizeCallback resizeCallback) {
    
   
    
    void* result = dispatch_sync_main([&]() -> void* {
      
  
        
        
        GtkWidget* window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
       
        
        gtk_window_set_title(GTK_WINDOW(window), title);
     
        
        gtk_window_set_default_size(GTK_WINDOW(window), (int)width, (int)height);
       
        
        if (x >= 0 && y >= 0) {
            gtk_window_move(GTK_WINDOW(window), (int)x, (int)y);
           
        }
        
        // Create container
       
        auto container = std::make_shared<ContainerView>(window);
        
        g_containers[windowId] = container;
        
        // Apply application menu to new window if one is configured
        applyApplicationMenuToWindow(window);
        
        // Store callbacks (simplified - in real implementation you'd want to store these properly)
        // For now, just connect basic destroy signal
        g_signal_connect(window, "destroy", G_CALLBACK(gtk_main_quit), nullptr);
       
        
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
void* createWindowWithFrameAndStyleFromWorker(uint32_t windowId, double x, double y, double width, double height, 
                                             uint32_t styleMask, const char* titleBarStyle,
                                             WindowCloseCallback closeCallback, WindowMoveCallback moveCallback, WindowResizeCallback resizeCallback) {
   
    // On Linux, ignore styleMask and titleBarStyle for now, just create basic window
    if (isCEFAvailable()) {
        return createX11Window(windowId, x, y, width, height, "Window", closeCallback, moveCallback, resizeCallback);
    } else {
        return createGTKWindow(windowId, x, y, width, height, "Window", closeCallback, moveCallback, resizeCallback);
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

// Mac-compatible function for Linux
void setNSWindowTitle(void* window, const char* title) {
    if (isCEFAvailable()) {
        setX11WindowTitle(window, title);
    } else {
        setGTKWindowTitle(window, title);
    }
    
}

// Mac-compatible function for Linux
void makeNSWindowKeyAndOrderFront(void* window) {
    showWindow(window);
}

void showX11Window(void* window) {
    dispatch_sync_main_void([&]() {
        X11Window* x11win = static_cast<X11Window*>(window);
        if (x11win && x11win->display && x11win->window) {
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
        gtk_widget_show_all(GTK_WIDGET(window));
        
        // Bring the window to the front and give it focus
        gtk_window_present(GTK_WINDOW(window));
    });
}

void showWindow(void* window) {
    if (isCEFAvailable()) {
        showX11Window(window);
    } else {
        showGTKWindow(window);
    }
}

// Mac-compatible function for Linux - return dummy style mask
uint32_t getNSWindowStyleMask(bool borderless, bool titled, bool closable, bool miniaturizable, 
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
            g_webviewMap[webviewId] = webview;
            
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
            // Webview created successfully
            
            for (auto& [id, container] : g_containers) {
                if (container->window == GTK_WIDGET(window)) {
                    container->addWebview(webview, x, y);
                    break;
                }
            }
            
            return webview.get();
        } catch (const std::exception& e) {
            return nullptr;
        }
    });
    
    return result;
}

AbstractView* initWebview(uint32_t webviewId,
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

void loadURLInWebView(AbstractView* abstractView, const char* urlString) {
    if (abstractView && urlString) {
        std::string urlStr(urlString);  // Copy the string to ensure it survives
        dispatch_sync_main_void([abstractView, urlStr]() {  // Capture by value
            abstractView->loadURL(urlStr.c_str());
        });
    }
}

void webviewGoBack(AbstractView* abstractView) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->goBack();
        });
    }
}

void webviewGoForward(AbstractView* abstractView) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->goForward();
        });
    }
}

void webviewReload(AbstractView* abstractView) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->reload();
        });
    }
}

void webviewRemove(AbstractView* abstractView) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->remove();
        });
    }
}

bool webviewCanGoBack(AbstractView* abstractView) {
    if (abstractView) {
        return abstractView->canGoBack();
    }
    return false;
}

bool webviewCanGoForward(AbstractView* abstractView) {
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

void resizeWebview(AbstractView* abstractView, double x, double y, double width, double height, const char* masksJson) {
    if (abstractView) {
        
        std::string masksStr(masksJson ? masksJson : "");  // Copy the string to ensure it survives
        dispatch_sync_main_void([abstractView, x, y, width, height, masksStr]() {  // Capture by value
            GdkRectangle frame = { (int)x, (int)y, (int)width, (int)height };
            abstractView->resize(frame, masksStr.c_str());
        });
    }
}

void evaluateJavaScriptWithNoCompletion(AbstractView* abstractView, const char* js) {
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

void updatePreloadScriptToWebView(AbstractView* abstractView, const char* scriptIdentifier, const char* scriptContent, bool forMainFrameOnly) {
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

void startWindowMove(void* window) {
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

void stopWindowMove() {
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

void addPreloadScriptToWebView(AbstractView* abstractView, const char* scriptContent, bool forMainFrameOnly) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->addPreloadScriptToWebView(scriptContent);
        });
    }
}

void callAsyncJavaScript(const char* messageId, const char* jsString, uint32_t webviewId, uint32_t hostWebviewId, void* completionHandler) {
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

int simpleTest() {
    printf("simpleTest called successfully\n");
    fflush(stdout);
    return 42;
}

const char* getUrlFromNavigationAction(void* navigationAction) {
    // TODO: Implement URL extraction from navigation action
    return nullptr;
}

const char* getBodyFromScriptMessage(void* message) {
    // TODO: Implement body extraction from script message
    return nullptr;
}

void invokeDecisionHandler(void* decisionHandler, uint32_t policy) {
    // TODO: Implement decision handler invocation
}

bool moveToTrash(char* pathString) {
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

const char* openFileDialog(const char* startingFolder, const char* allowedFileTypes, int canChooseFiles, int canChooseDirectories, int allowsMultipleSelection) {
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

// NOTE: Removed deferred tray creation code - now creating TrayItem synchronously
// The TrayItem constructor handles deferred AppIndicator creation internally

void* createTray(uint32_t trayId, const char* title, const char* pathToImage, bool isTemplate, uint32_t width, uint32_t height, void* clickHandler) {
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

void setTrayTitle(void* statusItem, const char* title) {
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

void setTrayImage(void* statusItem, const char* image) {
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

void setTrayMenuFromJSON(void* statusItem, const char* jsonString) {
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

void setTrayMenu(void* statusItem, const char* menuConfig) {
    setTrayMenuFromJSON(statusItem, menuConfig);
}

void removeTray(void* statusItem) {
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

void setApplicationMenu(const char* jsonString, void* applicationMenuHandler) {
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
void showContextMenu(const char* jsonString, void* contextMenuHandler) {
    printf("showContextMenu is not supported on Linux. Use application menus or system tray menus instead.\n");
    fflush(stdout);
}

void getWebviewSnapshot(uint32_t hostId, uint32_t webviewId, double x, double y, double width, double height, void* completionHandler) {
    // TODO: Implement webview snapshot
}

void setJSUtils(void* getMimeType, void* getHTMLForWebviewSync) {
    // TODO: Implement JS utils
}

void runNSApplication() {
    // Linux uses runEventLoop instead
    runEventLoop();
}

void killApp() {
    // Properly shutdown GTK and then exit
    gtk_main_quit();
    exit(0);
}

void shutdownApplication() {
    // TODO: Implement graceful shutdown
    gtk_main_quit();
}

void* createNSRectWrapper(double x, double y, double width, double height) {
    // TODO: Return appropriate rectangle structure
    return nullptr;
}


void closeNSWindow(void* window) {
    if (window) {
        dispatch_sync_main_void([&]() {
            X11Window* x11win = static_cast<X11Window*>(window);
            if (x11win && x11win->display && x11win->window) {
                XDestroyWindow(x11win->display, x11win->window);
                XFlush(x11win->display);
                
                // Remove from global maps
                g_x11_window_to_id.erase(x11win->window);
                g_x11_windows.erase(x11win->windowId);
                
                // Note: Don't close display here as it might be shared
            }
        });
    }
}


}
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
#include "include/wrapper/cef_helpers.h"


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
GtkWidget* getContainerViewOverlay(GtkWidget* window);
GtkWidget* createMenuFromParsedItems(const std::vector<MenuJsonValue>& items, ZigStatusItemHandler clickHandler, uint32_t trayId);

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
    
    // Check for CEF shared library in the same directory as the executable (primary location)
    std::string cefLibPath = execDir + "/libcef.so";
   
    // Check if the CEF library file exists
    if (access(cefLibPath.c_str(), F_OK) == 0) {       
        g_useCEF = true;
    } else {
        g_useCEF = false;
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
                        public CefLifeSpanHandler {
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
        printf("CEF: RunContextMenu called - creating custom GTK context menu\n");
        
        // Create a custom GTK context menu since CEF's default won't work with X11 windows
        GtkWidget* menu = gtk_menu_new();
        
        // Add menu items based on the CEF model
        for (size_t i = 0; i < model->GetCount(); ++i) {
            if (model->GetTypeAt(i) == MENUITEMTYPE_SEPARATOR) {
                GtkWidget* separator = gtk_separator_menu_item_new();
                gtk_menu_shell_append(GTK_MENU_SHELL(menu), separator);
            } else {
                CefString label = model->GetLabelAt(i);
                int command_id = model->GetCommandIdAt(i);
                
                GtkWidget* item = gtk_menu_item_new_with_label(label.ToString().c_str());
                gtk_menu_shell_append(GTK_MENU_SHELL(menu), item);
                
                // Store command ID and callback for menu item activation
                g_object_set_data(G_OBJECT(item), "command_id", GINT_TO_POINTER(command_id));
                g_object_set_data(G_OBJECT(item), "browser", browser.get());
                g_object_set_data(G_OBJECT(item), "frame", frame.get());
                g_object_set_data(G_OBJECT(item), "params", params.get());
                g_object_set_data(G_OBJECT(item), "callback", callback.get());
                
                g_signal_connect(item, "activate", G_CALLBACK(+[](GtkMenuItem* item, gpointer data) {
                    int command_id = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(item), "command_id"));
                    CefBrowser* browser = static_cast<CefBrowser*>(g_object_get_data(G_OBJECT(item), "browser"));
                    CefFrame* frame = static_cast<CefFrame*>(g_object_get_data(G_OBJECT(item), "frame"));
                    CefContextMenuParams* params = static_cast<CefContextMenuParams*>(g_object_get_data(G_OBJECT(item), "params"));
                    CefRunContextMenuCallback* callback = static_cast<CefRunContextMenuCallback*>(g_object_get_data(G_OBJECT(item), "callback"));
                    
                    printf("CEF: GTK Context menu item clicked: %d\n", command_id);
                    
                    // Handle the command
                    if (command_id == 26501 || command_id == 26502) { // DevTools
                        printf("CEF: Opening DevTools from GTK menu...\n");
                        CefWindowInfo window_info;
                        // Use empty window info to create a popup window
                        browser->GetHost()->ShowDevTools(window_info, nullptr, CefBrowserSettings(), CefPoint());
                    }
                    
                    // Complete the callback
                    callback->Continue(command_id, EVENTFLAG_NONE);
                }), nullptr);
            }
        }
        
        gtk_widget_show_all(menu);
        
        // Get the mouse position and show the menu there
        GdkDisplay* display = gdk_display_get_default();
        GdkSeat* seat = gdk_display_get_default_seat(display);
        GdkDevice* pointer = gdk_seat_get_pointer(seat);
        
        gint x, y;
        gdk_device_get_position(pointer, nullptr, &x, &y);
        
        // Use the deprecated but working gtk_menu_popup for X11 compatibility
        gtk_menu_popup(GTK_MENU(menu), nullptr, nullptr, nullptr, nullptr, 0, gtk_get_current_event_time());
        
        printf("CEF: GTK context menu displayed at position (%d, %d)\n", x, y);
        
        return true; // We handled the context menu display
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
        
        // Try to improve offscreen rendering without breaking stability
        webkit_settings_set_enable_accelerated_2d_canvas(settings, TRUE);
        
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
        
        // Note: Removed visibility override for stability
        
        this->widget = webview;
        
        // Ensure webview is visible for rendering
        gtk_widget_set_visible(webview, TRUE);
        
        // Force widget realization to create rendering surface immediately
        gtk_widget_realize(webview);
        
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
                // For negative positions (scrolled out of view), we need to use
                // gtk_widget_set_margin_* with clamped values and offset the webview inside
                int clampedX = MAX(0, frame.x);
                int clampedY = MAX(0, frame.y);
                int offsetX = frame.x - clampedX;  // Will be negative if frame.x < 0
                int offsetY = frame.y - clampedY;  // Will be negative if frame.y < 0
                
                gtk_widget_set_size_request(wrapper, frame.width, frame.height);
                gtk_widget_set_margin_left(wrapper, clampedX);
                gtk_widget_set_margin_top(wrapper, clampedY);
                
                // Position webview within wrapper with offset to handle negative positions
                // TODO: this / 2 is a hack to adjust for GTK's coordinate system. not really sure why it works
                gtk_fixed_move(GTK_FIXED(wrapper), webview, offsetX, offsetY / 2);
                
                // OOPIF positioned with coordinate adjustment
            } else {
                // For host webview, position directly with margins (can't be negative)
                gtk_widget_set_margin_left(webview, MAX(0, frame.x));
                gtk_widget_set_margin_top(webview, MAX(0, frame.y));
            }
            
            visualBounds = frame;
        }
        maskJSON = masksJson ? masksJson : "";
    }
    
    void applyVisualMask() override {
        // TODO: Implement visual masking
    }
    
    void removeMasks() override {
        // TODO: Implement mask removal
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
                gtk_container_add(GTK_CONTAINER(overlay), view->widget);
            } else {
                // For OOPIFs, wrap in a fixed container to enforce size constraints
                GtkWidget* wrapper = gtk_fixed_new();
                gtk_widget_set_size_request(wrapper, 1, 1); // Don't affect overlay size
                
                // Make wrapper receive no events (pass through to widgets below)
                gtk_widget_set_events(wrapper, 0);
                gtk_widget_set_can_focus(wrapper, FALSE);
                
                // Add webview to wrapper at 0,0
                gtk_fixed_put(GTK_FIXED(wrapper), view->widget, 0, 0);
                
                // Add wrapper as overlay layer
                gtk_overlay_add_overlay(GTK_OVERLAY(overlay), wrapper);
                
                // Make the wrapper pass-through for events outside the webview
                gtk_overlay_set_overlay_pass_through(GTK_OVERLAY(overlay), wrapper, TRUE);
                
                // Position wrapper using margins (will be updated in resize)
                gtk_widget_set_margin_left(wrapper, (int)x);
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
            FILE* logFile = fopen("/tmp/tray_debug.log", "a");
            if (logFile) {
                fprintf(logFile, "AppIndicator created successfully, setting up...\n");
                fflush(logFile);
                fclose(logFile);
            }
            
            app_indicator_set_status(indicator, APP_INDICATOR_STATUS_ACTIVE);
            
            if (!this->title.empty()) {
                app_indicator_set_title(indicator, title);
            }
            
            // Create default menu (required for AppIndicator)
            createDefaultMenu();
            
            logFile = fopen("/tmp/tray_debug.log", "a");
            if (logFile) {
                fprintf(logFile, "TrayItem constructor completed successfully\n");
                fflush(logFile);
                fclose(logFile);
            }
        } else {
            FILE* logFile = fopen("/tmp/tray_debug.log", "a");
            if (logFile) {
                fprintf(logFile, "WARNING: app_indicator_new returned NULL - likely no system tray available\n");
                fflush(logFile);
                fclose(logFile);
            }
            // Don't throw exception - just continue without tray
            // This allows the app to run even if no system tray is available
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
            app_indicator_set_icon(indicator, imagePath.c_str());
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
        FILE* logFile = fopen("/tmp/tray_debug.log", "a");
        if (logFile) {
            fprintf(logFile, "Parsing menu JSON: %s\n", jsonString);
            fflush(logFile);
            fclose(logFile);
        }
        
        try {
            std::vector<MenuJsonValue> menuItems = parseMenuJson(std::string(jsonString));
            menu = createMenuFromParsedItems(menuItems, clickHandler, trayId);
            
            if (menu) {
                gtk_widget_show_all(menu);
                if (indicator) {
                    app_indicator_set_menu(indicator, GTK_MENU(menu));
                }
                
                logFile = fopen("/tmp/tray_debug.log", "a");
                if (logFile) {
                    fprintf(logFile, "Menu created successfully with %zu items\n", menuItems.size());
                    fflush(logFile);
                    fclose(logFile);
                }
            }
        } catch (const std::exception& e) {
            FILE* logFile = fopen("/tmp/tray_debug.log", "a");
            if (logFile) {
                fprintf(logFile, "Failed to parse menu JSON: %s\n", e.what());
                fflush(logFile);
                fclose(logFile);
            }
            
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
        itemData->clickHandler(itemData->menuId, itemData->action.c_str());
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
            if (item.hidden) {
                gtk_widget_hide(menuItem);
            }
            
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
    if (!g_gtkInitialized) {
        gtk_init(nullptr, nullptr);
        
        g_gtkInitialized = true;
        
        // Register the views:// URI scheme handler AFTER GTK is initialized
        WebKitWebContext* context = webkit_web_context_get_default();
        webkit_web_context_register_uri_scheme(context, "views", handleViewsURIScheme, nullptr, nullptr);
    }
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
            XFlush(x11win->display);
        }
    });
}

void showGTKWindow(void* window) {
    dispatch_sync_main_void([&]() {
        gtk_widget_show_all(GTK_WIDGET(window));
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

void startWindowMove(void* window) {
    // TODO: Implement window dragging for Linux
}

void stopWindowMove() {
    // TODO: Implement window dragging for Linux
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
    // TODO: Implement move to trash
    return false;
}

void showItemInFolder(char* path) {
    // TODO: Implement show item in folder
}

const char* openFileDialog(const char* startingFolder, const char* allowedFileTypes, bool allowMultipleSelection, const char* windowTitle, const char* buttonLabel) {
    // TODO: Implement file dialog
    return nullptr;
}

// NOTE: Removed deferred tray creation code - now creating TrayItem synchronously
// The TrayItem constructor handles deferred AppIndicator creation internally

void* createTray(uint32_t trayId, const char* title, const char* pathToImage, bool isTemplate, void* clickHandler) {
    FILE* logFile = fopen("/tmp/tray_debug.log", "a");
    if (logFile) {
        fprintf(logFile, "createTray called with:\n");
        fprintf(logFile, "  trayId: %u\n", trayId);
        fprintf(logFile, "  title: %s\n", title ? title : "NULL");
        fprintf(logFile, "  pathToImage: %s\n", pathToImage ? pathToImage : "NULL");
        fprintf(logFile, "  isTemplate: %s\n", isTemplate ? "true" : "false");
        fflush(logFile);
        fclose(logFile);
    }
    
    // GTK should already be initialized on main thread by runEventLoop()
    if (!g_gtkInitialized) {
        printf("ERROR: GTK not initialized for createTray! GTK must be initialized on main thread first.\n");
        fflush(stdout);
        return nullptr;
    }
    
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
            
            logFile = fopen("/tmp/tray_debug.log", "a");
            if (logFile) {
                fprintf(logFile, "Tray item created and stored with ID %u, returning pointer %p\n", trayId, trayPtr);
                fflush(logFile);
                fclose(logFile);
            }
            
            return trayPtr;
        } catch (const std::exception& e) {
            logFile = fopen("/tmp/tray_debug.log", "a");
            if (logFile) {
                fprintf(logFile, "Failed to create tray: %s\n", e.what());
                fflush(logFile);
                fclose(logFile);
            }
            return nullptr;
        } catch (...) {
            logFile = fopen("/tmp/tray_debug.log", "a");
            if (logFile) {
                fprintf(logFile, "Failed to create tray: unknown exception\n");
                fflush(logFile);
                fclose(logFile);
            }
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

void setApplicationMenu(const char* jsonString, void* zigTrayItemHandler) {
    // Note: Linux typically doesn't have global application menus like macOS
    // This would require integration with the desktop environment
    // For now, we'll log the request and potentially implement it later
    FILE* logFile = fopen("/tmp/tray_debug.log", "a");
    if (logFile) {
        fprintf(logFile, "setApplicationMenu called - Linux implementation pending\n");
        fflush(logFile);
        fclose(logFile);
    }
}

void showContextMenu(const char* jsonString, void* contextMenuHandler) {
    if (!jsonString || strlen(jsonString) == 0) {
        return;
    }
    
    // GTK should already be initialized on main thread by runEventLoop()
    if (!g_gtkInitialized) {
        printf("ERROR: GTK not initialized for showContextMenu! GTK must be initialized on main thread first.\n");
        fflush(stdout);
        return;
    }
    
    dispatch_sync_main_void([&]() {
        FILE* logFile = fopen("/tmp/tray_debug.log", "a");
        if (logFile) {
            fprintf(logFile, "Creating context menu from JSON: %s\n", jsonString);
            fflush(logFile);
            fclose(logFile);
        }
        
        try {
            std::vector<MenuJsonValue> menuItems = parseMenuJson(std::string(jsonString));
            GtkWidget* contextMenu = createMenuFromParsedItems(menuItems, 
                                                               reinterpret_cast<ZigStatusItemHandler>(contextMenuHandler), 
                                                               0); // Use 0 for context menu ID
            
            if (contextMenu) {
                gtk_widget_show_all(contextMenu);
                
                // Show context menu at mouse position
                gtk_menu_popup_at_pointer(GTK_MENU(contextMenu), nullptr);
                
                logFile = fopen("/tmp/tray_debug.log", "a");
                if (logFile) {
                    fprintf(logFile, "Context menu created and shown with %zu items\n", menuItems.size());
                    fflush(logFile);
                    fclose(logFile);
                }
            }
        } catch (const std::exception& e) {
            FILE* logFile = fopen("/tmp/tray_debug.log", "a");
            if (logFile) {
                fprintf(logFile, "Failed to create context menu: %s\n", e.what());
                fflush(logFile);
                fclose(logFile);
            }
        }
    });
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
    // TODO: Implement app termination
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
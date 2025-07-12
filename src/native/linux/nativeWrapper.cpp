#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <jsc/jsc.h>
#include <libayatana-appindicator/app-indicator.h>
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
GtkWidget* createMenuFromParsedItems(const std::vector<MenuJsonValue>& items, ZigStatusItemHandler clickHandler, uint32_t trayId);

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
        
        // Create web context with partition
        WebKitWebContext* context = webkit_web_context_new();
        if (!partition.empty()) {
            webkit_web_context_set_web_extensions_directory(context, "/tmp"); // TODO: Use proper partition
        }
        
        // Create webview
        fprintf(stderr, "Creating WebKit webview...\n");
        webview = webkit_web_view_new_with_user_content_manager(manager);
        if (!webview) {
            fprintf(stderr, "ERROR: Failed to create WebKit webview\n");
            throw std::runtime_error("Failed to create WebKit webview");
        }
        fprintf(stderr, "WebKit webview created successfully\n");
        
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
        
        this->widget = webview;
        
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
            fprintf(stderr, "Loading URL: %s\n", urlString);
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
            gtk_widget_set_size_request(webview, frame.width, frame.height);
            if (gtk_widget_get_parent(webview)) {
                // Always position at the requested coordinates since we're using 
                // separate containers for auto-resize vs OOPIF webviews
                gtk_fixed_move(GTK_FIXED(gtk_widget_get_parent(webview)), webview, frame.x, frame.y);
                visualBounds = frame;
            }
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
};

// Container for managing multiple webviews
class ContainerView {
public:
    GtkWidget* window;
    GtkWidget* container;
    GtkWidget* oopifContainer; // Separate container for OOPIF webviews
    std::vector<std::shared_ptr<AbstractView>> abstractViews;
    AbstractView* activeWebView = nullptr;
    
    ContainerView(GtkWidget* window) : window(window) {
        // Create main container for auto-resize webviews
        container = gtk_fixed_new();
        
        // Ensure the container doesn't affect window sizing
        g_object_set(container,
                    "expand", FALSE,
                    "hexpand", FALSE,
                    "vexpand", FALSE,
                    NULL);
        
        // Create separate container for OOPIF webviews that won't affect window sizing
        oopifContainer = gtk_fixed_new();
        
        // CRITICAL: Set OOPIF container to not contribute to size requests
        g_object_set(oopifContainer,
                    "expand", FALSE,
                    "hexpand", FALSE,
                    "vexpand", FALSE,
                    NULL);
        
        // Override size request to always return 0,0 for OOPIF container
        g_signal_connect(oopifContainer, "size-request", 
                        G_CALLBACK(oopifContainerSizeRequest), NULL);
        
        // Create an overlay to properly layer containers
        GtkWidget* overlay = gtk_overlay_new();
        gtk_container_add(GTK_CONTAINER(window), overlay);
        
        // Add main container as base layer
        gtk_container_add(GTK_CONTAINER(overlay), container);
        
        // Add OOPIF container as overlay layer
        gtk_overlay_add_overlay(GTK_OVERLAY(overlay), oopifContainer);
        
        gtk_widget_show(overlay);
        gtk_widget_show(container);
        gtk_widget_show(oopifContainer);
    }
    
    // Custom size request handler for OOPIF container
    static void oopifContainerSizeRequest(GtkWidget* widget, GtkRequisition* requisition, gpointer user_data) {
        // Always request 0,0 size so this container doesn't affect window auto-sizing
        requisition->width = 0;
        requisition->height = 0;
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
            
            // Choose container based on whether this is auto-resize or OOPIF
            GtkWidget* targetContainer = view->fullSize ? container : oopifContainer;
            
            gtk_fixed_put(GTK_FIXED(targetContainer), view->widget, (int)x, (int)y);
            gtk_widget_show(view->widget);
            
            // No need for mirror mode with separate containers - OOPIFs go directly 
            // into the non-sizing container at their correct positions
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
            // OOPIFs (fullSize=false) are in separate container and keep their positioning
        }
        
        // Also ensure the OOPIF container spans the entire window for proper layering
        if (oopifContainer) {
            gtk_widget_set_size_request(oopifContainer, width, height);
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
    
    printf("views:// request: uri=%s, fullPath=%s\n", uri, fullPath ? fullPath : "NULL");
    printf("DEBUG: After parsing, fullPath should be: %s\n", fullPath);
    printf("cwd=%s\n", cwd);
    printf("viewsDir=%s\n", viewsDir);
    printf("Loading file: %s\n", filePath);
    printf("Expected: webviewtag/index.html, got: %s\n", fullPath ? fullPath : "NULL");
    fflush(stdout);
    
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
            
            printf("Served file: %s (%zu bytes, %s)\n", filePath, fileSize, mimeType);
            fflush(stdout);
        } else {
            printf("Failed to read file: %s - %s\n", filePath, error ? error->message : "unknown error");
            fflush(stdout);
            
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
    
    printf("initializeGTK called, g_gtkInitialized=%d\n", g_gtkInitialized);
    fflush(stdout);
    
    if (!g_gtkInitialized) {
        printf("Calling gtk_init...\n");
        fflush(stdout);
        gtk_init(nullptr, nullptr);
        printf("gtk_init completed\n");
        fflush(stdout);
        
        g_gtkInitialized = true;
        
        printf("GTK initialization complete\n");
        fflush(stdout);
        
        // Register the views:// URI scheme handler AFTER GTK is initialized
        WebKitWebContext* context = webkit_web_context_get_default();
        webkit_web_context_register_uri_scheme(context, "views", handleViewsURIScheme, nullptr, nullptr);
        printf("Registered views:// URI scheme handler with context %p\n", context);
        fflush(stdout);
        
        // Also test if our handler function is accessible
        printf("Handler function address: %p\n", (void*)handleViewsURIScheme);
        fflush(stdout);
    }
}

// Helper function to dispatch to main thread synchronously
template<typename Func>
auto dispatch_sync_main(Func&& func) -> decltype(func()) {
    using ReturnType = decltype(func());
    
    // If already on main thread, just execute
    if (g_main_context_is_owner(g_main_context_default())) {
        printf("Already on main thread, executing directly\n");
        fflush(stdout);
        return func();
    }
    
    printf("Not on main thread, dispatching to main thread\n");
    fflush(stdout);
    
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
    printf("=== ELECTROBUN LINUX NATIVE LIBRARY LOADED ===\n");
    printf("Library constructor called\n");
    fflush(stdout);
    
    // Write to a file as well to make sure it's visible
    FILE* logFile = fopen("/tmp/electrobun_debug.log", "a");
    if (logFile) {
        fprintf(logFile, "=== ELECTROBUN LINUX NATIVE LIBRARY LOADED ===\n");
        fprintf(logFile, "Library constructor called at startup\n");
        fflush(logFile);
        fclose(logFile);
    }
}

void runEventLoop() {
    printf("runEventLoop called - initializing GTK on main thread\n");
    fflush(stdout);
    
    // Initialize GTK on the main thread (this MUST be done here)
    initializeGTK();
    
    printf("GTK initialized, starting main loop\n");
    fflush(stdout);
    sleep(1); // Give time for output to flush
    gtk_main();
}

// Forward declarations
void* createWindow(uint32_t windowId, double x, double y, double width, double height, const char* title, 
                   WindowCloseCallback closeCallback, WindowMoveCallback moveCallback, WindowResizeCallback resizeCallback);
void showWindow(void* window);

// Mac-compatible function for Linux
void* createWindowWithFrameAndStyleFromWorker(uint32_t windowId, double x, double y, double width, double height, 
                                             uint32_t styleMask, const char* titleBarStyle,
                                             WindowCloseCallback closeCallback, WindowMoveCallback moveCallback, WindowResizeCallback resizeCallback) {
    printf("=== createWindowWithFrameAndStyleFromWorker ENTRY ===\n");
    printf("windowId=%u, x=%f, y=%f, w=%f, h=%f\n", windowId, x, y, width, height);
    printf("styleMask=%u, titleBarStyle=%s\n", styleMask, titleBarStyle ? titleBarStyle : "NULL");
    printf("closeCallback=%p, moveCallback=%p, resizeCallback=%p\n", closeCallback, moveCallback, resizeCallback);
    fflush(stdout);
    
    // On Linux, ignore styleMask and titleBarStyle for now, just create basic window
    void* result = createWindow(windowId, x, y, width, height, "Window", closeCallback, moveCallback, resizeCallback);
    
    printf("=== createWindowWithFrameAndStyleFromWorker RETURN: %p ===\n", result);
    fflush(stdout);
    
    return result;
}

void* createWindow(uint32_t windowId, double x, double y, double width, double height, const char* title, 
                   WindowCloseCallback closeCallback, WindowMoveCallback moveCallback, WindowResizeCallback resizeCallback) {
    
                    printf("=== createWindow ENTRY ===\n");
    printf("windowId=%u, title=%s, x=%f, y=%f, w=%f, h=%f\n", windowId, title, x, y, width, height);
    fflush(stdout);
    
    // Note: GTK is initialized on main thread by runEventLoop()
    // Since we dispatch all GUI operations to main thread, we don't need to check here
    printf("createWindow: proceeding (GTK init handled by main thread dispatch)\n");
    fflush(stdout);
    
    
    printf("GTK initialized, about to dispatch createWindow to main thread\n");
    fflush(stdout);
    
    void* result = dispatch_sync_main([&]() -> void* {
        printf("=== INSIDE createWindow dispatch_sync_main ===\n");
        fflush(stdout);
        
        GtkWidget* window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
        printf("gtk_window_new completed: %p\n", window);
        fflush(stdout);
        
        gtk_window_set_title(GTK_WINDOW(window), title);
        printf("gtk_window_set_title completed\n");
        fflush(stdout);
        
        gtk_window_set_default_size(GTK_WINDOW(window), (int)width, (int)height);
        printf("gtk_window_set_default_size completed\n");
        fflush(stdout);
        
        if (x >= 0 && y >= 0) {
            gtk_window_move(GTK_WINDOW(window), (int)x, (int)y);
            printf("gtk_window_move completed\n");
            fflush(stdout);
        }
        
        // Create container
        printf("Creating ContainerView...\n");
        fflush(stdout);
        auto container = std::make_shared<ContainerView>(window);
        printf("ContainerView created, storing in g_containers\n");
        fflush(stdout);
        g_containers[windowId] = container;
        printf("Container stored with windowId=%u\n", windowId);
        fflush(stdout);
        
        // Store callbacks (simplified - in real implementation you'd want to store these properly)
        // For now, just connect basic destroy signal
        g_signal_connect(window, "destroy", G_CALLBACK(gtk_main_quit), nullptr);
        printf("destroy signal connected\n");
        fflush(stdout);
        
        // Connect window resize signal for auto-resize functionality
        g_signal_connect(window, "configure-event", G_CALLBACK(onWindowConfigure), container.get());
        printf("configure-event signal connected\n");
        fflush(stdout);
        
        // Don't show window yet - that's handled by showWindow
        printf("=== createWindow dispatch_sync_main RETURNING: %p ===\n", window);
        fflush(stdout);
        
        return (void*)window;
    });
    
    printf("=== createWindow RETURN: %p ===\n", result);
    fflush(stdout);
    
    return result;
}

void setWindowTitle(void* window, const char* title) {
    dispatch_sync_main_void([&]() {
        gtk_window_set_title(GTK_WINDOW(window), title);
    });
}

// Mac-compatible function for Linux
void setNSWindowTitle(void* window, const char* title) {
    setWindowTitle(window, title);
}

// Mac-compatible function for Linux
void makeNSWindowKeyAndOrderFront(void* window) {
    showWindow(window);
}

void showWindow(void* window) {
    dispatch_sync_main_void([&]() {
        gtk_widget_show_all(GTK_WIDGET(window));
    });
}

// Mac-compatible function for Linux - return dummy style mask
uint32_t getNSWindowStyleMask(bool borderless, bool titled, bool closable, bool miniaturizable, 
                              bool resizable, bool unifiedTitleAndToolbar, bool fullScreen, 
                              bool fullSizeContentView, bool utilityWindow, bool docModalWindow, 
                              bool nonactivatingPanel, bool hudWindow) {
    // Linux doesn't use style masks like macOS, so just return a dummy value
    // The actual window styling is handled in createWindow
    printf("getNSWindowStyleMask called (Linux - returning dummy value)\n");
    fflush(stdout);
    return 0;
}



// Webview functions
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
    
    printf("=== initWebview ENTRY ===\n");
    printf("webviewId=%u, window=%p, renderer=%s\n", webviewId, window, renderer ? renderer : "NULL");
    printf("url=%s, x=%f, y=%f, w=%f, h=%f\n", url ? url : "NULL", x, y, width, height);
    fflush(stdout);
    
    AbstractView* result = dispatch_sync_main([&]() -> AbstractView* {
        try {
            printf("=== INSIDE initWebview dispatch_sync_main ===\n");
            fflush(stdout);
            
            // Create WebKit webview implementation
            printf("Creating WebKit webview on main thread\n");
            fflush(stdout);
            
            auto webview = std::make_shared<WebKitWebViewImpl>(
                webviewId, GTK_WIDGET(window),
                url, x, y, width, height, autoResize,
                partitionIdentifier, navigationCallback, webviewEventHandler,
                bunBridgeHandler, internalBridgeHandler,
                electrobunPreloadScript, customPreloadScript
            );
            
            // Set fullSize flag for auto-resize functionality
            webview->fullSize = autoResize;
            
            printf("WebKit webview created successfully\n");
            fflush(stdout);
            
            // Add to container
            printf("Looking for container with window=%p\n", window);
            fflush(stdout);
            for (auto& [id, container] : g_containers) {
                printf("Checking container id=%u, window=%p\n", id, container->window);
                fflush(stdout);
                if (container->window == GTK_WIDGET(window)) {
                    printf("Found matching container, adding webview at (%f, %f)\n", x, y);
                    fflush(stdout);
                    container->addWebview(webview, x, y);
                    printf("WebKit webview added to container\n");
                    fflush(stdout);
                    break;
                }
            }
            
            printf("=== initWebview dispatch_sync_main RETURNING: %p ===\n", webview.get());
            fflush(stdout);
            
            return webview.get();
        } catch (const std::exception& e) {
            printf("ERROR: Failed to create webview: %s\n", e.what());
            fflush(stdout);
            return nullptr;
        }
    });
    
    printf("=== initWebview RETURN: %p ===\n", result);
    fflush(stdout);
    
    return result;
}

void loadURLInWebView(AbstractView* abstractView, const char* urlString) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->loadURL(urlString);
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

void resizeWebview(AbstractView* abstractView, double x, double y, double width, double height, const char* masksJson) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            GdkRectangle frame = { (int)x, (int)y, (int)width, (int)height };
            abstractView->resize(frame, masksJson);
        });
    }
}

void evaluateJavaScriptWithNoCompletion(AbstractView* abstractView, const char* js) {
    if (abstractView) {
        dispatch_sync_main_void([&]() {
            abstractView->evaluateJavaScriptWithNoCompletion(js);
        });
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
    printf("=== runNSApplication called ===\n");
    fflush(stdout);
    
    // Write to log file too
    FILE* logFile = fopen("/tmp/electrobun_debug.log", "a");
    if (logFile) {
        fprintf(logFile, "=== runNSApplication called ===\n");
        fflush(logFile);
        fclose(logFile);
    }
    
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
            gtk_widget_destroy(GTK_WIDGET(window));
        });
    }
}


}
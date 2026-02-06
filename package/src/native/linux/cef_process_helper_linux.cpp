#include <iostream>
#include <map>
#include <mutex>
#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_v8.h"

// Simple CEF app for the helper process
class HelperApp : public CefApp, public CefRenderProcessHandler {
public:
    HelperApp() {}

    // CefApp methods:
    virtual void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
        registrar->AddCustomScheme("views",
            CEF_SCHEME_OPTION_STANDARD |
            CEF_SCHEME_OPTION_CORS_ENABLED |
            CEF_SCHEME_OPTION_SECURE | // treat it like https
            CEF_SCHEME_OPTION_CSP_BYPASSING | // allow things like crypto.subtle
            CEF_SCHEME_OPTION_FETCH_ENABLED);
    }

    virtual CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override {
        return this;
    }

    // CefRenderProcessHandler methods:

    // Called when a browser is created - receive sandbox flag via extra_info
    virtual void OnBrowserCreated(CefRefPtr<CefBrowser> browser,
                                  CefRefPtr<CefDictionaryValue> extra_info) override {
        if (extra_info && extra_info->HasKey("sandbox")) {
            bool sandbox = extra_info->GetBool("sandbox");
            std::lock_guard<std::mutex> lock(sandbox_map_mutex_);
            sandbox_map_[browser->GetIdentifier()] = sandbox;
        }
    }

    // Called when a browser is destroyed - cleanup sandbox flag
    virtual void OnBrowserDestroyed(CefRefPtr<CefBrowser> browser) override {
        std::lock_guard<std::mutex> lock(sandbox_map_mutex_);
        sandbox_map_.erase(browser->GetIdentifier());
    }

    virtual void OnContextCreated(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefRefPtr<CefV8Context> context) override {
        // Check if this browser is sandboxed
        bool is_sandboxed = false;
        {
            std::lock_guard<std::mutex> lock(sandbox_map_mutex_);
            auto it = sandbox_map_.find(browser->GetIdentifier());
            if (it != sandbox_map_.end()) {
                is_sandboxed = it->second;
            }
        }

        // Log the context creation
        std::string frameUrl = frame->GetURL().ToString();

        // Get the global window object
        CefRefPtr<CefV8Context> v8Context = frame->GetV8Context();
        v8Context->Enter();

        CefRefPtr<CefV8Value> window = context->GetGlobal();

        // Create eventBridge - event-only bridge (always available for all webviews, including sandboxed)
        CefRefPtr<CefV8Value> eventBridge = CefV8Value::CreateObject(nullptr, nullptr);
        CefRefPtr<CefV8Value> eventPostMessage = CreatePostMessageFunction(browser, "EventBridgeMessage");
        eventBridge->SetValue("postMessage", eventPostMessage, V8_PROPERTY_ATTRIBUTE_NONE);
        window->SetValue("__electrobunEventBridge", eventBridge, V8_PROPERTY_ATTRIBUTE_NONE);

        // Only create bunBridge and internalBridge for non-sandboxed webviews
        if (!is_sandboxed) {
            // Create bunBridge - user RPC bridge
            CefRefPtr<CefV8Value> bunBridge = CefV8Value::CreateObject(nullptr, nullptr);
            CefRefPtr<CefV8Value> bunPostMessage = CreatePostMessageFunction(browser, "BunBridgeMessage");
            bunBridge->SetValue("postMessage", bunPostMessage, V8_PROPERTY_ATTRIBUTE_NONE);
            window->SetValue("__electrobunBunBridge", bunBridge, V8_PROPERTY_ATTRIBUTE_NONE);

            // Create internalBridge - internal RPC bridge
            CefRefPtr<CefV8Value> internalBridge = CefV8Value::CreateObject(nullptr, nullptr);
            CefRefPtr<CefV8Value> internalPostMessage = CreatePostMessageFunction(browser, "internalMessage");
            internalBridge->SetValue("postMessage", internalPostMessage, V8_PROPERTY_ATTRIBUTE_NONE);
            window->SetValue("__electrobunInternalBridge", internalBridge, V8_PROPERTY_ATTRIBUTE_NONE);
        }

        v8Context->Exit();
    }

private:
    // Map of browser ID to sandbox flag
    std::map<int, bool> sandbox_map_;
    std::mutex sandbox_map_mutex_;
    // Helper class to handle V8 function calls
    class V8Handler : public CefV8Handler {
    public:
        V8Handler(CefRefPtr<CefBrowser> browser, const CefString& messageName)
            : browser_(browser), message_name_(messageName) {}

        virtual bool Execute(const CefString& name,
                           CefRefPtr<CefV8Value> object,
                           const CefV8ValueList& arguments,
                           CefRefPtr<CefV8Value>& retval,
                           CefString& exception) override {
            if (arguments.size() > 0 && arguments[0]->IsString()) {
                std::string msgContent = arguments[0]->GetStringValue();

                // Create and send process message to the main process
                CefRefPtr<CefFrame> mainFrame = browser_->GetMainFrame();
                if (mainFrame) {
                    CefRefPtr<CefProcessMessage> message = CefProcessMessage::Create(message_name_);
                    message->GetArgumentList()->SetString(0, msgContent);
                    mainFrame->SendProcessMessage(PID_BROWSER, message);
                }
                return true;
            }
            return false;
        }

    private:
        CefRefPtr<CefBrowser> browser_;
        CefString message_name_;
        IMPLEMENT_REFCOUNTING(V8Handler);
    };

    CefRefPtr<CefV8Value> CreatePostMessageFunction(CefRefPtr<CefBrowser> browser,
                                                   const CefString& messageName) {
        return CefV8Value::CreateFunction(
            "postMessage",
            new V8Handler(browser, messageName)
        );
    }

    // Include the default reference counting implementation.
    IMPLEMENT_REFCOUNTING(HelperApp);
};

// Entry point function for all processes.
int main(int argc, char* argv[]) {
    // CEF helper process starting
    
    // Provide CEF with command-line arguments.
    CefMainArgs main_args(argc, argv);

    // CEF applications have multiple sub-processes (render, plugin, GPU, etc)
    // that share the same executable. This function checks the command-line and,
    // if this is a sub-process, executes the appropriate logic.
    int exit_code = CefExecuteProcess(main_args, new HelperApp(), nullptr);
    if (exit_code >= 0) {
        // The sub-process has completed so return here.
        printf("CEF Helper: Helper process exiting with code %d\n", exit_code);
        return exit_code;
    }

    // Should not reach here for helper processes
    std::cerr << "CEF helper process failed to initialize properly" << std::endl;
    return -1;
}
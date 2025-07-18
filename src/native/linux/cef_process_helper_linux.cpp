#include <iostream>
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
    virtual void OnContextCreated(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                CefRefPtr<CefV8Context> context) override {
        // Log the context creation
        std::string frameUrl = frame->GetURL().ToString();
        printf("CEF Helper: OnContextCreated called for frame %s\n", frameUrl.c_str());
        
        // Get the global window object
        CefRefPtr<CefV8Context> v8Context = frame->GetV8Context();
        v8Context->Enter();
        
        CefRefPtr<CefV8Value> window = context->GetGlobal();

        // Create bunBridge
        CefRefPtr<CefV8Value> bunBridge = CefV8Value::CreateObject(nullptr, nullptr);
        CefRefPtr<CefV8Value> bunPostMessage = CreatePostMessageFunction(browser, "BunBridgeMessage");
        bunBridge->SetValue("postMessage", bunPostMessage, V8_PROPERTY_ATTRIBUTE_NONE);
        window->SetValue("bunBridge", bunBridge, V8_PROPERTY_ATTRIBUTE_NONE);
        printf("CEF Helper: Created bunBridge with postMessage function\n");

        // Create internalBridge
        CefRefPtr<CefV8Value> internalBridge = CefV8Value::CreateObject(nullptr, nullptr);
        CefRefPtr<CefV8Value> internalPostMessage = CreatePostMessageFunction(browser, "internalMessage");
        internalBridge->SetValue("postMessage", internalPostMessage, V8_PROPERTY_ATTRIBUTE_NONE);
        window->SetValue("internalBridge", internalBridge, V8_PROPERTY_ATTRIBUTE_NONE);
        printf("CEF Helper: Created internalBridge with postMessage function\n");


        v8Context->Exit();
    }

private:
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
            printf("CEF Helper: V8Handler Execute called for %s with %zu arguments\n", 
                   message_name_.ToString().c_str(), arguments.size());
            
            if (arguments.size() > 0 && arguments[0]->IsString()) {
                std::string msgContent = arguments[0]->GetStringValue();
                printf("CEF Helper: Sending %s message: %s\n", 
                       message_name_.ToString().c_str(), msgContent.c_str());
                
                // Create and send process message to the main process
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
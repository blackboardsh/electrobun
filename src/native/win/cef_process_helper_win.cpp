#include "include/cef_app.h"
#include "include/cef_v8.h"

class HelperApp : public CefApp, public CefRenderProcessHandler {
public:
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
        // Get the global window object
        CefRefPtr<CefV8Context> v8Context = frame->GetV8Context();
        v8Context->Enter();
        
        CefRefPtr<CefV8Value> window = context->GetGlobal();

        // Create bunBridge
        CefRefPtr<CefV8Value> bunBridge = CefV8Value::CreateObject(nullptr, nullptr);
        CefRefPtr<CefV8Value> bunPostMessage = CreatePostMessageFunction(browser, "BunBridgeMessage");
        bunBridge->SetValue("postMessage", bunPostMessage, V8_PROPERTY_ATTRIBUTE_NONE);
        window->SetValue("bunBridge", bunBridge, V8_PROPERTY_ATTRIBUTE_NONE);

        // Create internalBridge
        CefRefPtr<CefV8Value> internalBridge = CefV8Value::CreateObject(nullptr, nullptr);
        CefRefPtr<CefV8Value> internalPostMessage = CreatePostMessageFunction(browser, "internalMessage");
        internalBridge->SetValue("postMessage", internalPostMessage, V8_PROPERTY_ATTRIBUTE_NONE);
        window->SetValue("internalBridge", internalBridge, V8_PROPERTY_ATTRIBUTE_NONE);

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
            if (arguments.size() > 0 && arguments[0]->IsString()) {
                // Create and send process message to the main process
                CefRefPtr<CefProcessMessage> message = CefProcessMessage::Create(message_name_);
                message->GetArgumentList()->SetString(0, arguments[0]->GetStringValue());
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

    IMPLEMENT_REFCOUNTING(HelperApp);
};

// Entry point function for Windows sub-processes.
int APIENTRY wWinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPWSTR lpCmdLine, int nCmdShow) {
    // Provide CEF with command-line arguments.
    CefMainArgs main_args(GetCommandLineW());

    CefRefPtr<CefApp> app(new HelperApp);

    // Execute the sub-process.
    return CefExecuteProcess(main_args, app, nullptr);
}

// Alternative entry point for console applications
int main() {
    return wWinMain(GetModuleHandle(NULL), NULL, GetCommandLineW(), SW_HIDE);
}
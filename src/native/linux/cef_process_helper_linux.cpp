#include <iostream>
#include "include/cef_app.h"
#include "include/cef_client.h"

// Simple CEF app for the helper process
class HelperApp : public CefApp, public CefRenderProcessHandler {
public:
    HelperApp() {}

    // CefApp methods:
    virtual CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override {
        return this;
    }

private:
    // Include the default reference counting implementation.
    IMPLEMENT_REFCOUNTING(HelperApp);
};

// Entry point function for all processes.
int main(int argc, char* argv[]) {
    // Provide CEF with command-line arguments.
    CefMainArgs main_args(argc, argv);

    // CEF applications have multiple sub-processes (render, plugin, GPU, etc)
    // that share the same executable. This function checks the command-line and,
    // if this is a sub-process, executes the appropriate logic.
    int exit_code = CefExecuteProcess(main_args, new HelperApp(), nullptr);
    if (exit_code >= 0) {
        // The sub-process has completed so return here.
        return exit_code;
    }

    // Should not reach here for helper processes
    std::cerr << "CEF helper process failed to initialize properly" << std::endl;
    return -1;
}
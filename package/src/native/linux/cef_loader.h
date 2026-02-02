#ifndef CEF_LOADER_H
#define CEF_LOADER_H

#include <dlfcn.h>
#include <string>
#include <atomic>

// Dynamic CEF loading wrapper for weak linking on Linux
// This uses dlopen with RTLD_GLOBAL to make all CEF symbols available
// globally, which allows us to use CEF normally without function pointers
class CefLoader {
private:
    static void* cef_lib_handle;
    static std::atomic<bool> initialized;
    static std::atomic<bool> load_attempted;

public:
    // Initialize the loader and attempt to load CEF
    static bool Initialize();
    
    // Check if CEF is loaded and available
    static bool IsLoaded() { return initialized.load(); }
    
    // Get the path to libcef.so
    static std::string GetCefLibraryPath();
};

#endif // CEF_LOADER_H
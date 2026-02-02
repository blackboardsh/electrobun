#include "cef_loader.h"
#include <iostream>
#include <sys/stat.h>
#include <unistd.h>
#include <limits.h>
#include <cstdlib>
#include <cstring>

// Static member definitions
void* CefLoader::cef_lib_handle = nullptr;
std::atomic<bool> CefLoader::initialized(false);
std::atomic<bool> CefLoader::load_attempted(false);

std::string CefLoader::GetCefLibraryPath() {
    // Get the executable directory
    char exe_path[PATH_MAX];
    ssize_t len = readlink("/proc/self/exe", exe_path, sizeof(exe_path) - 1);
    if (len == -1) return "";
    
    exe_path[len] = '\0';
    std::string execPath(exe_path);
    size_t pos = execPath.find_last_of('/');
    if (pos != std::string::npos) {
        execPath = execPath.substr(0, pos);
    }
    
    // Check primary location: execDir/cef/libcef.so
    std::string cefLibPath = execPath + "/cef/libcef.so";
    struct stat buffer;
    if (stat(cefLibPath.c_str(), &buffer) == 0) {
        return cefLibPath;
    }
    
    // Check fallback location: execDir/libcef.so
    cefLibPath = execPath + "/libcef.so";
    if (stat(cefLibPath.c_str(), &buffer) == 0) {
        return cefLibPath;
    }
    
    return "";
}

bool CefLoader::Initialize() {
    // Only attempt to load once
    bool expected = false;
    if (!load_attempted.compare_exchange_strong(expected, true)) {
        return initialized.load();
    }
    
    // Get CEF library path
    std::string cefPath = GetCefLibraryPath();
    if (cefPath.empty()) {
        std::cout << "CEF library not found - CEF features will be disabled" << std::endl;
        return false;
    }
    
    std::cout << "Attempting to load CEF from: " << cefPath << std::endl;
    
    // Extract directory for LD_LIBRARY_PATH
    std::string cefDir;
    size_t pos = cefPath.find_last_of('/');
    if (pos != std::string::npos) {
        cefDir = cefPath.substr(0, pos);
    }
    
    // Set LD_LIBRARY_PATH to include the CEF directory for dependent libraries
    const char* existing_ld_path = getenv("LD_LIBRARY_PATH");
    std::string new_ld_path = cefDir;
    if (existing_ld_path && strlen(existing_ld_path) > 0) {
        new_ld_path += ":";
        new_ld_path += existing_ld_path;
    }
    setenv("LD_LIBRARY_PATH", new_ld_path.c_str(), 1);
    
    // Also set LD_LIBRARY_PATH for the current process using dlopen hack
    // This ensures dependent libraries can be found
    void* handle = dlopen(nullptr, RTLD_LAZY | RTLD_GLOBAL);
    if (handle) {
        dlclose(handle);
    }
    
    // Load CEF library with RTLD_GLOBAL to make all symbols available globally
    // This allows CEF to be used normally without function pointers
    cef_lib_handle = dlopen(cefPath.c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (!cef_lib_handle) {
        const char* error = dlerror();
        std::cerr << "Failed to load CEF library: " << (error ? error : "unknown error") << std::endl;
        
        // Try to provide more helpful error messages
        if (error && strstr(error, "cannot open shared object file")) {
            std::cerr << "Make sure all CEF dependencies are in the same directory as libcef.so" << std::endl;
            std::cerr << "LD_LIBRARY_PATH was set to: " << new_ld_path << std::endl;
        }
        return false;
    }
    
    // Verify critical symbols are available
    dlerror(); // Clear any existing errors
    void* init_sym = dlsym(cef_lib_handle, "cef_initialize");
    if (!init_sym) {
        std::cerr << "CEF library loaded but cef_initialize symbol not found: " << dlerror() << std::endl;
        dlclose(cef_lib_handle);
        cef_lib_handle = nullptr;
        return false;
    }
    
    initialized.store(true);
    std::cout << "CEF library loaded successfully" << std::endl;
    return true;
}
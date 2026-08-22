#include <winsock2.h>   // Must come before Windows.h
#include <ws2tcpip.h>
#include <winhttp.h>
#include <Windows.h>
#include <windowsx.h>  // For GET_X_LPARAM and GET_Y_LPARAM
#include <string>
#include <cstring>
#include <functional>
#include <vector>
#include <iostream>
#include <fstream>
#include <sstream>
#include <ctime>
#include <chrono>
#include <functional>
#include <future>
#include <memory>
#include <thread>
#include <cmath>
#include <limits>
#include <filesystem>
#include <windows.h>
#include <atomic>
#include "../shared/pending_resize_queue.h"
#include "dawn/webgpu.h"
#include "dawn/native/D3D12Backend.h"
#include <wrl.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>
#include <map>
#include <algorithm>
#include <stdint.h>
#include <shellapi.h>
#include <commctrl.h>
#include <mutex>
#include <atomic>
#include <cstdarg>
#include <winrt/Windows.Data.Json.h>
#include <winrt/base.h>
#include <shobjidl.h>  // For IFileOpenDialog
#include <shlobj.h>    // For SHGetKnownFolderPath, FOLDERID_Downloads
#include <shlguid.h>   // For CLSID_FileOpenDialog
#include <commdlg.h>   // For COMDLG_FILTERSPEC
#include <dcomp.h>     // For DirectComposition
#include <dxgi1_2.h>   // For DXGI 1.2 (CreateSwapChainForComposition)
#include <d3d11.h>     // For D3D11 (DComp swap chain creation)
#include <locale>      // For string conversion
#include <codecvt>     // For UTF-8 to wide string conversion
#include <d2d1.h>      // For Direct2D
#include <direct.h>    // For _getcwd

// Shared cross-platform utilities
#include "../shared/glob_match.h"
#include "../shared/callbacks.h"
#include "../shared/permissions.h"
#include "../shared/mime_types.h"
#include "../shared/config.h"
#include "../shared/preload_script.h"
#include "../shared/webview_storage.h"
#include "../shared/navigation_rules.h"
#include "../shared/thread_safe_map.h"
#include "../shared/shutdown_guard.h"
#include "../shared/ffi_helpers.h"
#include "../shared/json_menu_parser.h"
#include "../shared/download_event.h"
#include "../shared/app_paths.h"
#include "../shared/windows_utf.h"
#include "../shared/windows_dialog_options.h"
#include "../shared/windows_profile_paths.h"
#include "../shared/windows_resource_paths.h"
#include "../shared/windows_dpi.h"
#include "../shared/accelerator_parser.h"
#include "../shared/chromium_flags.h"
#include "../shared/webview2_permissions.h"
#include "../shared/cache_migration.h"
#include "../shared/views_url.h"
#include "../shared/console_forwarding.h"
#include "../shared/dialog_paths.h"
#include "../shared/cef_find_session.h"

// DirectComposition compositor (GPU surface compositing for Windows)
#include "dcomp_compositor.h"

// DirectComposition zero-copy bridge state (per-surface)
// DCompBridgeState is defined later, after WGPU function pointer declarations.
// Forward declarations for the map:
struct DCompBridgeState;
static std::map<void*, std::shared_ptr<DCompBridgeState>> g_dcompBridges;
static std::mutex g_dcompBridgeMapMutex;

using namespace electrobun;

// Simple ASAR reader implementation for Windows (no external dependency)
#include <fstream>
#include <map>
#include <variant>
#include <string>
#include <sstream>
#include <algorithm>

// Minimal JSON parser for ASAR headers
struct AsarFileEntry {
    size_t offset;
    size_t size;
};

struct AsarDirEntry {
    std::map<std::string, std::variant<AsarFileEntry, AsarDirEntry>> files;
};

class AsarArchive {
public:
    std::ifstream file;
    AsarDirEntry root;
    size_t dataOffset;

    static AsarArchive* open(const std::filesystem::path& path) {
        auto archive = new AsarArchive();
        archive->file.open(
            electrobun::windowsExtendedLengthPath(path), std::ios::binary);
        if (!archive->file.is_open()) {
            delete archive;
            return nullptr;
        }

        // Read header size (8 bytes, little-endian)
        uint64_t headerSize;
        archive->file.read(reinterpret_cast<char*>(&headerSize), 8);
        if (!archive->file || headerSize == 0 || headerSize > 100 * 1024 * 1024) {
            delete archive;
            return nullptr;
        }

        // Read JSON header
        std::string headerJson(headerSize, '\0');
        archive->file.read(&headerJson[0], headerSize);
        if (!archive->file) {
            delete archive;
            return nullptr;
        }

        // Parse JSON header (simple parser for ASAR format)
        if (!archive->parseHeader(headerJson)) {
            delete archive;
            return nullptr;
        }

        // Calculate data offset with 4-byte alignment padding
        size_t headerEnd = 8 + headerSize;
        size_t padding = (headerEnd % 4 == 0) ? 0 : (4 - headerEnd % 4);
        archive->dataOffset = headerEnd + padding;

        return archive;
    }

    std::vector<uint8_t> readFile(const std::string& path) {
        // Split path by '/'
        std::vector<std::string> segments;
        std::string segment;
        std::istringstream pathStream(path);
        while (std::getline(pathStream, segment, '/')) {
            if (!segment.empty()) segments.push_back(segment);
        }

        // Traverse directory structure
        std::map<std::string, std::variant<AsarFileEntry, AsarDirEntry>>* current = &root.files;
        for (size_t i = 0; i < segments.size(); i++) {
            auto it = current->find(segments[i]);
            if (it == current->end()) return {};

            if (i == segments.size() - 1) {
                // Last segment should be a file
                if (std::holds_alternative<AsarFileEntry>(it->second)) {
                    const auto& entry = std::get<AsarFileEntry>(it->second);

                    // Clear any error flags and seek to file data
                    file.clear();
                    file.seekg(dataOffset + entry.offset, std::ios::beg);

                    if (!file.good()) return {};

                    std::vector<uint8_t> buffer(entry.size);
                    file.read(reinterpret_cast<char*>(buffer.data()), entry.size);

                    if (!file.good()) return {};

                    return buffer;
                }
                return {};
            } else {
                // Intermediate segment should be a directory
                if (std::holds_alternative<AsarDirEntry>(it->second)) {
                    current = &std::get<AsarDirEntry>(it->second).files;
                } else {
                    return {};
                }
            }
        }

        return {};
    }

private:
    // Simple JSON parser specifically for ASAR header format
    bool parseHeader(const std::string& json) {
        size_t pos = json.find("\"files\"");
        if (pos == std::string::npos) return false;

        pos = json.find('{', pos);
        if (pos == std::string::npos) return false;

        return parseObject(json, pos, root.files);
    }

    bool parseObject(const std::string& json, size_t& pos, std::map<std::string, std::variant<AsarFileEntry, AsarDirEntry>>& map) {
        pos++; // skip opening {

        while (pos < json.size()) {
            // Skip whitespace
            while (pos < json.size() && std::isspace(json[pos])) pos++;

            if (pos >= json.size()) return false;
            if (json[pos] == '}') {
                pos++;
                return true;
            }
            if (json[pos] == ',') {
                pos++;
                continue;
            }

            // Parse key
            if (json[pos] != '"') return false;
            std::string key = parseString(json, pos);

            // Skip whitespace and colon
            while (pos < json.size() && (std::isspace(json[pos]) || json[pos] == ':')) pos++;

            // Parse value object
            if (json[pos] != '{') return false;
            size_t valueStart = pos;

            // Check if it's a file or directory by looking for "size" or "files"
            size_t checkPos = pos;
            int braceCount = 0;
            bool hasSize = false;
            bool hasFiles = false;

            while (checkPos < json.size()) {
                if (json[checkPos] == '{') braceCount++;
                if (json[checkPos] == '}') {
                    braceCount--;
                    if (braceCount == 0) break;
                }
                if (json.substr(checkPos, 6) == "\"size\"") hasSize = true;
                if (json.substr(checkPos, 7) == "\"files\"") hasFiles = true;
                checkPos++;
            }

            if (hasFiles) {
                // Directory
                AsarDirEntry dir;
                size_t filesPos = json.find("\"files\"", pos);
                filesPos = json.find('{', filesPos);
                if (!parseObject(json, filesPos, dir.files)) return false;
                map[key] = dir;

                // Skip to end of this object
                braceCount = 1;
                pos++;
                while (pos < json.size() && braceCount > 0) {
                    if (json[pos] == '{') braceCount++;
                    if (json[pos] == '}') braceCount--;
                    pos++;
                }
            } else if (hasSize) {
                // File
                AsarFileEntry entry;

                // Parse size
                size_t sizePos = json.find("\"size\"", pos);
                sizePos = json.find(':', sizePos) + 1;
                while (std::isspace(json[sizePos])) sizePos++;
                entry.size = std::stoul(json.substr(sizePos));

                // Parse offset
                size_t offsetPos = json.find("\"offset\"", pos);
                offsetPos = json.find('\"', offsetPos + 8) + 1;
                entry.offset = std::stoul(json.substr(offsetPos));

                map[key] = entry;

                // Skip to end of this object
                braceCount = 1;
                pos++;
                while (pos < json.size() && braceCount > 0) {
                    if (json[pos] == '{') braceCount++;
                    if (json[pos] == '}') braceCount--;
                    pos++;
                }
            }
        }

        return true;
    }

    std::string parseString(const std::string& json, size_t& pos) {
        pos++; // skip opening quote
        std::string result;
        while (pos < json.size() && json[pos] != '"') {
            if (json[pos] == '\\') {
                pos++;
                if (pos < json.size()) result += json[pos++];
            } else {
                result += json[pos++];
            }
        }
        pos++; // skip closing quote
        return result;
    }
};

// Global ASAR archive handle (lazy-loaded) with thread-safe initialization
static AsarArchive* g_asarArchive = nullptr;
static std::once_flag g_asarArchiveInitFlag;
static std::mutex g_asarReadMutex; // Mutex to protect ASAR read operations

// Export ASAR functions for launcher to use (compatible with libasar.dll API)
extern "C" __declspec(dllexport) void* asar_open(const char* path) {
    if (!path) return nullptr;
    std::wstring widePath;
    if (!electrobun::utf8ToWide(path, widePath)) return nullptr;
    AsarArchive* archive = AsarArchive::open(
        std::filesystem::path(widePath));
    return static_cast<void*>(archive);
}

extern "C" __declspec(dllexport) uint8_t* asar_read_file(void* archive, const char* path, uint64_t* size) {
    if (!archive) return nullptr;

    AsarArchive* asar = static_cast<AsarArchive*>(archive);
    std::vector<uint8_t> data = asar->readFile(std::string(path));

    if (data.empty()) {
        *size = 0;
        return nullptr;
    }

    *size = data.size();
    uint8_t* buffer = new uint8_t[data.size()];
    std::memcpy(buffer, data.data(), data.size());
    return buffer;
}

extern "C" __declspec(dllexport) void asar_free_buffer(uint8_t* buffer, uint64_t size) {
    if (buffer) {
        delete[] buffer;
    }
}

extern "C" __declspec(dllexport) void asar_close(void* archive) {
    if (archive) {
        AsarArchive* asar = static_cast<AsarArchive*>(archive);
        delete asar;
    }
}

// Push macro definitions to avoid conflicts with Windows headers
#pragma push_macro("GetNextSibling")
#pragma push_macro("GetFirstChild")
#undef GetNextSibling
#undef GetFirstChild

// CEF includes - always include for runtime detection
#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_browser.h"
#include "include/cef_command_line.h"
#include "include/cef_scheme.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_permission_handler.h"
#include "include/cef_dialog_handler.h"
#include "../shared/permissions_cef.h"
#include "../shared/partition_context.h"
#include "include/cef_download_handler.h"
#include "include/cef_task.h"
#include "include/views/cef_display.h"
#include "include/wrapper/cef_helpers.h"

// Restore macro definitions
#pragma pop_macro("GetFirstChild")
#pragma pop_macro("GetNextSibling")

// Link required Windows libraries
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "dcomp.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(linker, "/manifestdependency:\"type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"")


using namespace Microsoft::WRL;


// Ensure the exported functions have appropriate visibility
#define ELECTROBUN_EXPORT __declspec(dllexport)
#define WM_EXECUTE_SYNC_BLOCK (WM_USER + 1)
#define WM_EXECUTE_ASYNC_BLOCK (WM_USER + 2)
#define WM_DEVTOOLS_CREATE (WM_USER + 3)
#define WM_ELECTROBUN_NOTIFICATION (WM_USER + 4)

// Forward declarations
class AbstractView;
class ContainerView;
class NSWindow;
class NSStatusItem;
class WKWebView;
class MyScriptMessageHandlerWithReply;
class StatusItemTarget;

// CEF function declarations
ELECTROBUN_EXPORT bool isCEFAvailable();

// Type definitions to match macOS types
typedef double CGFloat;

// Function pointer type definitions are in shared/callbacks.h
// Platform-specific aliases
typedef void (*HandlePostMessageWin)(uint32_t webviewId, const char* message);
typedef void (*callAsyncJavascriptCompletionHandler)(const char *messageId, uint32_t webviewId, uint32_t hostWebviewId, const char *responseJSON);
typedef SnapshotCallback zigSnapshotCallback;
typedef StatusItemHandler ZigStatusItemHandler;

// Window classes implemented by this DLL must be registered and created with
// the DLL's HINSTANCE. The host executable's module handle identifies a
// different class namespace.
static HINSTANCE g_hInstanceDll = NULL;

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        g_hInstanceDll = instance;
    }
    return TRUE;
}

// Global map to store container views by window handle
static std::map<HWND, std::unique_ptr<ContainerView>> g_containerViews;
static GetMimeType g_getMimeType = nullptr;
static GetHTMLForWebviewSync g_getHTMLForWebviewSync = nullptr;

// Global variables for CEF cache path isolation
static std::string g_electrobunChannel = "";
static std::string g_electrobunIdentifier = "";
static std::string g_electrobunName = "";

// Webview content storage (replaces JSCallback approach)
static std::map<uint32_t, std::string> webviewHTMLContent;
static std::mutex webviewHTMLMutex;

// Forward declaration for AbstractView
class AbstractView;

// Browser views and WGPU views use independent ID allocators. This registry is
// browser-only so an equal WGPU ID cannot replace navigation state.
static std::map<uint32_t, AbstractView*> g_abstractViews;
static std::mutex g_abstractViewsMutex;

// Forward declaration for navigation rules helper (defined after AbstractView class)
bool checkNavigationRules(AbstractView* view, const std::string& url);

// Forward declarations for HTML content management
extern "C" ELECTROBUN_EXPORT const char* getWebviewHTMLContent(uint32_t webviewId);
extern "C" ELECTROBUN_EXPORT void setWebviewHTMLContent(uint32_t webviewId, const char* htmlContent);

// Global mutex to serialize webview creation
static std::mutex g_webviewCreationMutex;

// Global map to store preload scripts by browser ID (needs to be early for load handler)
static std::map<int, std::string> g_preloadScripts;

// Global map to track browser ID to webview ID mapping (for CEF scheme handler)
static std::map<int, uint32_t> browserToWebviewMap;
static std::mutex browserMapMutex;

// Global map to store CEFViews by container window handle (using void* to avoid forward declaration issues)
static std::map<HWND, void*> g_cefViews;
// Global map to store WebView2Views by container window handle (using void* to avoid forward declaration issues)
static std::map<HWND, void*> g_webview2Views;

// Global map to store pending CEF navigations for timing workaround - use browser ID instead of pointer
static std::map<int, std::string> g_pendingCefNavigations;
// Global map to store browser references by ID for safe access
static std::map<int, CefRefPtr<CefBrowser>> g_cefBrowsers;
// Global browser counter (moved from class static to global)
static int g_browser_count = 0;
// Global map to store pending URLs for async browser creation
static std::map<HWND, std::string> g_pendingUrls;

// Global WebView2 instances - moved to global scope
static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2> g_webview;

// Permission cache types and functions are in shared/permissions.h

static ComPtr<ICoreWebView2Environment> g_environment;  // Add global environment
static ComPtr<ICoreWebView2CustomSchemeRegistration> g_customScheme;
static ComPtr<ICoreWebView2EnvironmentOptions> g_envOptions;

static HMENU g_applicationMenu = NULL;
static std::unique_ptr<StatusItemTarget> g_appMenuTarget = nullptr;

// Global map to store menu item actions by menu ID
static std::map<UINT, std::string> g_menuItemActions;
static UINT g_nextMenuId = WM_USER + 1000;  // Start menu IDs from a safe range

// Accelerator table management for menu keyboard shortcuts
static std::vector<ACCEL> g_menuAccelerators;
static HACCEL g_hAccelTable = NULL;

// Transient notification icons share the dispatcher window, so each active
// balloon needs its own ID until the shell reports that it is done.
static std::atomic<UINT> g_nextNotificationId{1};

// Global state for custom window dragging
static BOOL g_isMovingWindow = FALSE;
static HWND g_targetWindow = NULL;
static POINT g_initialCursorPos = {};
static POINT g_initialWindowPos = {};
static std::map<HWND, bool> g_visibleOnAllWorkspaces;
static std::mutex g_visibleOnAllWorkspacesMutex;

// WebView positioning constants
static const int OFFSCREEN_OFFSET = -20000;

// DPI awareness must be selected before the first HWND is created. Electrobun
// is loaded into several different runtime executables, so setting it here is
// more reliable than depending on every runtime carrying the same manifest.
static void configurePerMonitorDpiAwareness() {
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    if (!user32) return;

    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is declared as ((HANDLE)-4).
    // Keep the dynamically-loaded calls compatible with older Windows SDKs.
    HANDLE perMonitorV2 = reinterpret_cast<HANDLE>(static_cast<INT_PTR>(-4));
    using SetProcessDpiAwarenessContextFn = BOOL(WINAPI*)(HANDLE);
    using SetThreadDpiAwarenessContextFn = HANDLE(WINAPI*)(HANDLE);

    bool processContextSelected = false;
    auto setProcessContext = reinterpret_cast<SetProcessDpiAwarenessContextFn>(
        GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
    if (setProcessContext) {
        SetLastError(ERROR_SUCCESS);
        processContextSelected = setProcessContext(perMonitorV2) != FALSE;
        // A manifest or an earlier host call may already have selected the
        // process context. Do not try to replace it with a weaker fallback.
        if (!processContextSelected && GetLastError() == ERROR_ACCESS_DENIED) {
            processContextSelected = true;
        }
    }

    if (!processContextSelected) {
        HMODULE shcore = LoadLibraryW(L"shcore.dll");
        if (shcore) {
            using SetProcessDpiAwarenessFn = HRESULT(WINAPI*)(int);
            auto setProcessAwareness = reinterpret_cast<SetProcessDpiAwarenessFn>(
                GetProcAddress(shcore, "SetProcessDpiAwareness"));
            if (setProcessAwareness) {
                // PROCESS_PER_MONITOR_DPI_AWARE
                HRESULT result = setProcessAwareness(2);
                processContextSelected = SUCCEEDED(result) || result == E_ACCESSDENIED;
            }
            FreeLibrary(shcore);
        }
    }

    if (!processContextSelected) {
        using SetProcessDPIAwareFn = BOOL(WINAPI*)();
        auto setProcessDpiAware = reinterpret_cast<SetProcessDPIAwareFn>(
            GetProcAddress(user32, "SetProcessDPIAware"));
        if (setProcessDpiAware) setProcessDpiAware();
    }

    // Mixed-awareness hosts can have selected a weaker process default before
    // loading Electrobun. Ensure the UI/event-loop thread itself uses PMv2.
    auto setThreadContext = reinterpret_cast<SetThreadDpiAwarenessContextFn>(
        GetProcAddress(user32, "SetThreadDpiAwarenessContext"));
    if (setThreadContext) setThreadContext(perMonitorV2);
}

// Remote DevTools port
static int g_remoteDebugPort = 0;

static bool IsPortAvailable(int port) {
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        return false;
    }
    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) {
        WSACleanup();
        return false;
    }
    int opt = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt));

    sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons((u_short)port);

    int result = bind(sock, (struct sockaddr*)&addr, sizeof(addr));
    closesocket(sock);
    WSACleanup();
    return result == 0;
}

// CEF global variables
static std::atomic<bool> g_cef_initialized{false};
static CefRefPtr<CefApp> g_cef_app;
static electrobun::ChromiumFlagConfig g_userChromiumFlags;
static electrobun::AutoGrantPermissionSet g_autoGrantPermissions;
static HANDLE g_job_object = nullptr;  // Job object to track all child processes

static void loadWebView2PermissionPolicy() {
    const std::wstring executablePath = electrobun::getModuleFileNameWide();
    if (executablePath.empty()) {
        g_autoGrantPermissions.clear();
        return;
    }

    const std::filesystem::path buildJsonPath =
        std::filesystem::path(executablePath).parent_path() /
        L".." / L"Resources" / L"build.json";
    g_autoGrantPermissions = electrobun::parseAutoGrantPermissions(
        electrobun::readFileToString(buildJsonPath));

    if (!g_autoGrantPermissions.empty()) {
        printf(
            "WebView2: Loaded %zu auto-grant permission(s) from build.json\n",
            g_autoGrantPermissions.size());
    }
}

static bool shouldAutoGrantWebView2Permission(
    COREWEBVIEW2_PERMISSION_KIND kind) {
    using electrobun::AutoGrantPermission;
    AutoGrantPermission permission;
    switch (kind) {
        case COREWEBVIEW2_PERMISSION_KIND_CAMERA:
            permission = AutoGrantPermission::camera;
            break;
        case COREWEBVIEW2_PERMISSION_KIND_MICROPHONE:
            permission = AutoGrantPermission::microphone;
            break;
        case COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION:
            permission = AutoGrantPermission::geolocation;
            break;
        case COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS:
            permission = AutoGrantPermission::notifications;
            break;
        default:
            return false;
    }
    return electrobun::hasAutoGrantPermission(
        g_autoGrantPermissions, permission);
}

// Quit/shutdown coordination
static QuitRequestedHandler g_quitRequestedHandler = nullptr;
static std::atomic<bool> g_shutdownComplete{false};
static std::atomic<bool> g_eventLoopStopping{false};
static std::atomic<bool> g_cefShutdownTimedOut{false};
static std::atomic<int> g_pendingCefBrowserCreations{0};
static bool g_cefShutdownStartedOnUI = false;
static DWORD g_mainThreadId = 0;
static std::atomic<HWND> g_cefPumpWindow{nullptr};
static constexpr UINT_PTR CEF_SHUTDOWN_TIMER_ID = 3;
static constexpr UINT CEF_SHUTDOWN_TIMEOUT_MS = 3000;
static constexpr int CEF_GRACEFUL_SHUTDOWN_WAIT_MS = 15000;

static std::mutex g_remoteDevToolsThreadsMutex;
static std::vector<std::thread> g_remoteDevToolsThreads;

static void trackRemoteDevToolsThread(std::thread worker) {
    std::lock_guard<std::mutex> lock(g_remoteDevToolsThreadsMutex);
    g_remoteDevToolsThreads.push_back(std::move(worker));
}

static void joinRemoteDevToolsThreads() {
    std::vector<std::thread> workers;
    {
        std::lock_guard<std::mutex> lock(g_remoteDevToolsThreadsMutex);
        workers.swap(g_remoteDevToolsThreads);
    }
    for (auto& worker : workers) {
        if (worker.joinable()) {
            worker.join();
        }
    }
}

static void quitCEFMessageLoopWhenDrained() {
    if (g_eventLoopStopping.load() &&
        g_cefBrowsers.empty() &&
        g_pendingCefBrowserCreations.load() == 0) {
        const HWND pumpWindow = g_cefPumpWindow.load();
        if (pumpWindow) {
            KillTimer(pumpWindow, CEF_SHUTDOWN_TIMER_ID);
        }
        std::cout << "[CEF] All browsers reached OnBeforeClose" << std::endl;
        PostQuitMessage(0);
    }
}

static void trackCEFBrowser(CefRefPtr<CefBrowser> browser) {
    if (!browser) return;
    const auto [it, inserted] = g_cefBrowsers.emplace(
        browser->GetIdentifier(), browser);
    (void)it;
    if (inserted) {
        ++g_browser_count;
    }
}

static void untrackCEFBrowser(CefRefPtr<CefBrowser> browser) {
    if (!browser) return;
    if (g_cefBrowsers.erase(browser->GetIdentifier()) != 0 &&
        g_browser_count > 0) {
        --g_browser_count;
    }
}

// Simple CEF App class for minimal implementation
// Hidden window message for CEF external message pump scheduling
#define WM_CEF_SCHEDULE_WORK (WM_USER + 100)

class ElectrobunCefApp : public CefApp, public CefBrowserProcessHandler {
public:
    CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
        return this;
    }

    void OnScheduleMessagePumpWork(int64_t delay_ms) override {
        // Called by CEF when it needs CefDoMessageLoopWork to be called.
        // With external_message_pump=true, CEF does NOT internally pump Windows messages,
        // preventing it from stealing WebView2 messages.
        if (!g_eventLoopStopping.load()) {
            const HWND pumpWindow = g_cefPumpWindow.load();
            if (!pumpWindow) return;
            if (delay_ms <= 0) {
                // Immediate work needed
                ::PostMessage(pumpWindow, WM_CEF_SCHEDULE_WORK, 0, 0);
            } else {
                // Schedule work after delay
                SetTimer(pumpWindow, 1, (UINT)delay_ms, nullptr);
            }
        }
    }

    void OnBeforeCommandLineProcessing(const CefString& process_type, CefRefPtr<CefCommandLine> command_line) override {
        // Windows default flags — can be overridden via chromiumFlags in config
        static const std::vector<electrobun::DefaultFlag> defaults = {
            {"disable-web-security", ""},
            {"disable-features=VizDisplayCompositor", ""},
            {"remote-allow-origins", "*"},
            {"allow-insecure-localhost", ""},
        };
        electrobun::applyDefaultFlags(defaults, g_userChromiumFlags.skip, command_line);

        // Apply user-defined chromium flags from build.json
        electrobun::applyChromiumFlags(g_userChromiumFlags, command_line);
    }

    void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
        // Register views:// scheme
        registrar->AddCustomScheme("views",
            CEF_SCHEME_OPTION_STANDARD |
            CEF_SCHEME_OPTION_CORS_ENABLED |
            CEF_SCHEME_OPTION_SECURE |
            CEF_SCHEME_OPTION_CSP_BYPASSING |
            CEF_SCHEME_OPTION_FETCH_ENABLED);
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunCefApp);
};

// Forward declaration for CEF client (needed for load handler)
class ElectrobunCefClient;

// CEF Load Handler for debugging navigation
class ElectrobunLoadHandler : public CefLoadHandler {
public:
    uint32_t webview_id_ = 0;
    WebviewEventHandler webview_event_handler_ = nullptr;
    CefRefPtr<ElectrobunCefClient> client_ = nullptr;

    ElectrobunLoadHandler() {}

    void SetWebviewId(uint32_t id) { webview_id_ = id; }
    void SetWebviewEventHandler(WebviewEventHandler handler) { webview_event_handler_ = handler; }
    void SetClient(CefRefPtr<ElectrobunCefClient> client) { client_ = client; }

    void OnLoadStart(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, TransitionType transition_type) override;
    void OnLoadEnd(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, int httpStatusCode) override;
    void OnLoadError(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, ErrorCode errorCode, const CefString& errorText, const CefString& failedUrl) override {
        std::cout << "[CEF] LoadError: " << static_cast<int>(errorCode)
                  << " - " << errorText.ToString()
                  << " for URL: " << failedUrl.ToString() << std::endl;
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunLoadHandler);
};

// Global map to store CEF clients for browser connection
static std::map<HWND, CefRefPtr<ElectrobunCefClient>> g_cefClients;

// Forward declaration for helper functions (defined after class definitions)
void SetBrowserOnClient(CefRefPtr<ElectrobunCefClient> client, CefRefPtr<CefBrowser> browser);
void SetBrowserOnCEFView(HWND parentWindow, CefRefPtr<CefBrowser> browser);
void SetWebViewOnWebView2View(HWND containerWindow, void* webview);

// CEF Life Span Handler for async browser creation
class ElectrobunLifeSpanHandler : public CefLifeSpanHandler {
public:
    void MarkInitialBrowserCreationPending() {
        bool expected = false;
        if (initial_browser_creation_pending_.compare_exchange_strong(
                expected, true)) {
            g_pendingCefBrowserCreations.fetch_add(1);
        }
    }

    void ResolveInitialBrowserCreationPending() {
        if (initial_browser_creation_pending_.exchange(false)) {
            g_pendingCefBrowserCreations.fetch_sub(1);
        }
    }

    void SetBrowserCreatedCallback(
        std::function<void(CefRefPtr<CefBrowser>)> callback) {
        std::lock_guard<std::mutex> lock(callback_mutex_);
        if (!owner_detached_.load()) {
            browser_created_callback_ = std::move(callback);
        }
    }

    void DetachOwnerCallback() {
        owner_detached_.store(true);
        std::lock_guard<std::mutex> lock(callback_mutex_);
        browser_created_callback_ = nullptr;
    }

    void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
        // Track every browser, including popups created by page content. The
        // shutdown barrier must not report drained while any CEF browser lives.
        trackCEFBrowser(browser);

        // CreateBrowser is asynchronous so native->runtime callbacks cannot
        // re-enter Bun before initWebview has returned and installed its native
        // pointer. Only the first browser created by this client resolves the
        // initial creation request; later popup browsers are tracked normally.
        ResolveInitialBrowserCreationPending();

        std::function<void(CefRefPtr<CefBrowser>)> callback;
        {
            std::lock_guard<std::mutex> lock(callback_mutex_);
            if (!owner_detached_.load()) {
                callback = std::move(browser_created_callback_);
            }
            browser_created_callback_ = nullptr;
        }

        if (g_eventLoopStopping.load() || owner_detached_.load()) {
            CefRefPtr<CefBrowserHost> host = browser->GetHost();
            if (host) {
                host->CloseBrowser(true);
            }
            quitCEFMessageLoopWhenDrained();
            return;
        }

        if (callback) {
            callback(browser);
        }
    }

    // DoClose is called when the browser window is about to close.
    // Return true for OOPIFs to prevent CEF from closing the parent window.
    // Return false only for the main/last browser when actually quitting the app.
    bool DoClose(CefRefPtr<CefBrowser> browser) override {
        std::cout << "[CEF] DoClose: Browser ID " << browser->GetIdentifier()
                  << ", browser_count=" << g_browser_count << std::endl;

        if (!g_eventLoopStopping.load()) {
            std::cout << "[CEF] DoClose: Returning true to preserve parent window" << std::endl;
            return true;
        }

        // During application shutdown WindowProc bypasses application close
        // callbacks and destroys the top-level owner. Returning false asks CEF
        // to send that final WM_CLOSE and complete its documented windowed-
        // browser close sequence.
        std::cout << "[CEF] DoClose: Returning false for final owner teardown" << std::endl;
        return false;
    }

    void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
        std::cout << "[CEF] OnBeforeClose: Browser ID " << browser->GetIdentifier() << " closing" << std::endl;

        // Remove browser from global tracking
        untrackCEFBrowser(browser);
        {
            std::lock_guard<std::mutex> lock(browserMapMutex);
            browserToWebviewMap.erase(browser->GetIdentifier());
        }

        std::cout << "[CEF] Remaining browsers: " << g_browser_count << std::endl;

        quitCEFMessageLoopWhenDrained();

        // Note: Do NOT quit the message loop here when browser count reaches 0.
        // OOPIFs are CEF browsers that can be removed while the main window stays open.
        // Window/app closing is handled separately by the window close handlers.
    }

private:
    std::mutex callback_mutex_;
    std::function<void(CefRefPtr<CefBrowser>)> browser_created_callback_;
    std::atomic<bool> initial_browser_creation_pending_{false};
    std::atomic<bool> owner_detached_{false};
    IMPLEMENT_REFCOUNTING(ElectrobunLifeSpanHandler);
};

// Forward declaration for DevTools callback
class ElectrobunCefClient;
typedef void (*RemoteDevToolsClosedCallback)(
    void* ctx, int target_id, bool browserClosed);
void RemoteDevToolsClosed(void* ctx, int target_id, bool browserClosed);
static constexpr UINT WM_DESTROY_DEVTOOLS_WINDOW = WM_APP + 0x31;

// Lightweight CefClient for the DevTools browser window
class RemoteDevToolsClient : public CefClient, public CefLifeSpanHandler {
public:
    RemoteDevToolsClient(RemoteDevToolsClosedCallback callback, void* ctx, int target_id)
        : callback_(callback), ctx_(ctx), target_id_(target_id) {}

    CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override {
        return this;
    }

    void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
        trackCEFBrowser(browser);
    }

    bool DoClose(CefRefPtr<CefBrowser> browser) override {
        // DevTools normally hides WM_CLOSE. Send an explicit hierarchy-
        // teardown message instead so OnBeforeClose is guaranteed to follow.
        if (browser && browser->GetHost()) {
            const HWND browserWindow = browser->GetHost()->GetWindowHandle();
            const HWND ownerWindow = browserWindow
                ? GetAncestor(browserWindow, GA_ROOT)
                : nullptr;
            if (ownerWindow) {
                PostMessageW(
                    ownerWindow, WM_DESTROY_DEVTOOLS_WINDOW, 0, 0);
            }
        }
        return true;
    }

    void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
        untrackCEFBrowser(browser);
        if (callback_) {
            callback_(ctx_, target_id_, true);
        }
        quitCEFMessageLoopWhenDrained();
    }

    void DetachCallback() {
        callback_ = nullptr;
        ctx_ = nullptr;
    }

private:
    RemoteDevToolsClosedCallback callback_ = nullptr;
    void* ctx_ = nullptr;
    int target_id_ = 0;
    IMPLEMENT_REFCOUNTING(RemoteDevToolsClient);
};

// DevTools window class and WndProc
struct DevToolsWindowContext {
    RemoteDevToolsClosedCallback close_callback = nullptr;
    void* ctx = nullptr;
    int target_id = 0;
    CefRefPtr<CefBrowser> browser;
};

static std::once_flag g_devtoolsClassRegistered;
static const wchar_t* DEVTOOLS_WINDOW_CLASS = L"ElectrobunDevToolsClass";

static LRESULT CALLBACK DevToolsWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    DevToolsWindowContext* dtCtx = nullptr;

    if (msg == WM_NCCREATE) {
        CREATESTRUCTW* cs = (CREATESTRUCTW*)lParam;
        dtCtx = (DevToolsWindowContext*)cs->lpCreateParams;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)dtCtx);
    } else {
        dtCtx = (DevToolsWindowContext*)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    }

    switch (msg) {
        case WM_DESTROY_DEVTOOLS_WINDOW:
            DestroyWindow(hwnd);
            return 0;

        case WM_CLOSE:
            if (g_eventLoopStopping.load()) {
                DestroyWindow(hwnd);
                return 0;
            }
            // Hide the window instead of destroying it to avoid CEF teardown issues
            ShowWindow(hwnd, SW_HIDE);
            if (dtCtx && dtCtx->close_callback) {
                dtCtx->close_callback(dtCtx->ctx, dtCtx->target_id, false);
            }
            return 0;

        case WM_SIZE:
            if (dtCtx && dtCtx->browser) {
                HWND browserHwnd = dtCtx->browser->GetHost()->GetWindowHandle();
                if (browserHwnd) {
                    RECT rect;
                    GetClientRect(hwnd, &rect);
                    SetWindowPos(browserHwnd, nullptr, 0, 0,
                                 rect.right - rect.left, rect.bottom - rect.top,
                                 SWP_NOZORDER);
                }
            }
            break;

        case WM_DESTROY:
            return 0;
    }

    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static void EnsureDevToolsWindowClassRegistered() {
    std::call_once(g_devtoolsClassRegistered, []() {
        WNDCLASSW wc = {};
        wc.lpfnWndProc = DevToolsWndProc;
        wc.hInstance = g_hInstanceDll;
        wc.lpszClassName = DEVTOOLS_WINDOW_CLASS;
        wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
        wc.hCursor = LoadCursorW(NULL, MAKEINTRESOURCEW(32512));
        wc.style = CS_HREDRAW | CS_VREDRAW;
        RegisterClassW(&wc);
    });
}

// Forward declarations for functions defined later in the file
std::string loadViewsFile(const std::string& path);
std::string getMimeTypeForFile(const std::string& path);

// CEF Resource Handler for views:// scheme (based on Mac implementation)
class ElectrobunSchemeHandler : public CefResourceHandler {
public:
    ElectrobunSchemeHandler(uint32_t webviewId)
        : webviewId_(webviewId), offset_(0), hasResponse_(false) {}

    bool Open(CefRefPtr<CefRequest> request, bool& handle_request, CefRefPtr<CefCallback> callback) override {
        handle_request = true;

        std::string url = request->GetURL();
        std::string path = normalizeViewsRelativePath(url);

        std::string content;
        // Check for internal/index.html (inline HTML content)
        if (path == "internal/index.html") {
            const char* htmlContent = getWebviewHTMLContent(webviewId_);
            if (htmlContent && strlen(htmlContent) > 0) {
                content = std::string(htmlContent);
                free((void*)htmlContent);
            } else {
                content = "<html><body><h1>No content set</h1></body></html>";
            }
        } else {
            content = loadViewsFile(path);
        }
        mimeType_ = getMimeTypeForFile(path);

        if (!content.empty()) {
            responseData_.assign(content.begin(), content.end());
            hasResponse_ = true;
        } else {
            hasResponse_ = false;
        }

        return hasResponse_;
    }

    void GetResponseHeaders(CefRefPtr<CefResponse> response, int64_t& response_length, CefString& redirectUrl) override {
        response->SetStatus(200);
        response->SetMimeType(mimeType_);
        response_length = static_cast<int64_t>(responseData_.size());
    }

    bool Read(void* data_out, int bytes_to_read, int& bytes_read, CefRefPtr<CefResourceReadCallback> callback) override {
        bytes_read = 0;
        if (!hasResponse_ || offset_ >= responseData_.size()) {
            return false;
        }
        size_t remaining = responseData_.size() - offset_;
        bytes_read = (bytes_to_read < static_cast<int>(remaining)) ? 
                     bytes_to_read : static_cast<int>(remaining);
        memcpy(data_out, responseData_.data() + offset_, bytes_read);
        offset_ += bytes_read;
        return true;
    }

    void Cancel() override {}

private:
    uint32_t webviewId_;
    std::string mimeType_;
    std::vector<char> responseData_;
    bool hasResponse_;
    size_t offset_;
    IMPLEMENT_REFCOUNTING(ElectrobunSchemeHandler);
};

// CEF Scheme Handler Factory
class ElectrobunSchemeHandlerFactory : public CefSchemeHandlerFactory {
public:
    CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> browser,
                                       CefRefPtr<CefFrame> frame,
                                       const CefString& scheme_name,
                                       CefRefPtr<CefRequest> request) override {
        // Get webview ID from browser ID
        uint32_t webviewId = 0;
        if (browser) {
            std::lock_guard<std::mutex> lock(browserMapMutex);
            int browserId = browser->GetIdentifier();
            auto it = browserToWebviewMap.find(browserId);
            if (it != browserToWebviewMap.end()) {
                webviewId = it->second;
            }
        }
        return new ElectrobunSchemeHandler(webviewId);
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunSchemeHandlerFactory);
};

// CEF Response Filter for script injection
class ElectrobunResponseFilter : public CefResponseFilter {
public:
    ElectrobunResponseFilter(const std::string& script) : script_(script) {}

    bool InitFilter() override {
        return true;
    }

    FilterStatus Filter(void* data_in, size_t data_in_size, size_t& data_in_read,
                       void* data_out, size_t data_out_size, size_t& data_out_written) override {
        // Read all input data
        if (data_in_size > 0) {
            data_buffer_.append(static_cast<char*>(data_in), data_in_size);
            data_in_read = data_in_size;
        } else {
            data_in_read = 0;
        }
        
        // If no input data (end of stream), process the accumulated data
        if (data_in_size == 0 && !processed_) {
            ProcessAccumulatedData();
            processed_ = true;
        }
        
        // Output processed data
        data_out_written = 0;
        if (processed_ && output_offset_ < processed_data_.size()) {
            size_t remaining = processed_data_.size() - output_offset_;
            size_t copy_size = (data_out_size < remaining) ? data_out_size : remaining;
            memcpy(data_out, processed_data_.data() + output_offset_, copy_size);
            output_offset_ += copy_size;
            data_out_written = copy_size;
        }
        
        // Return status based on whether we have more data to output
        if (data_in_size == 0 && output_offset_ >= processed_data_.size()) {
            return RESPONSE_FILTER_DONE;
        } else {
            return RESPONSE_FILTER_NEED_MORE_DATA;
        }
    }

    void ProcessAccumulatedData() {
        // Process accumulated data and inject script
        processed_data_ = data_buffer_;

        // Look for <head> tag and inject script right after it (as first element in head)
        // This ensures preload script executes before any other scripts in the page
        size_t head_pos = processed_data_.find("<head>");
        if (head_pos != std::string::npos && !script_.empty()) {
            // Insert after the <head> tag (head_pos + 6 to skip past "<head>")
            size_t insert_pos = head_pos + 6;
            std::string script_tag = "<script>" + script_ + "</script>";
            processed_data_.insert(insert_pos, script_tag);
        } else {
            // Fallback: try case-insensitive search for <head with attributes
            size_t head_start = processed_data_.find("<head");
            if (head_start != std::string::npos && !script_.empty()) {
                // Find the end of the opening <head...> tag
                size_t head_end = processed_data_.find(">", head_start);
                if (head_end != std::string::npos) {
                    size_t insert_pos = head_end + 1;
                    std::string script_tag = "<script>" + script_ + "</script>";
                    processed_data_.insert(insert_pos, script_tag);
                }
            }
        }
    }

private:
    std::string script_;
    std::string data_buffer_;
    std::string processed_data_;
    size_t output_offset_ = 0;
    bool processed_ = false;
    IMPLEMENT_REFCOUNTING(ElectrobunResponseFilter);
};

// Forward declaration for ElectrobunCefClient
class ElectrobunCefClient;

// CEF Resource Request Handler to inject preload scripts via response filter
class ElectrobunResourceRequestHandler : public CefResourceRequestHandler {
public:
    CefRefPtr<ElectrobunCefClient> client_ = nullptr;

    ElectrobunResourceRequestHandler(CefRefPtr<ElectrobunCefClient> client) : client_(client) {}

    // Response filter to inject preload scripts into HTML before parsing
    // This ensures scripts execute BEFORE any page JavaScript
    CefRefPtr<CefResponseFilter> GetResourceResponseFilter(
        CefRefPtr<CefBrowser> browser,
        CefRefPtr<CefFrame> frame,
        CefRefPtr<CefRequest> request,
        CefRefPtr<CefResponse> response) override;

    IMPLEMENT_REFCOUNTING(ElectrobunResourceRequestHandler);
};

// CEF Request Handler for views:// scheme support
class ElectrobunRequestHandler : public CefRequestHandler {
public:
    uint32_t webview_id_ = 0;
    WebviewEventHandler webview_event_handler_ = nullptr;
    AbstractView* abstract_view_ = nullptr;
    CefRefPtr<ElectrobunCefClient> client_ = nullptr;

    // Static debounce timestamp for ctrl+click handling
    static double lastCtrlClickTime;

    ElectrobunRequestHandler() {}

    void SetWebviewId(uint32_t id) { webview_id_ = id; }
    void SetWebviewEventHandler(WebviewEventHandler handler) { webview_event_handler_ = handler; }
    void SetAbstractView(AbstractView* view) { abstract_view_ = view; }
    void SetClient(CefRefPtr<ElectrobunCefClient> client) { client_ = client; }

    // Return resource request handler to enable response filtering
    CefRefPtr<CefResourceRequestHandler> GetResourceRequestHandler(
        CefRefPtr<CefBrowser> browser,
        CefRefPtr<CefFrame> frame,
        CefRefPtr<CefRequest> request,
        bool is_navigation,
        bool is_download,
        const CefString& request_initiator,
        bool& disable_default_handling) override {

        if (client_) {
            return new ElectrobunResourceRequestHandler(client_);
        }
        return nullptr;
    }

    // Handle navigation requests with Ctrl+click detection
    bool OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       CefRefPtr<CefRequest> request,
                       bool user_gesture,
                       bool is_redirect) override {
        std::string url = request->GetURL().ToString();

        // Check if Ctrl key is held
        SHORT ctrlState = GetKeyState(VK_CONTROL);
        bool isCtrlHeld = (ctrlState & 0x8000) != 0;

        printf("[CEF OnBeforeBrowse] url=%s user_gesture=%d is_redirect=%d ctrlState=0x%04X isCtrlHeld=%d hasHandler=%d webviewId=%u\n",
               url.c_str(), user_gesture, is_redirect, ctrlState, isCtrlHeld, webview_event_handler_ != nullptr, webview_id_);

        if (isCtrlHeld && !is_redirect && webview_event_handler_) {
            // Debounce: ignore ctrl+click navigations within 500ms
            auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count() / 1000.0;

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
                webview_event_handler_(webview_id_, _strdup("new-window-open"), _strdup(eventData.c_str()));
                return true;  // Cancel navigation
            } else {
                printf("[CEF OnBeforeBrowse] Debounced - too soon after last ctrl+click\n");
            }
        }

        // Check navigation rules synchronously from native-stored rules
        // Navigation is allowed by default
        bool shouldAllow = true;
        if (abstract_view_) {
            shouldAllow = checkNavigationRules(abstract_view_, url);
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
            webview_event_handler_(webview_id_, _strdup("will-navigate"), _strdup(eventData.c_str()));
        }

        return !shouldAllow;  // Return true to cancel navigation
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunRequestHandler);
};

// Initialize static debounce timestamp
double ElectrobunRequestHandler::lastCtrlClickTime = 0;

// CEF Context Menu Handler for devtools support
class ElectrobunContextMenuHandler : public CefContextMenuHandler {
public:
    ElectrobunContextMenuHandler() {}
    
    void OnBeforeContextMenu(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefFrame> frame,
                           CefRefPtr<CefContextMenuParams> params,
                           CefRefPtr<CefMenuModel> model) override {
        // Add "Inspect Element" menu item
        model->AddSeparator();
        model->AddItem(26501, "Inspect Element");
    }
    
    // Defined out-of-line after ElectrobunCefClient (needs full class definition)
    bool OnContextMenuCommand(CefRefPtr<CefBrowser> browser,
                            CefRefPtr<CefFrame> frame,
                            CefRefPtr<CefContextMenuParams> params,
                            int command_id,
                            EventFlags event_flags) override;

private:
    IMPLEMENT_REFCOUNTING(ElectrobunContextMenuHandler);
};

// CEF Permission Handler for user media and other permissions
class ElectrobunPermissionHandler : public CefPermissionHandler {
public:
    bool OnRequestMediaAccessPermission(
        CefRefPtr<CefBrowser> browser,
        CefRefPtr<CefFrame> frame,
        const CefString& requesting_origin,
        uint32_t requested_permissions,
        CefRefPtr<CefMediaAccessCallback> callback) override {
        
        std::string origin = requesting_origin.ToString();
        printf("CEF: Media access permission requested for %s (permissions: %u)\n", origin.c_str(), requested_permissions);

        // views:// is the app's own bundled-asset shell — always trusted, never prompt.
        if (origin.find("views://") == 0) {
            callback->Continue(requested_permissions);
            return true;
        }

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
        
        // Show Windows message box
        std::string message = "This page wants to access your camera and/or microphone.\n\nDo you want to allow this?";
        std::string title = "Camera & Microphone Access";
        
        int result = electrobun::messageBoxUtf8(
            nullptr,
            message,
            title,
            MB_YESNO | MB_ICONQUESTION | MB_TOPMOST
        );
        
        // Handle response and cache the decision
        if (result == IDYES) {
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
    
    bool OnShowPermissionPrompt(
        CefRefPtr<CefBrowser> browser,
        uint64_t prompt_id,
        const CefString& requesting_origin,
        uint32_t requested_permissions,
        CefRefPtr<CefPermissionPromptCallback> callback) override {
        
        std::string origin = requesting_origin.ToString();
        printf("CEF: Permission prompt requested for %s (permissions: %u)\n", origin.c_str(), requested_permissions);

        // views:// is the app's own bundled-asset shell — always trusted, never prompt.
        // This also covers Chromium's new Loopback/Local Network Access gate triggered
        // by the per-webview RPC websocket to ws://localhost:<port>.
        if (origin.find("views://") == 0) {
            callback->Continue(CEF_PERMISSION_RESULT_ACCEPT);
            return true;
        }

        // Handle different permission types
        PermissionType permType = PermissionType::OTHER;
        std::string message;
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
        } else {
            // Unrecognized permission type — name what's being requested instead of
            // a generic "additional permissions" dialog so the user can decide.
            message = "This page is requesting permission for: " +
                      electrobun::describeCefPermissions(requested_permissions) +
                      ".\n\nDo you want to allow this?";
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
        
        // Show Windows message box
        int result = electrobun::messageBoxUtf8(
            nullptr,
            message,
            title,
            MB_YESNO | MB_ICONQUESTION | MB_TOPMOST
        );
        
        // Handle response and cache the decision
        if (result == IDYES) {
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
    
    void OnDismissPermissionPrompt(
        CefRefPtr<CefBrowser> browser,
        uint64_t prompt_id,
        cef_permission_request_result_t result) override {
        
        printf("CEF: Permission prompt %I64u dismissed with result %d\n", prompt_id, result);
        // Optional: Handle prompt dismissal if needed
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunPermissionHandler);
};

// Helper functions for string conversion
std::wstring StringToWString(const std::string& str) {
    std::wstring result;
    if (!electrobun::utf8ToWide(str, result)) {
        return L"";
    }
    return result;
}

std::string WStringToString(const std::wstring& wstr) {
    std::string result;
    if (!electrobun::wideToUtf8(wstr, result)) {
        return "";
    }
    return result;
}

// CEF Dialog Handler for file dialogs
class ElectrobunDialogHandler : public CefDialogHandler {
public:
    bool OnFileDialog(CefRefPtr<CefBrowser> browser,
                      FileDialogMode mode,
                      const CefString& title,
                      const CefString& default_file_path,
                      const std::vector<CefString>& accept_filters,
                      const std::vector<CefString>& accept_extensions,
                      const std::vector<CefString>& accept_descriptions,
                      CefRefPtr<CefFileDialogCallback> callback) override {
        
        printf("CEF Windows: File dialog requested - mode: %d\n", static_cast<int>(mode));
        
        // Run file dialog on main thread using Windows native dialog
        HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        if (FAILED(hr)) {
            callback->Continue(std::vector<CefString>());
            return true;
        }
        
        IFileOpenDialog* pFileDialog = nullptr;
        hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_ALL, IID_IFileOpenDialog, (void**)&pFileDialog);
        if (FAILED(hr)) {
            CoUninitialize();
            callback->Continue(std::vector<CefString>());
            return true;
        }
        
        // Set dialog options based on mode
        DWORD dwFlags = 0;
        pFileDialog->GetOptions(&dwFlags);
        
        if (mode == FILE_DIALOG_OPEN_MULTIPLE) {
            dwFlags |= FOS_ALLOWMULTISELECT;
        } else if (mode == FILE_DIALOG_OPEN_FOLDER) {
            dwFlags |= FOS_PICKFOLDERS;
        }
        
        pFileDialog->SetOptions(dwFlags);
        
        // Set title if provided
        if (!title.empty()) {
            std::wstring wTitle = StringToWString(title.ToString());
            pFileDialog->SetTitle(wTitle.c_str());
        }
        
        // Set default file path if provided
        if (!default_file_path.empty()) {
            std::wstring wPath = StringToWString(default_file_path.ToString());
            
            IShellItem* pDefaultFolder = nullptr;
            hr = SHCreateItemFromParsingName(wPath.c_str(), nullptr, IID_IShellItem, (void**)&pDefaultFolder);
            if (SUCCEEDED(hr)) {
                if (mode == FILE_DIALOG_SAVE) {
                    pFileDialog->SetDefaultFolder(pDefaultFolder);
                } else {
                    pFileDialog->SetFolder(pDefaultFolder);
                }
                pDefaultFolder->Release();
            }
        }
        
        // Set file filters
        if (!accept_filters.empty()) {
            std::vector<COMDLG_FILTERSPEC> filterSpecs;
            std::vector<std::wstring> filterNames;
            std::vector<std::wstring> filterPatterns;
            filterNames.reserve(accept_filters.size());
            filterPatterns.reserve(accept_filters.size());
            
            for (const auto& filter : accept_filters) {
                std::wstring wFilter = StringToWString(filter.ToString());
                
                if (wFilter.find(L".") != 0 && wFilter != L"*" && wFilter != L"*.*") {
                    wFilter = L"." + wFilter;
                }
                
                std::wstring pattern = (wFilter == L"*" || wFilter == L"*.*") ? L"*.*" : L"*" + wFilter;
                std::wstring name = (wFilter == L"*" || wFilter == L"*.*") ? L"All files" : wFilter.substr(1) + L" files";
                
                filterNames.push_back(name);
                filterPatterns.push_back(pattern);
            }

            filterSpecs.reserve(filterNames.size());
            for (size_t index = 0; index < filterNames.size(); ++index) {
                COMDLG_FILTERSPEC spec;
                spec.pszName = filterNames[index].c_str();
                spec.pszSpec = filterPatterns[index].c_str();
                filterSpecs.push_back(spec);
            }
            
            if (!filterSpecs.empty()) {
                pFileDialog->SetFileTypes(static_cast<UINT>(filterSpecs.size()), filterSpecs.data());
            }
        }
        
        // Show the dialog
        hr = pFileDialog->Show(nullptr);
        
        std::vector<CefString> file_paths;
        if (SUCCEEDED(hr)) {
            if (mode == FILE_DIALOG_OPEN_MULTIPLE) {
                IShellItemArray* pShellItemArray = nullptr;
                hr = pFileDialog->GetResults(&pShellItemArray);
                if (SUCCEEDED(hr)) {
                    DWORD count = 0;
                    pShellItemArray->GetCount(&count);
                    
                    for (DWORD i = 0; i < count; i++) {
                        IShellItem* pShellItem = nullptr;
                        hr = pShellItemArray->GetItemAt(i, &pShellItem);
                        if (SUCCEEDED(hr)) {
                            PWSTR pszFilePath = nullptr;
                            hr = pShellItem->GetDisplayName(SIGDN_FILESYSPATH, &pszFilePath);
                            if (SUCCEEDED(hr)) {
                                // Convert wide string to regular string
                                std::string path = WStringToString(pszFilePath);
                                file_paths.push_back(path);
                                CoTaskMemFree(pszFilePath);
                            }
                            pShellItem->Release();
                        }
                    }
                    pShellItemArray->Release();
                }
            } else {
                IShellItem* pShellItem = nullptr;
                hr = pFileDialog->GetResult(&pShellItem);
                if (SUCCEEDED(hr)) {
                    PWSTR pszFilePath = nullptr;
                    hr = pShellItem->GetDisplayName(SIGDN_FILESYSPATH, &pszFilePath);
                    if (SUCCEEDED(hr)) {
                        // Convert wide string to regular string
                        std::string path = WStringToString(pszFilePath);
                        file_paths.push_back(path);
                        CoTaskMemFree(pszFilePath);
                    }
                    pShellItem->Release();
                }
            }
        }
        
        pFileDialog->Release();
        CoUninitialize();
        
        // Call the callback with results
        callback->Continue(file_paths);
        
        printf("CEF Windows: File dialog completed with %zu files selected\n", file_paths.size());
        return true; // We handled the dialog
    }
    
private:
    IMPLEMENT_REFCOUNTING(ElectrobunDialogHandler);
};

// CEF Download handler for Windows
class ElectrobunDownloadHandler : public CefDownloadHandler {
public:
    ElectrobunDownloadHandler() {}

    bool OnBeforeDownload(CefRefPtr<CefBrowser> browser,
                          CefRefPtr<CefDownloadItem> download_item,
                          const CefString& suggested_name,
                          CefRefPtr<CefBeforeDownloadCallback> callback) override {
        printf("CEF Windows: OnBeforeDownload for %s\n", suggested_name.ToString().c_str());

        // Get the Downloads folder using Windows API
        wchar_t* downloadsPath = nullptr;
        HRESULT hr = SHGetKnownFolderPath(FOLDERID_Downloads, 0, NULL, &downloadsPath);

        if (SUCCEEDED(hr) && downloadsPath) {
            std::string suggestedStr = suggested_name.ToString();
            std::wstring suggestedNameW;
            if (!electrobun::utf8ToWide(suggestedStr, suggestedNameW)) {
                printf("CEF Windows: Suggested download name is not valid UTF-8\n");
                suggestedNameW = L"download";
            }

            // Build the full destination path
            std::wstring destPath = downloadsPath;
            destPath += L"\\";
            destPath += suggestedNameW;

            // Handle duplicate filenames
            std::wstring basePath = destPath;
            std::wstring extension;
            size_t dotPos = destPath.find_last_of(L'.');
            size_t slashPos = destPath.find_last_of(L"\\/");
            if (dotPos != std::wstring::npos && (slashPos == std::wstring::npos || dotPos > slashPos)) {
                basePath = destPath.substr(0, dotPos);
                extension = destPath.substr(dotPos);
            }

            int counter = 1;
            while (GetFileAttributesW(destPath.c_str()) != INVALID_FILE_ATTRIBUTES) {
                destPath = basePath + L" (" + std::to_wstring(counter) + L")" + extension;
                counter++;
            }

            std::string utf8Path;
            if (!electrobun::wideToUtf8(destPath, utf8Path)) {
                printf("CEF Windows: Download path is not valid UTF-16\n");
                CoTaskMemFree(downloadsPath);
                callback->Continue("", false);
                return true;
            }

            printf("CEF Windows: Downloading to %s\n", utf8Path.c_str());

            // Continue the download to the specified path without showing a dialog
            callback->Continue(utf8Path, false);

            CoTaskMemFree(downloadsPath);
        } else {
            printf("CEF Windows: Could not get Downloads folder, using default behavior\n");
            callback->Continue("", false);
        }

        return true;  // We handled it
    }

    void OnDownloadUpdated(CefRefPtr<CefBrowser> browser,
                           CefRefPtr<CefDownloadItem> download_item,
                           CefRefPtr<CefDownloadItemCallback> callback) override {
        if (download_item->IsComplete()) {
            printf("CEF Windows: Download complete - %s\n", download_item->GetFullPath().ToString().c_str());
        } else if (download_item->IsCanceled()) {
            printf("CEF Windows: Download canceled\n");
        } else if (download_item->IsInProgress()) {
            int percent = download_item->GetPercentComplete();
            if (percent >= 0 && percent % 25 == 0) {  // Log at 0%, 25%, 50%, 75%, 100%
                printf("CEF Windows: Download progress %d%%\n", percent);
            }
        }
    }

private:
    IMPLEMENT_REFCOUNTING(ElectrobunDownloadHandler);
};

// OSR (Off-Screen Rendering) Window for transparent CEF windows
// Renders directly to the parent layered window
class OSRWindow {
public:
    OSRWindow(HWND parent, int x, int y, int width, int height)
        : parent_(parent), pixel_buffer_(nullptr),
          buffer_width_(0), buffer_height_(0), buffer_size_(0),
          browser_(nullptr) {
    }

    ~OSRWindow() {
        if (pixel_buffer_) {
            free(pixel_buffer_);
            pixel_buffer_ = nullptr;
        }
    }

    void SetBrowser(CefRefPtr<CefBrowser> browser) {
        browser_ = browser;
    }

    void UpdateBuffer(const void* buffer, int width, int height) {
        if (!buffer || width <= 0 || height <= 0 || !parent_) {
            return;
        }

        size_t required_size = (size_t)width * (size_t)height * 4; // BGRA

        // Reallocate buffer if needed
        if (buffer_size_ < required_size) {
            if (pixel_buffer_) {
                free(pixel_buffer_);
            }
            pixel_buffer_ = (unsigned char*)malloc(required_size);
            if (!pixel_buffer_) {
                buffer_size_ = 0;
                return;
            }
            buffer_size_ = required_size;
        }

        memcpy(pixel_buffer_, buffer, required_size);
        buffer_width_ = width;
        buffer_height_ = height;

        UpdateLayeredWindow();
    }

    void UpdateLayeredWindow() {
        if (!parent_ || !pixel_buffer_ || buffer_width_ == 0 || buffer_height_ == 0) {
            return;
        }

        HDC hdc = GetDC(NULL);
        HDC memDC = CreateCompatibleDC(hdc);

        BITMAPINFO bmi = {};
        bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bmi.bmiHeader.biWidth = buffer_width_;
        bmi.bmiHeader.biHeight = -buffer_height_; // Top-down DIB
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        void* bits = nullptr;
        HBITMAP hBitmap = CreateDIBSection(memDC, &bmi, DIB_RGB_COLORS, &bits, NULL, 0);

        if (hBitmap && bits) {
            // Copy pixel buffer to DIB section
            memcpy(bits, pixel_buffer_, buffer_size_);

            HBITMAP oldBitmap = (HBITMAP)SelectObject(memDC, hBitmap);

            POINT ptSrc = {0, 0};
            SIZE size = {buffer_width_, buffer_height_};
            BLENDFUNCTION blend = {};
            blend.BlendOp = AC_SRC_OVER;
            blend.SourceConstantAlpha = 255;
            blend.AlphaFormat = AC_SRC_ALPHA;

            // Get the window's current position for UpdateLayeredWindow
            RECT rect;
            GetWindowRect(parent_, &rect);
            POINT ptDest = {rect.left, rect.top};

            // Update the parent window's layer with the CEF-rendered content
            ::UpdateLayeredWindow(parent_, hdc, &ptDest, &size, memDC, &ptSrc, 0, &blend, ULW_ALPHA);

            SelectObject(memDC, oldBitmap);
            DeleteObject(hBitmap);
        }

        DeleteDC(memDC);
        ReleaseDC(NULL, hdc);
    }

    HWND GetHWND() const { return parent_; }

    UINT GetDpi() const {
        return electrobun::windowsDpiForWindow(parent_);
    }

    float GetDeviceScaleFactor() const {
        return static_cast<float>(GetDpi()) /
            electrobun::kWindowsDefaultDpi;
    }

    // Handle mouse events and forward to CEF
    void HandleMouseEvent(UINT message, WPARAM wParam, LPARAM lParam) {
        if (!browser_) {
            printf("OSRWindow: No browser set!\n");
            return;
        }

        CefRefPtr<CefBrowserHost> host = browser_->GetHost();
        if (!host) {
            printf("OSRWindow: No browser host!\n");
            return;
        }

        POINT clientPoint = {
            GET_X_LPARAM(lParam),
            GET_Y_LPARAM(lParam),
        };
        // Wheel messages carry screen coordinates; all other mouse messages
        // carry client coordinates. CEF expects view coordinates in DIPs.
        if (message == WM_MOUSEWHEEL) {
            ScreenToClient(parent_, &clientPoint);
        }

        const UINT dpi = GetDpi();
        CefMouseEvent mouse_event;
        mouse_event.x = electrobun::physicalToLogicalPixel(clientPoint.x, dpi);
        mouse_event.y = electrobun::physicalToLogicalPixel(clientPoint.y, dpi);

        // Set modifiers
        mouse_event.modifiers = 0;
        if (wParam & MK_CONTROL) mouse_event.modifiers |= EVENTFLAG_CONTROL_DOWN;
        if (wParam & MK_SHIFT) mouse_event.modifiers |= EVENTFLAG_SHIFT_DOWN;
        if (GetKeyState(VK_MENU) & 0x8000) mouse_event.modifiers |= EVENTFLAG_ALT_DOWN;

        switch (message) {
            case WM_MOUSEMOVE:
                host->SendMouseMoveEvent(mouse_event, false);
                break;

            case WM_LBUTTONDOWN:
            case WM_RBUTTONDOWN:
            case WM_MBUTTONDOWN: {
                CefBrowserHost::MouseButtonType btn_type =
                    (message == WM_LBUTTONDOWN) ? MBT_LEFT :
                    (message == WM_RBUTTONDOWN) ? MBT_RIGHT : MBT_MIDDLE;

                printf("OSRWindow: Sending click at (%d, %d)\n", mouse_event.x, mouse_event.y);

                host->SendMouseClickEvent(mouse_event, btn_type, false, 1);
                break;
            }

            case WM_LBUTTONUP:
            case WM_RBUTTONUP:
            case WM_MBUTTONUP: {
                CefBrowserHost::MouseButtonType btn_type =
                    (message == WM_LBUTTONUP) ? MBT_LEFT :
                    (message == WM_RBUTTONUP) ? MBT_RIGHT : MBT_MIDDLE;
                host->SendMouseClickEvent(mouse_event, btn_type, true, 1);
                break;
            }

            case WM_MOUSEWHEEL: {
                int delta = GET_WHEEL_DELTA_WPARAM(wParam);
                host->SendMouseWheelEvent(mouse_event, 0, delta);
                break;
            }
        }
    }

    // Handle keyboard events and forward to CEF
    void HandleKeyEvent(UINT message, WPARAM wParam, LPARAM lParam) {
        if (!browser_) return;

        CefRefPtr<CefBrowserHost> host = browser_->GetHost();
        if (!host) return;

        CefKeyEvent key_event;
        key_event.windows_key_code = (int)wParam;
        key_event.native_key_code = (int)lParam;
        key_event.is_system_key = (message == WM_SYSCHAR || message == WM_SYSKEYDOWN || message == WM_SYSKEYUP);

        if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) {
            key_event.type = KEYEVENT_RAWKEYDOWN;
        } else if (message == WM_KEYUP || message == WM_SYSKEYUP) {
            key_event.type = KEYEVENT_KEYUP;
        } else if (message == WM_CHAR || message == WM_SYSCHAR) {
            key_event.type = KEYEVENT_CHAR;
        }

        // Set modifiers
        key_event.modifiers = 0;
        if (GetKeyState(VK_SHIFT) & 0x8000) key_event.modifiers |= EVENTFLAG_SHIFT_DOWN;
        if (GetKeyState(VK_CONTROL) & 0x8000) key_event.modifiers |= EVENTFLAG_CONTROL_DOWN;
        if (GetKeyState(VK_MENU) & 0x8000) key_event.modifiers |= EVENTFLAG_ALT_DOWN;

        host->SendKeyEvent(key_event);
    }

private:
    HWND parent_;
    unsigned char* pixel_buffer_;
    int buffer_width_;
    int buffer_height_;
    size_t buffer_size_;
    CefRefPtr<CefBrowser> browser_;
};

// CEF Render Handler for off-screen rendering (OSR) mode
class ElectrobunRenderHandler : public CefRenderHandler {
public:
    ElectrobunRenderHandler()
        : view_width_pixels_(800), view_height_pixels_(600), osr_window_(nullptr) {}

    void SetOSRWindow(OSRWindow* window) {
        osr_window_ = window;
    }

    void SetViewSize(int width, int height) {
        view_width_pixels_ = width;
        view_height_pixels_ = height;
    }

    // CefRenderHandler methods
    void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect& rect) override {
        const UINT dpi = osr_window_
            ? osr_window_->GetDpi()
            : electrobun::kWindowsDefaultDpi;
        rect.x = 0;
        rect.y = 0;
        rect.width = std::max(1L, electrobun::physicalToLogicalSize(
            view_width_pixels_ > 0 ? view_width_pixels_ : 800, dpi));
        rect.height = std::max(1L, electrobun::physicalToLogicalSize(
            view_height_pixels_ > 0 ? view_height_pixels_ : 600, dpi));
    }

    bool GetRootScreenRect(
        CefRefPtr<CefBrowser> browser,
        CefRect& rect
    ) override {
        if (!osr_window_ || !IsWindow(osr_window_->GetHWND())) return false;

        RECT physical = {};
        if (!GetWindowRect(osr_window_->GetHWND(), &physical)) return false;
        const CefRect pixelRect(
            physical.left,
            physical.top,
            physical.right - physical.left,
            physical.bottom - physical.top);
        rect = CefDisplay::ConvertScreenRectFromPixels(pixelRect);
        return true;
    }

    bool GetScreenPoint(
        CefRefPtr<CefBrowser> browser,
        int viewX,
        int viewY,
        int& screenX,
        int& screenY
    ) override {
        if (!osr_window_ || !IsWindow(osr_window_->GetHWND())) return false;

        const UINT dpi = osr_window_->GetDpi();
        POINT point = {
            electrobun::logicalToPhysicalPixel(viewX, dpi),
            electrobun::logicalToPhysicalPixel(viewY, dpi),
        };
        if (!ClientToScreen(osr_window_->GetHWND(), &point)) return false;
        screenX = point.x;
        screenY = point.y;
        return true;
    }

    bool GetScreenInfo(
        CefRefPtr<CefBrowser> browser,
        CefScreenInfo& screenInfo
    ) override {
        if (!osr_window_ || !IsWindow(osr_window_->GetHWND())) return false;

        RECT physicalRoot = {};
        if (!GetWindowRect(osr_window_->GetHWND(), &physicalRoot)) return false;
        const CefRect pixelRoot(
            physicalRoot.left,
            physicalRoot.top,
            physicalRoot.right - physicalRoot.left,
            physicalRoot.bottom - physicalRoot.top);
        CefRefPtr<CefDisplay> display =
            CefDisplay::GetDisplayMatchingBounds(pixelRoot, true);
        if (!display) return false;

        screenInfo.device_scale_factor = display->GetDeviceScaleFactor();
        screenInfo.depth = 32;
        screenInfo.depth_per_component = 8;
        screenInfo.is_monochrome = false;
        screenInfo.rect = display->GetBounds();
        screenInfo.available_rect = display->GetWorkArea();
        return true;
    }

    void OnPaint(CefRefPtr<CefBrowser> browser,
                 PaintElementType type,
                 const RectList& dirtyRects,
                 const void* buffer,
                 int width,
                 int height) override;

private:
    int view_width_pixels_;
    int view_height_pixels_;
    OSRWindow* osr_window_;

    IMPLEMENT_REFCOUNTING(ElectrobunRenderHandler);
};

// Forward declaration
void handleApplicationMenuSelection(UINT menuId);

// CEF Keyboard Handler for menu accelerators
class ElectrobunKeyboardHandler : public CefKeyboardHandler {
public:
    // Defined out-of-line after ElectrobunCefClient (needs full class definition)
    bool OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                      const CefKeyEvent& event,
                      CefEventHandle os_event,
                      bool* is_keyboard_shortcut) override;

private:
    IMPLEMENT_REFCOUNTING(ElectrobunKeyboardHandler);
};

// CEF Client class with load and life span handlers
class ElectrobunCefClient : public CefClient, public CefDisplayHandler {
public:
    WebviewEventHandler webview_event_handler_ = nullptr;

    ElectrobunCefClient(uint32_t webviewId,
                       HandlePostMessage eventBridgeHandler,
                       HandlePostMessage bunBridgeHandler,
                       HandlePostMessage internalBridgeHandler,
                       bool sandbox)
        : webview_id_(webviewId),
          event_bridge_handler_(eventBridgeHandler),
          bun_bridge_handler_(bunBridgeHandler),
          webview_tag_handler_(internalBridgeHandler),
          is_sandboxed_(sandbox),
          osr_enabled_(false) {
        m_loadHandler = new ElectrobunLoadHandler();
        m_loadHandler->SetClient(this); // Set client reference for load handler
        m_lifeSpanHandler = new ElectrobunLifeSpanHandler();
        m_requestHandler = new ElectrobunRequestHandler();
        m_requestHandler->SetWebviewId(webviewId);
        m_requestHandler->SetClient(this); // Set client reference for response filter
        m_contextMenuHandler = new ElectrobunContextMenuHandler();
        m_permissionHandler = new ElectrobunPermissionHandler();
        m_dialogHandler = new ElectrobunDialogHandler();
        m_downloadHandler = new ElectrobunDownloadHandler();
        m_keyboardHandler = new ElectrobunKeyboardHandler();
        m_renderHandler = nullptr; // Created only when OSR is enabled
    }

    void EnableOSR(int width, int height) {
        osr_enabled_ = true;
        m_renderHandler = new ElectrobunRenderHandler();
        m_renderHandler->SetViewSize(width, height);
    }

    void SetOSRWindow(OSRWindow* window) {
        if (m_renderHandler) {
            m_renderHandler->SetOSRWindow(window);
        }
    }

    void SetOSRViewSize(int width, int height) {
        if (m_renderHandler && width > 0 && height > 0) {
            m_renderHandler->SetViewSize(width, height);
        }
    }

    void ClearOSRWindow() {
        if (m_renderHandler) {
            m_renderHandler->SetOSRWindow(nullptr);
        }
    }

    bool IsOSREnabled() const {
        return osr_enabled_;
    }

    void SetWebviewEventHandler(WebviewEventHandler handler) {
        webview_event_handler_ = handler;
        if (m_requestHandler) {
            m_requestHandler->SetWebviewEventHandler(handler);
        }
        if (m_loadHandler) {
            m_loadHandler->SetWebviewEventHandler(handler);
            m_loadHandler->SetWebviewId(webview_id_);
        }
    }

    void SetAbstractView(AbstractView* view) {
        if (m_requestHandler) {
            m_requestHandler->SetAbstractView(view);
        }
    }

    void AddPreloadScript(const std::string& script) {
        electrobun_script_ = script;
    }

    void UpdateCustomPreloadScript(const std::string& script) {
        custom_script_ = script;
    }
    
    CefRefPtr<CefLoadHandler> GetLoadHandler() override {
        return m_loadHandler;
    }
    
    CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override {
        return m_lifeSpanHandler;
    }
    
    CefRefPtr<CefRequestHandler> GetRequestHandler() override {
        return m_requestHandler;
    }
    
    CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override {
        return m_contextMenuHandler;
    }
    
    CefRefPtr<CefPermissionHandler> GetPermissionHandler() override {
        return m_permissionHandler;
    }
    
    CefRefPtr<CefDialogHandler> GetDialogHandler() override {
        return m_dialogHandler;
    }

    CefRefPtr<CefDownloadHandler> GetDownloadHandler() override {
        return m_downloadHandler;
    }

    CefRefPtr<CefRenderHandler> GetRenderHandler() override {
        return m_renderHandler;
    }

    CefRefPtr<CefKeyboardHandler> GetKeyboardHandler() override {
        return m_keyboardHandler;
    }

    CefRefPtr<CefDisplayHandler> GetDisplayHandler() override {
        return this;
    }

    bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                 CefRefPtr<CefFrame> frame,
                                 CefProcessId source_process,
                                 CefRefPtr<CefProcessMessage> message) override {
        std::string messageName = message->GetName().ToString();
        std::string messageContent = message->GetArgumentList()->GetString(0).ToString();
        
        // eventBridge - event-only bridge (always process for all webviews, including sandboxed)
        if (messageName == "EventBridgeMessage") {
            if (event_bridge_handler_) {
                event_bridge_handler_(webview_id_, messageContent.c_str());
            }
            return true;
        }
        // bunBridge and internalBridge - RPC bridges (only for non-sandboxed webviews)
        else if (!is_sandboxed_) {
            if (messageName == "BunBridgeMessage") {
                if (bun_bridge_handler_) {
                    bun_bridge_handler_(webview_id_, messageContent.c_str());
                }
                return true;
            } else if (messageName == "internalMessage") {
                if (webview_tag_handler_) {
                    webview_tag_handler_(webview_id_, messageContent.c_str());
                }
                return true;
            }
        }

        return false;
    }


    std::string GetCombinedScript() const {
        // Inject webviewId into global scope before other scripts
        std::string combined_script = "window.webviewId = " + std::to_string(webview_id_) + ";\n";
        combined_script += electrobun_script_;
        if (!custom_script_.empty()) {
            combined_script += "\n" + custom_script_;
        }
        return combined_script;
    }

    void SetBrowser(CefRefPtr<CefBrowser> browser) {
        browser_ = browser;
        // Don't execute scripts here - they should execute on each navigation
    }

    void MarkInitialBrowserCreationPending() {
        if (m_lifeSpanHandler) {
            m_lifeSpanHandler->MarkInitialBrowserCreationPending();
        }
    }

    void ResolveInitialBrowserCreationPending() {
        if (m_lifeSpanHandler) {
            m_lifeSpanHandler->ResolveInitialBrowserCreationPending();
        }
    }

    void SetBrowserCreatedCallback(
        std::function<void(CefRefPtr<CefBrowser>)> callback) {
        if (m_lifeSpanHandler) {
            m_lifeSpanHandler->SetBrowserCreatedCallback(
                std::move(callback));
        }
    }

    void ExecutePreloadScripts() {
        std::string script = GetCombinedScript();
        if (!script.empty() && browser_ && browser_->GetMainFrame()) {
            browser_->GetMainFrame()->ExecuteJavaScript(script, "", 0);
        }
    }

    // Track page title for DevTools target matching
    void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) override {
        if (browser && browser->GetMainFrame()) {
            last_title_ = title.ToString();
        }
    }

    bool CanCreateRemoteDevTools() const {
        return !devtools_stopping_.load() && !g_eventLoopStopping.load();
    }

    // Open remote DevTools frontend for a specific browser (including OOPIFs)
    void OpenRemoteDevToolsFrontend(CefRefPtr<CefBrowser> browser) {
        if (!CanCreateRemoteDevTools() || !browser || !browser->GetHost()) return;
        if (g_remoteDebugPort == 0) {
            std::cout << "[CEF] Remote DevTools unavailable because remote debugging is disabled"
                      << std::endl;
            return;
        }

        int target_id = browser->GetIdentifier();

        // If already open, bring to front
        auto it = devtools_hosts_.find(target_id);
        if (it != devtools_hosts_.end() && it->second.is_open && it->second.window) {
            ShowWindow(it->second.window, SW_SHOW);
            SetForegroundWindow(it->second.window);
            return;
        }

        // Get the browser's URL and title for matching against /json targets
        std::string targetUrl;
        if (browser->GetMainFrame()) {
            targetUrl = browser->GetMainFrame()->GetURL().ToString();
        }
        std::string targetTitle = last_title_;
        int port = g_remoteDebugPort;

        // Keep ref to self for the background thread
        CefRefPtr<ElectrobunCefClient> self(this);

        // Fetch /json on a tracked background thread. Shutdown joins these
        // workers before CEF references are released.
        trackRemoteDevToolsThread(std::thread(
            [self, target_id, targetUrl, targetTitle, port]() {
            // WinHTTP synchronous GET to http://127.0.0.1:{port}/json
            HINTERNET hSession = WinHttpOpen(L"Electrobun/DevTools",
                                              WINHTTP_ACCESS_TYPE_NO_PROXY,
                                              WINHTTP_NO_PROXY_NAME,
                                              WINHTTP_NO_PROXY_BYPASS, 0);
            if (!hSession) return;
            WinHttpSetTimeouts(hSession, 1000, 1000, 1000, 1000);

            wchar_t hostStr[64];
            swprintf_s(hostStr, L"127.0.0.1");
            HINTERNET hConnect = WinHttpConnect(hSession, hostStr, (INTERNET_PORT)port, 0);
            if (!hConnect) { WinHttpCloseHandle(hSession); return; }

            HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", L"/json",
                                                     nullptr, WINHTTP_NO_REFERER,
                                                     WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
            if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return; }

            BOOL bResults = WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                                WINHTTP_NO_REQUEST_DATA, 0, 0, 0);
            if (!bResults) { WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return; }

            bResults = WinHttpReceiveResponse(hRequest, nullptr);
            if (!bResults) { WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return; }

            // Read full response body
            std::string jsonBody;
            DWORD dwSize = 0;
            DWORD dwDownloaded = 0;
            do {
                dwSize = 0;
                WinHttpQueryDataAvailable(hRequest, &dwSize);
                if (dwSize == 0) break;

                std::vector<char> buf(dwSize + 1, 0);
                WinHttpReadData(hRequest, buf.data(), dwSize, &dwDownloaded);
                jsonBody.append(buf.data(), dwDownloaded);
            } while (dwSize > 0);

            WinHttpCloseHandle(hRequest);
            WinHttpCloseHandle(hConnect);
            WinHttpCloseHandle(hSession);

            if (jsonBody.empty()) return;

            // Simple JSON parsing for the /json array response.
            // Each target object has "url", "title", "webSocketDebuggerUrl" fields.
            // Find the target matching our browser's URL or title.

            // Parse JSON array - find objects and extract fields
            struct JsonTarget {
                std::string url;
                std::string title;
                std::string wsUrl;
            };
            std::vector<JsonTarget> targets;

            // Simple parser: split by objects in the array
            size_t pos = 0;
            while ((pos = jsonBody.find('{', pos)) != std::string::npos) {
                size_t end = jsonBody.find('}', pos);
                if (end == std::string::npos) break;

                std::string obj = jsonBody.substr(pos, end - pos + 1);
                JsonTarget t;

                // Extract "url" field
                auto extractField = [&obj](const std::string& fieldName) -> std::string {
                    std::string key = "\"" + fieldName + "\"";
                    size_t kp = obj.find(key);
                    if (kp == std::string::npos) return "";
                    size_t colon = obj.find(':', kp + key.length());
                    if (colon == std::string::npos) return "";
                    size_t qStart = obj.find('"', colon + 1);
                    if (qStart == std::string::npos) return "";
                    size_t qEnd = obj.find('"', qStart + 1);
                    if (qEnd == std::string::npos) return "";
                    return obj.substr(qStart + 1, qEnd - qStart - 1);
                };

                t.url = extractField("url");
                t.title = extractField("title");
                t.wsUrl = extractField("webSocketDebuggerUrl");
                targets.push_back(t);

                pos = end + 1;
            }

            if (targets.empty()) return;

            // Match target by URL and/or title
            const JsonTarget* selected = nullptr;
            for (const auto& t : targets) {
                bool urlMatch = !targetUrl.empty() && t.url == targetUrl;
                bool titleMatch = !targetTitle.empty() && t.title == targetTitle;

                if ((!targetUrl.empty() && !targetTitle.empty() && urlMatch && titleMatch) ||
                    (!targetUrl.empty() && urlMatch) ||
                    (!targetTitle.empty() && titleMatch)) {
                    selected = &t;
                    break;
                }
            }
            if (!selected) {
                selected = &targets[0];
            }

            if (selected->wsUrl.empty()) return;

            // Build the DevTools frontend URL
            // Strip ws:// prefix from the WebSocket URL
            std::string wsParam = selected->wsUrl;
            if (wsParam.substr(0, 5) == "ws://") {
                wsParam = wsParam.substr(5);
            }

            std::string baseUrl = "http://127.0.0.1:" + std::to_string(port);
            std::string finalUrl = baseUrl + "/devtools/inspector.html?ws=" + wsParam + "&dockSide=undocked";

            // Post back to the UI thread via CefPostTask
            class CreateDevToolsTask : public CefTask {
            public:
                CreateDevToolsTask(CefRefPtr<ElectrobunCefClient> client, int tid, const std::string& url)
                    : client_(client), target_id_(tid), url_(url) {}
                void Execute() override {
                    if (client_->CanCreateRemoteDevTools()) {
                        client_->CreateRemoteDevToolsWindow(target_id_, url_);
                    }
                }
            private:
                CefRefPtr<ElectrobunCefClient> client_;
                int target_id_;
                std::string url_;
                IMPLEMENT_REFCOUNTING(CreateDevToolsTask);
            };
            if (self->CanCreateRemoteDevTools()) {
                CefPostTask(
                    TID_UI,
                    new CreateDevToolsTask(self, target_id, finalUrl));
            }

        }));
    }

    // Create or reuse a DevTools window for a specific target
    void CreateRemoteDevToolsWindow(int target_id, const std::string& url) {
        if (!CanCreateRemoteDevTools()) return;
        EnsureDevToolsWindowClassRegistered();

        DevToolsHost& host = devtools_hosts_[target_id];

        if (!host.window) {
            host.dt_ctx = new DevToolsWindowContext();
            host.dt_ctx->close_callback = RemoteDevToolsClosed;
            host.dt_ctx->ctx = this;
            host.dt_ctx->target_id = target_id;

            host.window = CreateWindowExW(
                0,
                DEVTOOLS_WINDOW_CLASS,
                L"DevTools",
                WS_OVERLAPPEDWINDOW,
                CW_USEDEFAULT, CW_USEDEFAULT, 1100, 800,
                nullptr,  // No parent - standalone window
                nullptr,
                g_hInstanceDll,
                host.dt_ctx);
        }

        ShowWindow(host.window, SW_SHOW);
        SetForegroundWindow(host.window);
        host.is_open = true;

        if (!host.client) {
            host.client = new RemoteDevToolsClient(RemoteDevToolsClosed, this, target_id);
        }

        if (host.browser) {
            // Reuse existing DevTools browser, just navigate to the new URL
            host.browser->GetMainFrame()->LoadURL(CefString(url));
            return;
        }

        // Create a new CEF browser inside the DevTools window
        RECT rect;
        GetClientRect(host.window, &rect);
        CefRect cefRect(0, 0, rect.right - rect.left, rect.bottom - rect.top);

        CefWindowInfo windowInfo;
        windowInfo.runtime_style = CEF_RUNTIME_STYLE_ALLOY;
        windowInfo.SetAsChild((CefWindowHandle)host.window, cefRect);

        CefBrowserSettings settings;
        host.browser = CefBrowserHost::CreateBrowserSync(
            windowInfo,
            host.client,
            CefString(url),
            settings,
            nullptr,
            nullptr);

        // Store the browser on the window context for WM_SIZE handling
        if (host.dt_ctx) {
            host.dt_ctx->browser = host.browser;
        }

        host.is_open = true;
    }

    void OnRemoteDevToolsClosed(int target_id, bool browserClosed) {
        auto it = devtools_hosts_.find(target_id);
        if (it == devtools_hosts_.end()) return;
        DevToolsHost& host = it->second;
        host.is_open = false;
        if (host.window) {
            ShowWindow(host.window, SW_HIDE);
        }
        if (browserClosed) {
            host.browser = nullptr;
            host.window = nullptr;
            if (host.dt_ctx) {
                host.dt_ctx->browser = nullptr;
            }
            host.client = nullptr;
        }
    }

    bool IsDevToolsOpen(int target_id) {
        auto it = devtools_hosts_.find(target_id);
        return it != devtools_hosts_.end() && it->second.is_open;
    }

    void PrepareForBrowserClose() {
        devtools_stopping_.store(true);
        if (m_lifeSpanHandler) {
            m_lifeSpanHandler->DetachOwnerCallback();
        }
        ClearOSRWindow();
        browser_ = nullptr;
        if (m_loadHandler) {
            m_loadHandler->SetClient(nullptr);
        }
        if (m_requestHandler) {
            m_requestHandler->SetClient(nullptr);
            m_requestHandler->SetAbstractView(nullptr);
        }

        // DevTools browsers have their own life-span handler and are part of
        // the same shutdown barrier as application browsers.
        for (auto& [target_id, host] : devtools_hosts_) {
            (void)target_id;
            if (host.client) {
                host.client->DetachCallback();
            }
            if (host.dt_ctx) {
                host.dt_ctx->close_callback = nullptr;
                host.dt_ctx->ctx = nullptr;
            }
            if (host.browser && !g_eventLoopStopping.load()) {
                CefRefPtr<CefBrowserHost> browserHost = host.browser->GetHost();
                if (browserHost) {
                    browserHost->CloseBrowser(true);
                }
            }
            host.browser = nullptr;
            if (host.dt_ctx) {
                host.dt_ctx->browser = nullptr;
            }
            host.client = nullptr;
        }
    }

    // Set load-end callback for deferred operations (like applying transparency after page load)
    void SetLoadEndCallback(std::function<void()> callback) {
        load_end_callback_ = callback;
    }

    // Called by load handler when page load completes
    void OnLoadEnd() {
        if (load_end_callback_) {
            load_end_callback_();
        }
    }

private:
    uint32_t webview_id_;
    HandlePostMessage event_bridge_handler_;
    HandlePostMessage bun_bridge_handler_;
    HandlePostMessage webview_tag_handler_;
    bool is_sandboxed_;
    std::string electrobun_script_;
    std::string custom_script_;
    CefRefPtr<CefBrowser> browser_;
    CefRefPtr<ElectrobunLoadHandler> m_loadHandler;
    CefRefPtr<ElectrobunLifeSpanHandler> m_lifeSpanHandler;
    CefRefPtr<ElectrobunRequestHandler> m_requestHandler;
    CefRefPtr<ElectrobunContextMenuHandler> m_contextMenuHandler;
    CefRefPtr<ElectrobunPermissionHandler> m_permissionHandler;
    CefRefPtr<ElectrobunDialogHandler> m_dialogHandler;
    CefRefPtr<ElectrobunDownloadHandler> m_downloadHandler;
    CefRefPtr<ElectrobunKeyboardHandler> m_keyboardHandler;
    CefRefPtr<ElectrobunRenderHandler> m_renderHandler;
    bool osr_enabled_;
    std::function<void()> load_end_callback_;  // Callback for page load completion

    // Remote DevTools state - tracked per CefBrowser (by identifier)
    struct DevToolsHost {
        HWND window = nullptr;
        CefRefPtr<CefBrowser> browser;
        CefRefPtr<RemoteDevToolsClient> client;
        DevToolsWindowContext* dt_ctx = nullptr;
        bool is_open = false;
    };
    std::map<int, DevToolsHost> devtools_hosts_;
    std::string last_title_;
    std::atomic<bool> devtools_stopping_{false};

    IMPLEMENT_REFCOUNTING(ElectrobunCefClient);
};

// Free function callback for RemoteDevToolsClient -> ElectrobunCefClient
void RemoteDevToolsClosed(void* ctx, int target_id, bool browserClosed) {
    if (!ctx) return;
    static_cast<ElectrobunCefClient*>(ctx)->OnRemoteDevToolsClosed(
        target_id, browserClosed);
}

// Out-of-line definitions for handlers that need ElectrobunCefClient to be fully defined

bool ElectrobunContextMenuHandler::OnContextMenuCommand(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefContextMenuParams> params,
    int command_id,
    EventFlags event_flags) {
    if (command_id == 26501) {
        // Open remote DevTools via the owning ElectrobunCefClient
        CefRefPtr<CefClient> client = browser->GetHost()->GetClient();
        ElectrobunCefClient* ebClient = static_cast<ElectrobunCefClient*>(client.get());
        if (ebClient) {
            ebClient->OpenRemoteDevToolsFrontend(browser);
        }
        return true;
    }
    return false;
}

bool ElectrobunKeyboardHandler::OnPreKeyEvent(
    CefRefPtr<CefBrowser> browser,
    const CefKeyEvent& event,
    CefEventHandle os_event,
    bool* is_keyboard_shortcut) {
    // Only handle key down events
    if (event.type != KEYEVENT_RAWKEYDOWN) {
        return false;
    }

    // F12 or Ctrl+Shift+I -> open DevTools
    bool isF12 = (event.windows_key_code == 123);
    bool isCtrlShiftI = (event.windows_key_code == 'I' &&
                         (event.modifiers & EVENTFLAG_CONTROL_DOWN) &&
                         (event.modifiers & EVENTFLAG_SHIFT_DOWN));
    if (isF12 || isCtrlShiftI) {
        CefRefPtr<CefClient> client = browser->GetHost()->GetClient();
        ElectrobunCefClient* ebClient = static_cast<ElectrobunCefClient*>(client.get());
        if (ebClient) {
            ebClient->OpenRemoteDevToolsFrontend(browser);
        }
        return true;
    }

    // Check if we have accelerator entries
    if (g_menuAccelerators.empty()) {
        return false;
    }

    // Build the current modifier state from CEF event
    BYTE modifiers = FVIRTKEY;
    if (event.modifiers & EVENTFLAG_CONTROL_DOWN) modifiers |= FCONTROL;
    if (event.modifiers & EVENTFLAG_ALT_DOWN) modifiers |= FALT;
    if (event.modifiers & EVENTFLAG_SHIFT_DOWN) modifiers |= FSHIFT;

    // Check if this key combination matches any accelerator
    WORD vkCode = (WORD)event.windows_key_code;

    for (const auto& accel : g_menuAccelerators) {
        if (accel.key == vkCode && accel.fVirt == modifiers) {
            // Found a match! Trigger the menu command directly
            handleApplicationMenuSelection(accel.cmd);
            return true;  // Prevent CEF from processing this key
        }
    }

    return false;
}

// ElectrobunRenderHandler::OnPaint implementation
void ElectrobunRenderHandler::OnPaint(CefRefPtr<CefBrowser> browser,
                                       PaintElementType type,
                                       const RectList& dirtyRects,
                                       const void* buffer,
                                       int width,
                                       int height) {
    if (osr_window_ && buffer && width > 0 && height > 0) {
        osr_window_->UpdateBuffer(buffer, width, height);
    }
}

// Helper function implementation (defined after ElectrobunCefClient class)
void SetBrowserOnClient(CefRefPtr<ElectrobunCefClient> client, CefRefPtr<CefBrowser> browser) {
    if (client && browser) {
        client->SetBrowser(browser);
        // Store preload scripts for this browser ID so load handler can access them
        std::string script = client->GetCombinedScript();
        if (!script.empty()) {
            g_preloadScripts[browser->GetIdentifier()] = script;
        }
    }
}

// ElectrobunLoadHandler method implementations (defined after ElectrobunCefClient class)
void ElectrobunLoadHandler::OnLoadStart(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, TransitionType transition_type) {
    // NOTE: OnLoadStart is now a fallback - primary injection happens via GetResourceResponseFilter
    // This ensures preload scripts are in the HTML before parsing, guaranteeing execution order
    if (frame->IsMain() && webview_event_handler_) {
        std::string url = frame->GetURL().ToString();
        webview_event_handler_(webview_id_, _strdup("did-commit-navigation"), _strdup(url.c_str()));
    }
}

void ElectrobunLoadHandler::OnLoadEnd(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, int httpStatusCode) {
    // Fire did-navigate event
    if (frame->IsMain() && webview_event_handler_) {
        std::string url = frame->GetURL().ToString();
        webview_event_handler_(webview_id_, _strdup("did-navigate"), _strdup(url.c_str()));
    }

    // Call load end callback for deferred operations (like transparency)
    if (frame->IsMain() && client_) {
        client_->OnLoadEnd();
    }
}

// ElectrobunResourceRequestHandler method implementations (defined after ElectrobunCefClient class)
CefRefPtr<CefResponseFilter> ElectrobunResourceRequestHandler::GetResourceResponseFilter(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefRequest> request,
    CefRefPtr<CefResponse> response) {

    std::string url = request->GetURL().ToString();
    std::string mimeType = response->GetMimeType().ToString();
    bool isMain = frame->IsMain();
    bool hasClient = client_ != nullptr;

    std::cout << "[CEF] GetResourceResponseFilter called: url=" << url
              << " mimeType=" << mimeType
              << " isMain=" << isMain
              << " hasClient=" << hasClient << std::endl;

    // Only filter main frame HTML responses
    if (isMain && hasClient && mimeType.find("html") != std::string::npos) {
        std::string combinedScript = client_->GetCombinedScript();
        std::cout << "[CEF] HTML response detected, scriptLength=" << combinedScript.length() << std::endl;

        if (!combinedScript.empty()) {
            std::cout << "[CEF] Installing response filter to inject preload scripts into HTML" << std::endl;
            return new ElectrobunResponseFilter(combinedScript);
        }
    }

    return nullptr;
}

// Runtime CEF availability detection - Windows equivalent of macOS isCEFAvailable()
bool isCEFAvailable() {
    std::wstring exePath = electrobun::getModuleFileNameWide();
    const size_t lastSlash = exePath.find_last_of(L"\\/");
    if (lastSlash == std::wstring::npos) {
        return false;
    }
    exePath.resize(lastSlash);
    
    // Check for essential CEF files
    const std::wstring cefLibPath = exePath + L"\\libcef.dll";
    const std::wstring icuDataPath = exePath + L"\\icudtl.dat";
    
    DWORD libAttributes = GetFileAttributesW(cefLibPath.c_str());
    DWORD icuAttributes = GetFileAttributesW(icuDataPath.c_str());
    
    bool libExists = (libAttributes != INVALID_FILE_ATTRIBUTES && !(libAttributes & FILE_ATTRIBUTE_DIRECTORY));
    bool icuExists = (icuAttributes != INVALID_FILE_ATTRIBUTES && !(icuAttributes & FILE_ATTRIBUTE_DIRECTORY));
    
    return libExists && icuExists;
}

class StatusItemTarget {
public:
    ZigStatusItemHandler zigHandler;
    uint32_t trayId;
    
    StatusItemTarget() : zigHandler(nullptr), trayId(0) {}
};



// Forward declare helper functions
void setupViewsSchemeHandler(ICoreWebView2* webview, uint32_t webviewId);
void handleViewsSchemeRequest(ICoreWebView2WebResourceRequestedEventArgs* args, 
                             const std::wstring& uri, 
                             uint32_t webviewId);
std::string loadViewsFile(const std::string& path);
std::string getMimeTypeForFile(const std::string& path);
void updateActiveWebviewForMousePosition(ContainerView* container, POINT mousePos);

void log(const std::string& message) {
    // Get current time
    std::time_t now = std::time(0);
    std::string timeStr = std::ctime(&now);
    timeStr.pop_back(); // Remove newline character
    
    // Print to console
    std::cout << "[" << timeStr << "] " << message << std::endl;
    
    // Optionally write to file
    std::ofstream logFile("app.log", std::ios::app);
    if (logFile.is_open()) {
        logFile << "[" << timeStr << "] " << message << std::endl;
        logFile.close();
    }
}

// Generic Bridge Handler COM Object - can be used for any bridge type
class BridgeHandler : public IDispatch {
private:
    long m_refCount;
    HandlePostMessage m_callback;
    uint32_t m_webviewId;
    std::string m_bridgeName;
    bool m_quiet;

public:
    BridgeHandler(const std::string& bridgeName, HandlePostMessage callback, uint32_t webviewId,
                  bool quiet = false)
        : m_refCount(1), m_callback(callback), m_webviewId(webviewId), m_bridgeName(bridgeName),
          m_quiet(quiet) {
        
    }

    // IUnknown implementation
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
        if (riid == IID_IUnknown || riid == IID_IDispatch) {
            *ppvObject = static_cast<IDispatch*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return InterlockedIncrement(&m_refCount);
    }

    ULONG STDMETHODCALLTYPE Release() override {
        long refCount = InterlockedDecrement(&m_refCount);
        if (refCount == 0) {
            delete this;
        }
        return refCount;
    }

    // IDispatch implementation
    HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT* pctinfo) override {
        *pctinfo = 0;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT iTInfo, LCID lcid, ITypeInfo** ppTInfo) override {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID riid, LPOLESTR* rgszNames, UINT cNames, LCID lcid, DISPID* rgDispId) override {
        if (cNames == 1 && wcscmp(rgszNames[0], L"postMessage") == 0) {
            rgDispId[0] = 1; // DISPID for postMessage method
            return S_OK;
        }
        return DISP_E_UNKNOWNNAME;
    }

    HRESULT STDMETHODCALLTYPE Invoke(DISPID dispIdMember, REFIID riid, LCID lcid, WORD wFlags, DISPPARAMS* pDispParams, VARIANT* pVarResult, EXCEPINFO* pExcepInfo, UINT* puArgErr) override {
        if (dispIdMember == 1 && !(wFlags & DISPATCH_METHOD)) {
            // WebView2 may probe a known method as a property before invoking it.
            return DISP_E_MEMBERNOTFOUND;
        }
        if (dispIdMember == 1) { // postMessage method
            if (pDispParams->cArgs == 1 && pDispParams->rgvarg[0].vt == VT_BSTR) {
                if (!m_quiet) {
                    printf("[Bridge:%s] Received message for webview %u\n", m_bridgeName.c_str(), m_webviewId);
                }
                return PostMessage(pDispParams->rgvarg[0].bstrVal);
            }
            printf("[Bridge:%s] Bad param count for webview %u\n", m_bridgeName.c_str(), m_webviewId);
            return DISP_E_BADPARAMCOUNT;
        }
        printf("[Bridge:%s] Unknown method DISPID=%ld for webview %u\n", m_bridgeName.c_str(), (long)dispIdMember, m_webviewId);
        return DISP_E_MEMBERNOTFOUND;
    }

    // Bridge-specific method for posting messages
    HRESULT PostMessage(BSTR message) {
        if (!m_callback) {
            ::log("ERROR: Bridge callback is null");
            return E_FAIL;
        }

        std::string messageUtf8;
        if (!message || !electrobun::wideToUtf8(
                std::wstring_view(message, SysStringLen(message)), messageUtf8)) {
            ::log("ERROR: Bridge message is not valid UTF-16");
            return E_FAIL;
        }

        try {
            m_callback(m_webviewId, messageUtf8.c_str());
        } catch (...) {
            ::log("ERROR: Exception in bridge callback");
            return E_FAIL;
        }
        return S_OK;
    }
};

// Dispatch IDs for the bridge methods
#define DISPID_POSTMESSAGE 1

// Dispatch interface for BunBridge
class BunBridgeDispatch : public IDispatch {
private:
    long m_refCount;
    ComPtr<BridgeHandler> m_bridgeHandler;

public:
    BunBridgeDispatch(ComPtr<BridgeHandler> bridgeHandler) 
        : m_refCount(1), m_bridgeHandler(bridgeHandler) {}

    // IUnknown implementation
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
        if (riid == IID_IUnknown || riid == IID_IDispatch) {
            *ppvObject = static_cast<IDispatch*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return InterlockedIncrement(&m_refCount);
    }

    ULONG STDMETHODCALLTYPE Release() override {
        long refCount = InterlockedDecrement(&m_refCount);
        if (refCount == 0) {
            delete this;
        }
        return refCount;
    }

    // IDispatch implementation
    HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT* pctinfo) override {
        *pctinfo = 0;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT iTInfo, LCID lcid, ITypeInfo** ppTInfo) override {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID riid, LPOLESTR* rgszNames, UINT cNames, LCID lcid, DISPID* rgDispId) override {
        if (cNames != 1) return E_INVALIDARG;
        
        std::wstring name(rgszNames[0]);
        if (name == L"postMessage") {
            rgDispId[0] = DISPID_POSTMESSAGE;
            return S_OK;
        }
        
        return DISP_E_UNKNOWNNAME;
    }

    HRESULT STDMETHODCALLTYPE Invoke(DISPID dispIdMember, REFIID riid, LCID lcid, WORD wFlags, 
                                   DISPPARAMS* pDispParams, VARIANT* pVarResult, 
                                   EXCEPINFO* pExcepInfo, UINT* puArgErr) override {
        if (dispIdMember == DISPID_POSTMESSAGE) {
            if (pDispParams->cArgs != 1) {
                return DISP_E_BADPARAMCOUNT;
            }
            
            VARIANT* arg = &pDispParams->rgvarg[0];
            if (arg->vt != VT_BSTR) {
                return DISP_E_TYPEMISMATCH;
            }
            
            return m_bridgeHandler->PostMessage(arg->bstrVal);
        }
        
        return DISP_E_MEMBERNOTFOUND;
    }
};

// Dispatch interface for InternalBridge (same implementation, different name for clarity)
class InternalBridgeDispatch : public IDispatch {
private:
    long m_refCount;
    ComPtr<BridgeHandler> m_bridgeHandler;

public:
    InternalBridgeDispatch(ComPtr<BridgeHandler> bridgeHandler) 
        : m_refCount(1), m_bridgeHandler(bridgeHandler) {}

    // IUnknown implementation
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
        if (riid == IID_IUnknown || riid == IID_IDispatch) {
            *ppvObject = static_cast<IDispatch*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return InterlockedIncrement(&m_refCount);
    }

    ULONG STDMETHODCALLTYPE Release() override {
        long refCount = InterlockedDecrement(&m_refCount);
        if (refCount == 0) {
            delete this;
        }
        return refCount;
    }

    // IDispatch implementation (identical to BunBridgeDispatch)
    HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT* pctinfo) override {
        *pctinfo = 0;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT iTInfo, LCID lcid, ITypeInfo** ppTInfo) override {
        return E_NOTIMPL;
    }

    HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID riid, LPOLESTR* rgszNames, UINT cNames, LCID lcid, DISPID* rgDispId) override {
        if (cNames != 1) return E_INVALIDARG;
        
        std::wstring name(rgszNames[0]);
        if (name == L"postMessage") {
            rgDispId[0] = DISPID_POSTMESSAGE;
            return S_OK;
        }
        
        return DISP_E_UNKNOWNNAME;
    }

    HRESULT STDMETHODCALLTYPE Invoke(DISPID dispIdMember, REFIID riid, LCID lcid, WORD wFlags, 
                                   DISPPARAMS* pDispParams, VARIANT* pVarResult, 
                                   EXCEPINFO* pExcepInfo, UINT* puArgErr) override {
        if (dispIdMember == DISPID_POSTMESSAGE) {
            if (pDispParams->cArgs != 1) {
                return DISP_E_BADPARAMCOUNT;
            }
            
            VARIANT* arg = &pDispParams->rgvarg[0];
            if (arg->vt != VT_BSTR) {
                return DISP_E_TYPEMISMATCH;
            }
            
            return m_bridgeHandler->PostMessage(arg->bstrVal);
        }
        
        return DISP_E_MEMBERNOTFOUND;
    }
};





class MainThreadDispatcher {
private:
    static HWND g_messageWindow;
    static DWORD g_messageThreadId;

public:
    static void initialize(HWND hwnd) {
        g_messageWindow = hwnd;
        g_messageThreadId = hwnd ? GetWindowThreadProcessId(hwnd, nullptr) : 0;
    }

    static bool is_main_thread() {
        return g_messageThreadId != 0 && GetCurrentThreadId() == g_messageThreadId;
    }

    static HWND message_window() {
        return g_messageWindow;
    }
    
    template<typename Func>
    static auto dispatch_sync(Func&& func) -> decltype(func()) {
        using ReturnType = decltype(func());

        if (is_main_thread() || !g_messageWindow) {
            return func();
        }
        
        if constexpr (std::is_void_v<ReturnType>) {
            auto promise = std::make_shared<std::promise<void>>();
            auto future = promise->get_future();
            
            auto task = new std::function<void()>([func = std::forward<Func>(func), promise]() {
                try {
                    func();
                    promise->set_value();
                } catch (...) {
                    promise->set_exception(std::current_exception());
                }
            });
            
            if (!PostMessage(
                    g_messageWindow,
                    WM_EXECUTE_SYNC_BLOCK,
                    0,
                    reinterpret_cast<LPARAM>(task))) {
                delete task;
                return;
            }
            future.get(); // Will re-throw any exceptions
        } else {
            auto promise = std::make_shared<std::promise<ReturnType>>();
            auto future = promise->get_future();
            
            auto task = new std::function<void()>([func = std::forward<Func>(func), promise]() {
                try {
                    promise->set_value(func());
                } catch (...) {
                    promise->set_exception(std::current_exception());
                }
            });
            
            if (!PostMessage(
                    g_messageWindow,
                    WM_EXECUTE_SYNC_BLOCK,
                    0,
                    reinterpret_cast<LPARAM>(task))) {
                delete task;
                return ReturnType{};
            }
            return future.get();
        }
    }
    
    static void handleSyncTask(LPARAM lParam) {
        auto task = (std::function<void()>*)lParam;
        (*task)();
        delete task;
    }
    
    template<typename Func>
    static void dispatch_async(Func&& func) {
        if (!g_messageWindow) {
            func();
            return;
        }
        auto task = new std::function<void()>(std::forward<Func>(func));
        if (!PostMessage(
                g_messageWindow,
                WM_EXECUTE_ASYNC_BLOCK,
                0,
                reinterpret_cast<LPARAM>(task))) {
            delete task;
        }
    }
};

HWND MainThreadDispatcher::g_messageWindow = NULL;
DWORD MainThreadDispatcher::g_messageThreadId = 0;

// AbstractView base class - Windows implementation matching Mac pattern
class AbstractView {
public:
    uint32_t webviewId;
    HWND hwnd = NULL;
    HWND parentWindow = NULL;
    bool isMousePassthroughEnabled = false;
    bool mirrorModeEnabled = false;
    bool fullSize = false;
    bool pendingStartTransparent = false;
    bool pendingStartPassthrough = false;

    // Common state
    bool isReceivingInput = true;
    std::string maskJSON;
    RECT visualBounds = {};
    bool creationFailed = false;

    // Public view frames are DIPs. Keep the canonical logical rectangle so
    // non-full-size views can be re-rasterized when their parent crosses to a
    // monitor with a different DPI; visualBounds remains Win32 client pixels.
    std::mutex logicalFrameMutex;
    double logicalFrameX = 0;
    double logicalFrameY = 0;
    double logicalFrameWidth = 0;
    double logicalFrameHeight = 0;
    bool hasLogicalFrame = false;

    // Pending resize state (cross-thread)
    std::mutex pendingResizeMutex;
    std::atomic<uint64_t> pendingResizeGeneration{0};
    uint64_t appliedResizeGeneration = 0;
    bool hasPendingResize = false;
    RECT pendingResizeFrame = {};
    std::string pendingResizeMasks;

    // Navigation rules for URL filtering
    std::vector<std::string> navigationRules;

    // Bridge handlers
    ComPtr<BridgeHandler> eventBridgeHandler;  // Event-only bridge (always available)
    ComPtr<BridgeHandler> bunBridgeHandler;
    ComPtr<BridgeHandler> internalBridgeHandler;
    ComPtr<BridgeHandler> consoleBridgeHandler;
    ComPtr<BunBridgeDispatch> bunBridgeDispatch;
    ComPtr<InternalBridgeDispatch> internalBridgeDispatch;

    virtual ~AbstractView() = default;
    
    // Pure virtual methods - must be implemented by subclasses
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
    virtual void resize(const RECT& frame, const char* masksJson) = 0;
    virtual void notifyParentWindowPositionChanged() {}
    virtual void focus() {
        if (hwnd) ::SetFocus(hwnd);
    }
    
    // Common implementations
    virtual void setTransparent(bool transparent) {
        // Default implementation - can be overridden
    }
    
    virtual void setPassthrough(bool enable) {
        isMousePassthroughEnabled = enable;
    }
    
    virtual void setHidden(bool hidden) {
        if (hwnd) {
            ShowWindow(hwnd, hidden ? SW_HIDE : SW_SHOW);
        }
    }

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
            }
        }

        return allowed;
    }

    virtual void setCreationFailed(bool failed) {
        creationFailed = failed;
    }
    
    virtual bool hasCreationFailed() const {
        return creationFailed;
    }

    void setLogicalFrame(double x, double y, double width, double height) {
        std::lock_guard<std::mutex> lock(logicalFrameMutex);
        logicalFrameX = x;
        logicalFrameY = y;
        logicalFrameWidth = width;
        logicalFrameHeight = height;
        hasLogicalFrame = true;
    }

    bool physicalFrameForDpi(UINT dpi, RECT& frame) {
        std::lock_guard<std::mutex> lock(logicalFrameMutex);
        if (!hasLogicalFrame) return false;
        frame = electrobun::logicalToPhysicalRect(
            logicalFrameX,
            logicalFrameY,
            logicalFrameWidth,
            logicalFrameHeight,
            dpi);
        return true;
    }

    UINT parentDpi() const {
        return electrobun::windowsDpiForWindow(parentWindow);
    }
    
    // Check if point is in a masked (cut-out) area based on maskJSON
    bool isPointInMask(POINT localPoint) {
        if (maskJSON.empty()) {
            return false;
        }
        
        // Simple JSON parsing for mask rectangles
        // Expected format: [{"x":10,"y":20,"width":100,"height":50},...]
        size_t pos = 0;
        while ((pos = maskJSON.find("\"x\":", pos)) != std::string::npos) {
            try {
                // Extract x, y, width, height from JSON
                size_t xStart = maskJSON.find(":", pos) + 1;
                size_t xEnd = maskJSON.find(",", xStart);
                int x = std::stoi(maskJSON.substr(xStart, xEnd - xStart));
                
                size_t yPos = maskJSON.find("\"y\":", pos);
                size_t yStart = maskJSON.find(":", yPos) + 1;
                size_t yEnd = maskJSON.find(",", yStart);
                int y = std::stoi(maskJSON.substr(yStart, yEnd - yStart));
                
                size_t wPos = maskJSON.find("\"width\":", pos);
                size_t wStart = maskJSON.find(":", wPos) + 1;
                size_t wEnd = maskJSON.find(",", wStart);
                if (wEnd == std::string::npos) wEnd = maskJSON.find("}", wStart);
                int width = std::stoi(maskJSON.substr(wStart, wEnd - wStart));
                
                size_t hPos = maskJSON.find("\"height\":", pos);
                size_t hStart = maskJSON.find(":", hPos) + 1;
                size_t hEnd = maskJSON.find("}", hStart);
                int height = std::stoi(maskJSON.substr(hStart, hEnd - hStart));
                
                // Mask JSON is expressed in view DIPs while mouse points are
                // Win32 client pixels.
                const double logicalX =
                    electrobun::physicalToLogicalCoordinate(
                        localPoint.x, parentDpi());
                const double logicalY =
                    electrobun::physicalToLogicalCoordinate(
                        localPoint.y, parentDpi());
                if (logicalX >= x && logicalX < x + width &&
                    logicalY >= y && logicalY < y + height) {
                    return true;  // Point is in a masked area
                }
                
                pos = hEnd;
            } catch (...) {
                // JSON parsing error, skip this mask
                pos++;
            }
        }
        
        return false;  // Point is not in any masked area
    }
    
    // Virtual methods for subclass-specific functionality
    virtual void applyVisualMask() = 0;
    virtual void removeMasks() = 0;
    virtual void toggleMirrorMode(bool enable) = 0;

    // Find in page methods
    virtual void findInPage(const char* searchText, bool forward, bool matchCase) = 0;
    virtual void stopFindInPage() = 0;

    // Developer tools methods
    virtual void openDevTools() = 0;
    virtual void closeDevTools() = 0;
    virtual void toggleDevTools() = 0;

    void storePendingResize(const RECT& frame, const char* masksJson) {
        std::lock_guard<std::mutex> lock(pendingResizeMutex);
        pendingResizeFrame = frame;
        pendingResizeMasks = masksJson ? masksJson : "";
        hasPendingResize = true;
        pendingResizeGeneration++;
    }

    bool consumePendingResize(RECT& outFrame, std::string& outMasks) {
        std::lock_guard<std::mutex> lock(pendingResizeMutex);
        if (!hasPendingResize) return false;
        uint64_t gen = pendingResizeGeneration.load();
        if (gen == appliedResizeGeneration) return false;
        outFrame = pendingResizeFrame;
        outMasks = pendingResizeMasks;
        appliedResizeGeneration = gen;
        hasPendingResize = false;
        return true;
    }
};

// Keep the two core ID namespaces separate in native ownership as well.
static std::map<uint32_t, std::shared_ptr<AbstractView>> g_retainedAbstractViews;
static std::mutex g_retainedAbstractViewsMutex;
static std::map<uint32_t, std::shared_ptr<AbstractView>> g_retainedWGPUViews;
static std::mutex g_retainedWGPUViewsMutex;

static void trackAbstractView(AbstractView* view) {
    if (!view) return;

    std::lock_guard<std::mutex> lock(g_abstractViewsMutex);
    g_abstractViews[view->webviewId] = view;
}

static void untrackAbstractView(AbstractView* view) {
    if (!view) return;

    std::lock_guard<std::mutex> lock(g_abstractViewsMutex);
    auto it = g_abstractViews.find(view->webviewId);
    if (it != g_abstractViews.end() && it->second == view) {
        g_abstractViews.erase(it);
    }
}

static void retainAbstractView(std::shared_ptr<AbstractView> view) {
    if (!view) return;

    std::lock_guard<std::mutex> lock(g_retainedAbstractViewsMutex);
    g_retainedAbstractViews[view->webviewId] = view;
}

static void releaseRetainedAbstractView(AbstractView* view) {
    if (!view) return;

    std::lock_guard<std::mutex> lock(g_retainedAbstractViewsMutex);
    auto it = g_retainedAbstractViews.find(view->webviewId);
    if (it != g_retainedAbstractViews.end() && it->second.get() == view) {
        g_retainedAbstractViews.erase(it);
    }
}

static void retainWGPUView(std::shared_ptr<AbstractView> view) {
    if (!view) return;

    std::lock_guard<std::mutex> lock(g_retainedWGPUViewsMutex);
    g_retainedWGPUViews[view->webviewId] = view;
}

static std::shared_ptr<AbstractView> takeRetainedWGPUView(AbstractView* view) {
    if (!view) return nullptr;

    std::lock_guard<std::mutex> lock(g_retainedWGPUViewsMutex);
    auto it = std::find_if(
        g_retainedWGPUViews.begin(),
        g_retainedWGPUViews.end(),
        [view](const auto& entry) {
            return entry.second.get() == view;
        });
    if (it == g_retainedWGPUViews.end()) {
        return nullptr;
    }
    std::shared_ptr<AbstractView> retainedView = std::move(it->second);
    g_retainedWGPUViews.erase(it);
    return retainedView;
}

static void releaseRetainedWGPUView(AbstractView* view) {
    if (!view) return;

    std::lock_guard<std::mutex> lock(g_retainedWGPUViewsMutex);
    auto it = g_retainedWGPUViews.find(view->webviewId);
    if (it != g_retainedWGPUViews.end() && it->second.get() == view) {
        g_retainedWGPUViews.erase(it);
    }
}

// Pending resize queue (cross-thread)
static PendingResizeQueue g_pendingResizeQueue;
static std::atomic<bool> g_pendingResizeScheduled{false};

static void drainPendingResizes() {
    g_pendingResizeScheduled.store(false);
    auto items = g_pendingResizeQueue.drain();
    for (void* item : items) {
        AbstractView* view = static_cast<AbstractView*>(item);
        if (!view) continue;
        RECT frame = {};
        std::string masks;
        if (view->consumePendingResize(frame, masks)) {
            view->resize(frame, masks.c_str());
        }
    }
}

static void schedulePendingResizeDrain() {
    if (g_pendingResizeScheduled.exchange(true)) return;
    MainThreadDispatcher::dispatch_async([]() {
        drainPendingResizes();
    });
}

// Helper function to check navigation rules
// This is defined here (after AbstractView) so it can call methods on AbstractView
bool checkNavigationRules(AbstractView* view, const std::string& url) {
    if (!view) {
        return true; // Allow navigation if no view
    }
    return view->shouldAllowNavigationToURL(url);
}

// WebView2View class - implements AbstractView for WebView2
class WebView2View : public AbstractView {
private:
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2CompositionController> compositionController;
    ComPtr<ICoreWebView2> webview;
    HandlePostMessage eventBridgeCallbackHandler;
    HandlePostMessage bunBridgeCallbackHandler;
    HandlePostMessage internalBridgeCallbackHandler;
    bool isSandboxed;
    HWND containerHwnd = nullptr;  // Container window for masking
    double pageZoomFactor = 1.0;

public:
    std::string pendingUrl;
    std::string pendingHtml;  // Stored inline HTML for loading after async creation
    std::string electrobunScript;
    std::string customScript;
    bool isCreationComplete = false;
    WebviewEventHandler webviewEventHandler = nullptr;

    // Static debounce timestamp for ctrl+click handling
    static double lastCtrlClickTime;

    WebView2View(uint32_t webviewId, HandlePostMessage eventBridgeHandler, HandlePostMessage bunBridgeHandler, HandlePostMessage internalBridgeHandler, bool sandbox)
        : eventBridgeCallbackHandler(eventBridgeHandler), bunBridgeCallbackHandler(bunBridgeHandler), internalBridgeCallbackHandler(internalBridgeHandler), isSandboxed(sandbox) {
        this->webviewId = webviewId;
    }
    
    // Setter methods for COM objects (called from async creation callbacks)
    void setController(ComPtr<ICoreWebView2Controller> ctrl) {
        controller = ctrl;
    }
    
    void setCompositionController(ComPtr<ICoreWebView2CompositionController> compCtrl) {
        compositionController = compCtrl;
    }
    
    void setWebView(ComPtr<ICoreWebView2> wv) {
        webview = wv;
    }

    void setContainerHwnd(HWND hwnd) {
        containerHwnd = hwnd;
    }

    ComPtr<ICoreWebView2> getWebView() const {
        return webview;
    }

    void notifyParentWindowPositionChanged() override {
        if (controller) controller->NotifyParentWindowPositionChanged();
    }

    void focus() override {
        if (controller) {
            controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        } else {
            AbstractView::focus();
        }
    }

    void setPageZoom(double zoomFactor) {
        pageZoomFactor = zoomFactor;
        applyPageZoom();
    }

    void applyPageZoom() {
        if (controller) {
            controller->put_ZoomFactor(pageZoomFactor);
        }
    }

    double getPageZoom() {
        if (controller) {
            double zoomFactor = pageZoomFactor;
            if (SUCCEEDED(controller->get_ZoomFactor(&zoomFactor))) {
                pageZoomFactor = zoomFactor;
            }
        }
        return pageZoomFactor;
    }

    void setCreationComplete(bool complete) {
        isCreationComplete = complete;
    }
    
    bool isReady() const {
        return isCreationComplete && !creationFailed;
    }
    
    // Set up the JavaScript bridge objects in the WebView2 context using hostObjects
    void setupJavaScriptBridges() {
        if (!webview) return;

        if (shouldForwardWebviewConsole(g_electrobunChannel)) {
            consoleBridgeHandler = ComPtr<BridgeHandler>(new BridgeHandler(
                "electrobunConsole",
                printWebviewConsoleMessage,
                webviewId,
                true));
            VARIANT consoleBridgeVariant = {};
            VariantInit(&consoleBridgeVariant);
            consoleBridgeVariant.vt = VT_DISPATCH;
            consoleBridgeVariant.pdispVal = static_cast<IDispatch*>(consoleBridgeHandler.Get());
            HRESULT bridgeResult = webview->AddHostObjectToScript(
                L"electrobunConsole",
                &consoleBridgeVariant);
            VariantClear(&consoleBridgeVariant);

            if (SUCCEEDED(bridgeResult)) {
                const char* source = webviewConsoleForwardingScript();
                std::wstring script(source, source + strlen(source));
                webview->AddScriptToExecuteOnDocumentCreated(script.c_str(), nullptr);
            }
        }

        // eventBridge - event-only bridge (always set up for all webviews, including sandboxed)
        eventBridgeHandler = ComPtr<BridgeHandler>(new BridgeHandler("eventBridge", eventBridgeCallbackHandler, webviewId));
        VARIANT eventBridgeVariant = {};
        VariantInit(&eventBridgeVariant);
        eventBridgeVariant.vt = VT_DISPATCH;
        eventBridgeVariant.pdispVal = static_cast<IDispatch*>(eventBridgeHandler.Get());
        webview->AddHostObjectToScript(L"eventBridge", &eventBridgeVariant);
        VariantClear(&eventBridgeVariant);

        // hostBridge/bunBridge aliases and internalBridge - RPC bridges (only for non-sandboxed webviews)
        if (!isSandboxed) {
            // Create COM objects for the bridge handlers
            bunBridgeHandler = ComPtr<BridgeHandler>(new BridgeHandler("bunBridge", bunBridgeCallbackHandler, webviewId));
            internalBridgeHandler = ComPtr<BridgeHandler>(new BridgeHandler("internalBridge", internalBridgeCallbackHandler, webviewId));

            // Convert COM objects to VARIANT for AddHostObjectToScript
            VARIANT bunBridgeVariant = {};
            VariantInit(&bunBridgeVariant);
            bunBridgeVariant.vt = VT_DISPATCH;
            bunBridgeVariant.pdispVal = static_cast<IDispatch*>(bunBridgeHandler.Get());

            VARIANT internalBridgeVariant = {};
            VariantInit(&internalBridgeVariant);
            internalBridgeVariant.vt = VT_DISPATCH;
            internalBridgeVariant.pdispVal = static_cast<IDispatch*>(internalBridgeHandler.Get());

            // Add the bridge objects to hostObjects
            webview->AddHostObjectToScript(L"hostBridge", &bunBridgeVariant);
            webview->AddHostObjectToScript(L"bunBridge", &bunBridgeVariant);
            webview->AddHostObjectToScript(L"internalBridge", &internalBridgeVariant);

            // Clean up VARIANTs
            VariantClear(&bunBridgeVariant);
            VariantClear(&internalBridgeVariant);
        }
    }
    
    void loadURL(const char* urlString) override {
        if (!urlString) return;
        std::string urlStr(urlString);

        // Navigate must happen on the UI thread — WebView2 APIs are single-threaded
        MainThreadDispatcher::dispatch_async([this, urlStr]() {
            if (webview) {
                std::wstring url;
                if (!electrobun::utf8ToWide(urlStr, url)) {
                    ::log("[WebView2] Refusing navigation URL that is not valid UTF-8");
                    return;
                }
                webview->Navigate(url.c_str());
            } else {
                // WebView2 not ready — store URL for creation callback to load
                pendingUrl = urlStr;
            }
        });
    }
    
    void loadHTML(const char* htmlString) override {
        if (!htmlString) return;
        std::string htmlCopy(htmlString);
        // Dispatch to main thread to avoid race with async WebView2 creation callback.
        // Both this and the creation callback run on the main thread, so they can't interleave.
        MainThreadDispatcher::dispatch_async([this, htmlCopy]() {
            if (webview) {
                std::wstring html;
                if (!electrobun::utf8ToWide(htmlCopy, html)) {
                    ::log("[WebView2] Refusing HTML that is not valid UTF-8");
                    return;
                }
                webview->NavigateToString(html.c_str());
            } else {
                // WebView2 not ready — creation callback will load this
                pendingHtml = htmlCopy;
            }
        });
    }
    
    void goBack() override {
        if (webview) {
            webview->GoBack();
        }
    }
    
    void goForward() override {
        if (webview) {
            webview->GoForward();
        }
    }
    
    void reload() override {
        if (webview) {
            webview->Reload();
        }
    }
    
    void remove() override {
        for (auto it = g_webview2Views.begin(); it != g_webview2Views.end();) {
            if (it->second == this) {
                it = g_webview2Views.erase(it);
            } else {
                ++it;
            }
        }

        if (controller) {
            controller->Close();
            controller = nullptr;
        }
        webview = nullptr;
    }

    // Override transparency implementation for WebView2
    void setTransparent(bool transparent) override {
        if (!controller) {
            return;
        }

        // Use WebView2's built-in visibility control
        controller->put_IsVisible(transparent ? FALSE : TRUE);
    }

    // Override passthrough implementation for WebView2
    void setPassthrough(bool enable) override {
        AbstractView::setPassthrough(enable); // Call base implementation to set the flag

        if (!controller || !containerHwnd) {
            return;
        }

        // Get the bounds of this WebView to identify its child windows
        RECT viewBounds;
        controller->get_Bounds(&viewBounds);

        // Find WebView2's Chrome child windows and apply/remove WS_EX_TRANSPARENT
        struct PassthroughEnumData {
            RECT targetBounds;
            HWND containerHwnd;
            bool enablePassthrough;
        };

        PassthroughEnumData enumData;
        enumData.targetBounds = viewBounds;
        enumData.containerHwnd = containerHwnd;
        enumData.enablePassthrough = enable;

        EnumChildWindows(containerHwnd, [](HWND child, LPARAM lParam) -> BOOL {
            PassthroughEnumData* data = (PassthroughEnumData*)lParam;

            char className[256];
            GetClassNameA(child, className, sizeof(className));

            // Look for WebView2/Chrome child windows
            if (strstr(className, "Chrome_WidgetWin") ||
                strstr(className, "Chrome_RenderWidgetHostHWND")) {

                RECT childRect;
                GetWindowRect(child, &childRect);

                // Convert to container coordinates
                POINT topLeft = {childRect.left, childRect.top};
                ScreenToClient(data->containerHwnd, &topLeft);

                // Check if this matches our WebView's bounds (with some tolerance)
                if (abs(topLeft.x - data->targetBounds.left) < 5 &&
                    abs(topLeft.y - data->targetBounds.top) < 5) {
                    // This is our WebView's child window - apply WS_EX_TRANSPARENT
                    LONG exStyle = GetWindowLong(child, GWL_EXSTYLE);
                    if (data->enablePassthrough) {
                        SetWindowLong(child, GWL_EXSTYLE, exStyle | WS_EX_TRANSPARENT);
                    } else {
                        SetWindowLong(child, GWL_EXSTYLE, exStyle & ~WS_EX_TRANSPARENT);
                    }
                    return FALSE; // Stop enumeration
                }
            }
            return TRUE; // Continue enumeration
        }, (LPARAM)&enumData);
    }

    bool canGoBack() override {
        if (webview) {
            BOOL canGoBack = FALSE;
            webview->get_CanGoBack(&canGoBack);
            return canGoBack;
        }
        return false;
    }
    
    bool canGoForward() override {
        if (webview) {
            BOOL canGoForward = FALSE;
            webview->get_CanGoForward(&canGoForward);
            return canGoForward;
        }
        return false;
    }
    
    void evaluateJavaScriptWithNoCompletion(const char* jsString) override {
        if (webview && jsString) {
            // Copy string to avoid lifetime issues in lambda
            std::string jsStringCopy = jsString;
            MainThreadDispatcher::dispatch_sync([this, jsStringCopy]() {
                std::wstring js;
                if (!electrobun::utf8ToWide(jsStringCopy, js)) {
                    ::log("[WebView2] Refusing to execute JavaScript that is not valid UTF-8");
                    return;
                }
                webview->ExecuteScript(js.c_str(), nullptr);
            });
        }
    }
    
    void callAsyncJavascript(const char* messageId, const char* jsString, uint32_t webviewId, uint32_t hostWebviewId, void* completionHandler) override {
        if (webview && jsString) {
            std::wstring js;
            if (!electrobun::utf8ToWide(jsString, js)) {
                ::log("[WebView2] Refusing async JavaScript that is not valid UTF-8");
                return;
            }
            webview->ExecuteScript(js.c_str(), (ICoreWebView2ExecuteScriptCompletedHandler*)completionHandler);
        }
    }
    
    void addPreloadScriptToWebView(const char* jsString) override {
        if (webview && jsString) {
            std::wstring js;
            if (!electrobun::utf8ToWide(jsString, js)) {
                ::log("[WebView2] Refusing preload JavaScript that is not valid UTF-8");
                return;
            }
            webview->AddScriptToExecuteOnDocumentCreated(js.c_str(), nullptr);
            std::cout << "[WebView2] Added preload script to execute on document created (length: " << strlen(jsString) << ")" << std::endl;
        }
    }
    
    void updateCustomPreloadScript(const char* jsString) override {
        if (!jsString || !webview) return;

        std::string scriptContent;

        // Check if this is a views:// URL for a script file
        if (strncmp(jsString, "views://", 8) == 0) {
            scriptContent = loadViewsFile(normalizeViewsRelativePath(jsString));
            if (scriptContent.empty()) {
                std::cout << "[WebView2] Could not read preload script from: " << jsString << std::endl;
                return;
            }
        } else {
            // Inline JavaScript
            scriptContent = jsString;
        }

        // WebView2 accepts UTF-16. Byte-wise widening corrupts any non-ASCII
        // source, including the JSON RPC fallback used on Windows.
        std::wstring wScript;
        if (!electrobun::utf8ToWide(scriptContent, wScript)) {
            ::log("[WebView2] Refusing custom preload that is not valid UTF-8");
            return;
        }

        // Add as a script to execute on document creation for future navigations
        webview->AddScriptToExecuteOnDocumentCreated(wScript.c_str(), nullptr);

        // Also execute immediately if the page is already loaded
        webview->ExecuteScript(wScript.c_str(), nullptr);
    }

    void resize(const RECT& frame, const char* masksJson) override {
        
        if (controller) {
            // WebView2 operations must be called from main thread to avoid TYPE_E_BADVARTYPE
            MainThreadDispatcher::dispatch_async([this, frame]() {
                HRESULT result = controller->put_Bounds(frame);
                if (FAILED(result)) {
                    char errorLog[256];
                    sprintf_s(errorLog, "[WebView2] put_Bounds failed for webview %u, HRESULT: 0x%08X", webviewId, result);
                    ::log(errorLog);
                }
            });
            
            visualBounds = frame;
            bool maskChanged = false;
            // Check if masksJson is nullptr, empty, or just "[]" (empty array)
            if (masksJson && strlen(masksJson) > 0 && strcmp(masksJson, "[]") != 0) {
                std::string newMaskJSON = masksJson;
                if (newMaskJSON != maskJSON) {
                    maskJSON = newMaskJSON;
                    maskChanged = true;
                }
            } else if (!maskJSON.empty()) {
                maskJSON = "";
                maskChanged = true;
            }

            // Only apply visual mask if mask data changed
            if (maskChanged) {
                applyVisualMask();
            }
        } else {
            ::log("[WebView2] ERROR: Controller is NULL, cannot resize");
        }
    }

    ComPtr<ICoreWebView2Controller> getController() {
        return controller;
    }
    
    ComPtr<ICoreWebView2> getWebView() {
        return webview;
    }
    
    // WebView2-specific implementation of mask functionality
    void applyVisualMask() override {
        // NOTE: WebView2 visual masking is not supported.
        //
        // WebView2 uses GPU-accelerated Direct3D rendering through an "Intermediate D3D Window"
        // which does not respect traditional GDI window regions (SetWindowRgn). The rendering
        // pipeline bypasses the Windows compositor in a way that makes hole-cutting impossible
        // with standard Win32 APIs.
        //
        // Approaches that were investigated and failed:
        // 1. SetWindowRgn on Chrome_WidgetWin_0 - Ignored by GPU rendering
        // 2. SetWindowRgn on Intermediate D3D Window - Ignored by D3D surface
        // 3. SetWindowRgn on shared container - Affects all webviews, not just the target
        //
        // CEF (Chromium bundling) works because it provides direct access to the browser
        // window handle via browser->GetHost()->GetWindowHandle(), which respects SetWindowRgn.
        //
        // Recommendation: Use CEF (bundleChromium: true) for webviews that require maskJSON
        // functionality on Windows.
        //
        // The maskJSON value is still stored (in AbstractView::maskJSON) for potential future
        // use if WebView2 adds an API for visual clipping.
    }

    void removeMasks() override {
        // No-op for WebView2 - see applyVisualMask() for explanation
    }
    
    void toggleMirrorMode(bool enable) override {
        if (!controller) return;

        if (enable && !mirrorModeEnabled) {
            mirrorModeEnabled = true;
            // Disable input for WebView2
        } else if (!enable && mirrorModeEnabled) {
            mirrorModeEnabled = false;
            controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        }
    }

    void findInPage(const char* searchText, bool forward, bool matchCase) override {
        if (!webview) return;

        if (!searchText || strlen(searchText) == 0) {
            stopFindInPage();
            return;
        }

        // WebView2 doesn't have a native Find API in older versions
        // Use JavaScript window.find() instead
        std::string text(searchText);
        // Escape special characters for JavaScript string
        std::string escaped;
        for (char c : text) {
            if (c == '\\') escaped += "\\\\";
            else if (c == '\'') escaped += "\\'";
            else if (c == '\n') escaped += "\\n";
            else if (c == '\r') escaped += "\\r";
            else escaped += c;
        }

        // window.find(string, caseSensitive, backwards, wrapAround)
        std::string js = "window.find('" + escaped + "', " +
            (matchCase ? "true" : "false") + ", " +
            (forward ? "false" : "true") + ", true, false, false, false)";

        std::wstring wjs;
        if (!electrobun::utf8ToWide(js, wjs)) {
            ::log("[WebView2] Refusing find text that is not valid UTF-8");
            return;
        }
        webview->ExecuteScript(wjs.c_str(), nullptr);
    }

    void stopFindInPage() override {
        if (!webview) return;

        // Clear selection to remove find highlighting
        webview->ExecuteScript(L"window.getSelection().removeAllRanges();", nullptr);
    }

    void openDevTools() override {
        if (!webview) return;
        webview->OpenDevToolsWindow();
    }

    void closeDevTools() override {
        if (!webview) return;
        // WebView2 doesn't expose a CloseDevToolsWindow API.
        // The DevTools window is user-managed; opening it again is a no-op if already open.
    }

    void toggleDevTools() override {
        if (!webview) return;
        // WebView2 handles toggle behavior internally - opening when already open is a no-op
        webview->OpenDevToolsWindow();
    }
};

// Initialize static debounce timestamp for ctrl+click handling
double WebView2View::lastCtrlClickTime = 0;

// CEFView class - implements AbstractView for CEF
class CEFView : public AbstractView {
private:
    CefRefPtr<CefBrowser> browser;
    CefRefPtr<ElectrobunCefClient> client;
    OSRWindow* osr_window;
    bool is_osr_mode;
    CefFindSession findSession;
    std::string pending_url;
    std::string pending_html;
    bool has_pending_url = false;
    bool has_pending_html = false;

public:
    CEFView(uint32_t webviewId) : osr_window(nullptr), is_osr_mode(false) {
        this->webviewId = webviewId;
    }

    ~CEFView() {
        // If remove() wasn't called (e.g. window destroyed directly via WM_DESTROY
        // without explicit webview removal), clean up the browser properly.
        if (browser) {
            // Invalidate render handler's OSR pointer before we delete it
            if (client) {
                client->ClearOSRWindow();
                client->PrepareForBrowserClose();
            }

            CefRefPtr<CefBrowserHost> host = browser->GetHost();
            browser = nullptr;
            client = nullptr;

            if (host) {
                host->CloseBrowser(true);
            }
        } else if (client) {
            // remove() was called (browser is null) but client might still be set
            // in older code paths - clear the OSR pointer just in case
            client->ClearOSRWindow();
            client->PrepareForBrowserClose();
            client = nullptr;
        }

        // Clean up global maps that hold raw pointers to this object
        for (auto it = g_cefViews.begin(); it != g_cefViews.end(); ++it) {
            if (it->second == this) {
                g_cefViews.erase(it);
                break;
            }
        }
        untrackAbstractView(this);

        if (osr_window) {
            delete osr_window;
            osr_window = nullptr;
        }
    }

    void setOSRWindow(OSRWindow* window) {
        osr_window = window;
        is_osr_mode = true;
    }

    bool isOSRMode() const {
        return is_osr_mode;
    }

    void ReleaseCEFReferencesForShutdown() {
        findSession.reset();
        if (client) {
            client->PrepareForBrowserClose();
        }
        if (osr_window) {
            osr_window->SetBrowser(nullptr);
        }
        browser = nullptr;
        client = nullptr;
    }
    
    void loadURL(const char* urlString) override {
        const std::string url = urlString ? urlString : "";
        if (!browser) {
            pending_html.clear();
            has_pending_html = false;
            pending_url = url;
            has_pending_url = true;
            return;
        }
        browser->GetMainFrame()->LoadURL(CefString(url));
    }
    
    void loadHTML(const char* htmlString) override {
        if (!htmlString) return;
        if (!browser) {
            pending_url.clear();
            has_pending_url = false;
            pending_html = htmlString;
            has_pending_html = true;
            return;
        }

        // Create a data URI for the HTML content.
        std::string dataUri = "data:text/html;charset=utf-8,";
        dataUri += htmlString;
        browser->GetMainFrame()->LoadURL(CefString(dataUri));
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
            std::cout << "[CEF] CEFView::remove() called for browser ID " << browser->GetIdentifier() << std::endl;

            // Get the browser host before we clear the reference
            CefRefPtr<CefBrowserHost> host = browser->GetHost();

            // First, hide the browser window to make removal appear instant
            HWND browserHwnd = host->GetWindowHandle();
            if (browserHwnd) {
                ShowWindow(browserHwnd, SW_HIDE);
            }

            // Invalidate the render handler's OSR window pointer BEFORE async close.
            // CEF may still fire OnPaint() callbacks during the close sequence, and
            // the OSRWindow will be deleted when this CEFView is destroyed.
            if (client) {
                client->ClearOSRWindow();
                client->PrepareForBrowserClose();
            }

            // Clean up global maps to prevent stale pointer access from window messages
            for (auto it = g_cefViews.begin(); it != g_cefViews.end(); ++it) {
                if (it->second == this) {
                    g_cefViews.erase(it);
                    break;
                }
            }
            for (auto it = g_cefClients.begin(); it != g_cefClients.end();) {
                if (it->second == client) {
                    it = g_cefClients.erase(it);
                } else {
                    ++it;
                }
            }

            // Clear our references
            browser = nullptr;
            client = nullptr;

            // Defer the actual browser close to avoid synchronous window message issues
            // Use CloseBrowser(true) to force close since we return true from DoClose
            // to prevent CEF from sending WM_CLOSE to parent window
            MainThreadDispatcher::dispatch_async([host]() {
                std::cout << "[CEF] Calling CloseBrowser(true) from dispatch_async" << std::endl;
                host->CloseBrowser(true);  // force=true since DoClose returns true
            });
        } else if (client) {
            // Async CreateBrowser may still be pending. Detaching the owner
            // callback makes OnAfterCreated close that browser immediately
            // instead of attaching it to a view that has already been removed.
            CefRefPtr<ElectrobunCefClient> pendingClient = client;
            pendingClient->PrepareForBrowserClose();
            client = nullptr;

            for (auto it = g_cefViews.begin(); it != g_cefViews.end();) {
                if (it->second == this) {
                    it = g_cefViews.erase(it);
                } else {
                    ++it;
                }
            }
            for (auto it = g_cefClients.begin(); it != g_cefClients.end();) {
                if (it->second == pendingClient) {
                    it = g_cefClients.erase(it);
                } else {
                    ++it;
                }
            }
        }
    }
    
    bool canGoBack() override {
        if (browser) {
            return browser->CanGoBack();
        }
        return false;
    }
    
    bool canGoForward() override {
        if (browser) {
            return browser->CanGoForward();
        }
        return false;
    }
    
    void evaluateJavaScriptWithNoCompletion(const char* jsString) override {
        if (browser) {
            // Copy string to avoid lifetime issues in lambda
            std::string jsStringCopy = jsString;
            MainThreadDispatcher::dispatch_sync([this, jsStringCopy]() {
                browser->GetMainFrame()->ExecuteJavaScript(jsStringCopy.c_str(), "", 0);
            });
        }
    }
    
    void callAsyncJavascript(const char* messageId, const char* jsString, uint32_t webviewId, uint32_t hostWebviewId, void* completionHandler) override {
        if (browser) {
            // CEF async JavaScript execution would need additional implementation
            browser->GetMainFrame()->ExecuteJavaScript(jsString, "", 0);
        }
    }
    
    void addPreloadScriptToWebView(const char* jsString) override {
        if (!jsString) return;
        
        // For CEF, preload scripts are typically handled via CefClient::OnContextCreated
        // For now, store the script to be injected when the context is created
        if (browser) {
            browser->GetMainFrame()->ExecuteJavaScript(jsString, browser->GetMainFrame()->GetURL(), 0);
        }
    }
    
    void updateCustomPreloadScript(const char* jsString) override {
        if (!jsString) return;
        
        // Check if this is a views:// URL for a script file
        if (strncmp(jsString, "views://", 8) == 0) {
            // Read the script file using existing WebView2 logic
            std::string scriptContent = loadViewsFile(normalizeViewsRelativePath(jsString));
            if (!scriptContent.empty()) {
                if (browser) {
                    browser->GetMainFrame()->ExecuteJavaScript(scriptContent.c_str(), browser->GetMainFrame()->GetURL(), 0);
                }
            } else {
                log(std::string("CEFView: Could not read preload script from: ") + std::string(jsString));
            }
        } else {
            // Inline JavaScript
            if (browser) {
                browser->GetMainFrame()->ExecuteJavaScript(jsString, browser->GetMainFrame()->GetURL(), 0);
            }
        }
    }
    
    // CEF-specific methods
    void setBrowser(CefRefPtr<CefBrowser> br) {
        findSession.reset();
        browser = br;
        // If OSR mode, also set the browser on the OSR window for event handling
        if (osr_window) {
            osr_window->SetBrowser(br);
        }

        // Async creation may take longer than constructor-adjacent calls such
        // as BrowserView's deferred HTML load. Apply only the latest queued
        // navigation after OnAfterCreated has installed all browser mappings.
        if (browser && has_pending_html) {
            std::string html = std::move(pending_html);
            pending_html.clear();
            has_pending_html = false;
            loadHTML(html.c_str());
        } else if (browser && has_pending_url) {
            std::string url = std::move(pending_url);
            pending_url.clear();
            has_pending_url = false;
            loadURL(url.c_str());
        }
    }
    
    void setClient(CefRefPtr<ElectrobunCefClient> cl) {
        client = cl;
    }
    
    CefRefPtr<CefBrowser> getBrowser() {
        return browser;
    }
    
    CefRefPtr<ElectrobunCefClient> getClient() {
        return client;
    }

    void notifyParentWindowPositionChanged() override {
        if (!browser) return;
        browser->GetHost()->NotifyScreenInfoChanged();
        browser->GetHost()->NotifyMoveOrResizeStarted();
    }

    void focus() override {
        if (browser) {
            browser->GetHost()->SetFocus(true);
        } else {
            AbstractView::focus();
        }
    }
    
    void resize(const RECT& frame, const char* masksJson) override {
        if (browser) {
            int width = frame.right - frame.left;
            int height = frame.bottom - frame.top;

            if (is_osr_mode) {
                // Windowless CEF has no child HWND to resize. Its render handler
                // owns a physical-pixel surface but exposes a DIP viewport to
                // CEF. Refresh screen info before repainting so a monitor move
                // updates devicePixelRatio as well as the buffer dimensions.
                if (client) client->SetOSRViewSize(width, height);
                browser->GetHost()->NotifyScreenInfoChanged();
            } else {
                // Get the CEF browser's window handle and update its position/size
                HWND browserHwnd = browser->GetHost()->GetWindowHandle();
                if (browserHwnd) {
                    SetWindowPos(browserHwnd, HWND_TOP, frame.left, frame.top, width, height,
                               SWP_NOACTIVATE | SWP_SHOWWINDOW);
                }
            }

            // Notify CEF that the browser was resized
            browser->GetHost()->WasResized();
            visualBounds = frame;

            bool maskChanged = false;
            // Check if masksJson is nullptr, empty, or just "[]" (empty array)
            if (masksJson && strlen(masksJson) > 0 && strcmp(masksJson, "[]") != 0) {
                std::string newMaskJSON = masksJson;
                if (newMaskJSON != maskJSON) {
                    maskJSON = newMaskJSON;
                    maskChanged = true;
                }
            } else if (!maskJSON.empty()) {
                maskJSON = "";
                maskChanged = true;
            }

            // Only apply visual mask if mask data changed
            if (maskChanged) {
                applyVisualMask();
            }
        }
    }

    // CEF-specific implementation of mask functionality
    void applyVisualMask() override {
        if (!browser) {
            return;
        }
        
        HWND browserHwnd = browser->GetHost()->GetWindowHandle();
        if (!browserHwnd) {
            return;
        }
        
        if (maskJSON.empty()) {
            // Remove any existing mask by setting full window region
            RECT windowRect;
            GetClientRect(browserHwnd, &windowRect);
            HRGN fullRegion = CreateRectRgn(0, 0, windowRect.right, windowRect.bottom);
            SetWindowRgn(browserHwnd, fullRegion, TRUE);
            return;
        }
        
        try {
            // Get the CEF browser window bounds
            RECT bounds = visualBounds;
            int width = bounds.right - bounds.left;
            int height = bounds.bottom - bounds.top;
            
            if (width <= 0 || height <= 0) {
                return;
            }
            
            // Create base region covering entire browser window
            HRGN browserRegion = CreateRectRgn(0, 0, width, height);
            
            // Parse maskJSON and subtract mask regions (holes)
            size_t pos = 0;
            int maskCount = 0;
            while ((pos = maskJSON.find("\"x\":", pos)) != std::string::npos) {
                try {
                    // Extract mask rectangle coordinates  
                    size_t xStart = maskJSON.find(":", pos) + 1;
                    size_t xEnd = maskJSON.find(",", xStart);
                    int x = std::stoi(maskJSON.substr(xStart, xEnd - xStart));
                    
                    size_t yPos = maskJSON.find("\"y\":", pos);
                    size_t yStart = maskJSON.find(":", yPos) + 1;
                    size_t yEnd = maskJSON.find(",", yStart);
                    int y = std::stoi(maskJSON.substr(yStart, yEnd - yStart));
                    
                    size_t wPos = maskJSON.find("\"width\":", pos);
                    size_t wStart = maskJSON.find(":", wPos) + 1;
                    size_t wEnd = maskJSON.find(",", wStart);
                    if (wEnd == std::string::npos) wEnd = maskJSON.find("}", wStart);
                    int maskWidth = std::stoi(maskJSON.substr(wStart, wEnd - wStart));
                    
                    size_t hPos = maskJSON.find("\"height\":", pos);
                    size_t hStart = maskJSON.find(":", hPos) + 1;
                    size_t hEnd = maskJSON.find("}", hStart);
                    int maskHeight = std::stoi(maskJSON.substr(hStart, hEnd - hStart));
                    
                    // Mask JSON is in DIPs; Win32 regions use client pixels.
                    const RECT holeBounds =
                        electrobun::logicalToPhysicalRect(
                            x,
                            y,
                            maskWidth,
                            maskHeight,
                            parentDpi());
                    HRGN holeRegion = CreateRectRgn(
                        holeBounds.left,
                        holeBounds.top,
                        holeBounds.right,
                        holeBounds.bottom);
                    if (holeRegion) {
                        CombineRgn(browserRegion, browserRegion, holeRegion, RGN_DIFF);
                        DeleteObject(holeRegion);
                        maskCount++;
                    }
                    
                    pos = hEnd;
                } catch (const std::exception& e) {
                    pos++;
                }
            }
            
            if (maskCount > 0) {
                // Apply the region with holes to the CEF browser window
                SetWindowRgn(browserHwnd, browserRegion, TRUE);
            } else {
                // No valid masks found, clean up
                DeleteObject(browserRegion);
            }
            
        } catch (const std::exception& e) {
            // Silent error handling
        }
    }
    
    void removeMasks() override {
        if (!browser) {
            return;
        }
        
        HWND browserHwnd = browser->GetHost()->GetWindowHandle();
        if (!browserHwnd) {
            return;
        }
        
        // Remove window region to restore full visibility
        SetWindowRgn(browserHwnd, NULL, TRUE);
    }
    
    void toggleMirrorMode(bool enable) override {
        if (enable && !mirrorModeEnabled) {
            mirrorModeEnabled = true;
            // CEF-specific input disabling
            if (browser) {
                HWND browserHwnd = browser->GetHost()->GetWindowHandle();
                if (browserHwnd) {
                    // Disable input by making the window non-interactive
                    EnableWindow(browserHwnd, FALSE);
                    // char logMsg[128];
                    // sprintf_s(logMsg, "CEF mirror mode: Disabled input for browser HWND=%p", browserHwnd);
                    // ::log(logMsg);
                }
            }
        } else if (!enable && mirrorModeEnabled) {
            mirrorModeEnabled = false;
            // CEF-specific input enabling
            if (browser) {
                HWND browserHwnd = browser->GetHost()->GetWindowHandle();
                if (browserHwnd) {
                    // Enable input by making the window interactive again
                    EnableWindow(browserHwnd, TRUE);
                    // char logMsg[128];
                    // sprintf_s(logMsg, "CEF mirror mode: Enabled input for browser HWND=%p", browserHwnd);
                    // ::log(logMsg);
                }
            }
        }
    }
    
    // Override transparency implementation for CEF
    // On Windows, transparency for CEF is implemented as hiding/showing since SetLayeredWindowAttributes often fails on child windows
    void setTransparent(bool transparent) override {
        if (!browser) {
            return;
        }
        
        HWND browserHwnd = browser->GetHost()->GetWindowHandle();
        if (!browserHwnd) {
            return;
        }
        
        if (transparent) {
            // For transparency, hide the window completely
            ShowWindow(browserHwnd, SW_HIDE);
        } else {
            // For opacity, show the window
            ShowWindow(browserHwnd, SW_SHOW);
        }
    }
    
    // Override passthrough implementation for CEF
    void setPassthrough(bool enable) override {
        AbstractView::setPassthrough(enable); // Call base implementation to set the flag

        if (!browser) {
            return;
        }

        HWND browserHwnd = browser->GetHost()->GetWindowHandle();
        if (!browserHwnd) {
            return;
        }

        // Why: WS_EX_TRANSPARENT only suppresses hit-testing for layered
        // top-level windows. The CEF browser HWND is a non-layered child of
        // the container, so the OS ignores that bit and clicks still land on
        // the browser. Disabling the HWND instead causes the OS to skip its
        // entire subtree during input dispatch, so clicks fall up to the
        // container — which matches the WGPUView passthrough behavior.
        EnableWindow(browserHwnd, enable ? FALSE : TRUE);
    }
    
    // Override hidden implementation for CEF
    // On Windows, setHidden is an alias for setTransparent since transparency provides the desired hide + passthrough behavior
    void setHidden(bool hidden) override {
        // Use the working transparency implementation which provides hide + passthrough behavior
        setTransparent(hidden);

        // Also handle the container window using base implementation
        AbstractView::setHidden(hidden);
    }

    // Forward window messages to OSR window for event handling
    void HandleWindowMessage(UINT message, WPARAM wParam, LPARAM lParam) {
        if (osr_window) {
            if (message >= WM_MOUSEFIRST && message <= WM_MOUSELAST) {
                osr_window->HandleMouseEvent(message, wParam, lParam);
            } else if (message >= WM_KEYFIRST && message <= WM_KEYLAST) {
                osr_window->HandleKeyEvent(message, wParam, lParam);
            }
        }
    }

    void findInPage(const char* searchText, bool forward, bool matchCase) override {
        if (!searchText || strlen(searchText) == 0) {
            findSession.reset();
            if (!browser) return;

            CefRefPtr<CefBrowserHost> host = browser->GetHost();
            if (host) {
                host->StopFinding(true);
            }
            return;
        }

        if (!browser) return;

        CefRefPtr<CefBrowserHost> host = browser->GetHost();
        if (!host) return;

        const bool findNext = findSession.begin(searchText, matchCase);
        if (!findNext) {
            host->StopFinding(true);
        }

        host->Find(CefString(searchText), forward, matchCase, findNext);
    }

    void stopFindInPage() override {
        findSession.reset();
        if (!browser) return;

        CefRefPtr<CefBrowserHost> host = browser->GetHost();
        if (host) {
            host->StopFinding(true);
        }
    }

    void openDevTools() override {
        if (!browser || !client) return;
        client->OpenRemoteDevToolsFrontend(browser);
    }

    void closeDevTools() override {
        if (!browser || !client) return;
        int target_id = browser->GetIdentifier();
        client->OnRemoteDevToolsClosed(target_id, false);
    }

    void toggleDevTools() override {
        if (!browser || !client) return;
        int target_id = browser->GetIdentifier();
        if (client->IsDevToolsOpen(target_id)) {
            client->OnRemoteDevToolsClosed(target_id, false);
        } else {
            client->OpenRemoteDevToolsFrontend(browser);
        }
    }
};

// WGPUView class - simple native child window surface
class WGPUView : public AbstractView {
public:
    WGPUView(uint32_t webviewId) {
        this->webviewId = webviewId;
    }

    void loadURL(const char* urlString) override {}
    void loadHTML(const char* htmlString) override {}
    void goBack() override {}
    void goForward() override {}
    void reload() override {}
    bool canGoBack() override { return false; }
    bool canGoForward() override { return false; }
    void evaluateJavaScriptWithNoCompletion(const char* jsString) override {}
    void callAsyncJavascript(const char* messageId, const char* jsString, uint32_t webviewId, uint32_t hostWebviewId, void* completionHandler) override {}
    void addPreloadScriptToWebView(const char* jsString) override {}
    void updateCustomPreloadScript(const char* jsString) override {}

    void resize(const RECT& frame, const char* masksJson) override {
        if (hwnd) {
            int width = frame.right - frame.left;
            int height = frame.bottom - frame.top;
            // Layout-driven moves and WM_SIZE updates must not promote this
            // child above sibling native layers. In particular, resizing a
            // full-size UIWindow surface must leave embedded webviews above
            // it. AddAbstractView/BringViewToFront owns explicit z-ordering.
            SetWindowPos(hwnd, nullptr, frame.left, frame.top, width, height,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOZORDER);
        }
        visualBounds = frame;
        bool maskChanged = false;
        if (masksJson && strlen(masksJson) > 0 && strcmp(masksJson, "[]") != 0) {
            std::string newMaskJSON = masksJson;
            if (newMaskJSON != maskJSON) {
                maskJSON = newMaskJSON;
                maskChanged = true;
            }
        } else if (!maskJSON.empty()) {
            maskJSON = "";
            maskChanged = true;
        }

        if (maskChanged) {
            applyVisualMask();
        }
    }

    void setTransparent(bool transparent) override {
        if (!hwnd) return;
        LONG exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
        SetWindowLong(hwnd, GWL_EXSTYLE, exStyle | WS_EX_LAYERED);
        BYTE alpha = transparent ? 0 : 255;
        SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);
    }

    void setPassthrough(bool enable) override {
        AbstractView::setPassthrough(enable);
        if (hwnd) {
            EnableWindow(hwnd, enable ? FALSE : TRUE);
        }
    }

    void setHidden(bool hidden) override {
        if (hwnd) {
            ShowWindow(hwnd, hidden ? SW_HIDE : SW_SHOW);
        }
    }

    void applyVisualMask() override {
        if (!hwnd) return;

        if (maskJSON.empty()) {
            RECT windowRect;
            GetClientRect(hwnd, &windowRect);
            HRGN fullRegion = CreateRectRgn(0, 0, windowRect.right, windowRect.bottom);
            SetWindowRgn(hwnd, fullRegion, TRUE);
            return;
        }

        try {
            int width = visualBounds.right - visualBounds.left;
            int height = visualBounds.bottom - visualBounds.top;
            if (width <= 0 || height <= 0) return;

            HRGN baseRegion = CreateRectRgn(0, 0, width, height);

            size_t pos = 0;
            while ((pos = maskJSON.find("\"x\":", pos)) != std::string::npos) {
                try {
                    size_t xStart = maskJSON.find(":", pos) + 1;
                    size_t xEnd = maskJSON.find(",", xStart);
                    int x = std::stoi(maskJSON.substr(xStart, xEnd - xStart));

                    size_t yPos = maskJSON.find("\"y\":", pos);
                    size_t yStart = maskJSON.find(":", yPos) + 1;
                    size_t yEnd = maskJSON.find(",", yStart);
                    int y = std::stoi(maskJSON.substr(yStart, yEnd - yStart));

                    size_t wPos = maskJSON.find("\"width\":", pos);
                    size_t wStart = maskJSON.find(":", wPos) + 1;
                    size_t wEnd = maskJSON.find(",", wStart);
                    if (wEnd == std::string::npos) wEnd = maskJSON.find("}", wStart);
                    int maskWidth = std::stoi(maskJSON.substr(wStart, wEnd - wStart));

                    size_t hPos = maskJSON.find("\"height\":", pos);
                    size_t hStart = maskJSON.find(":", hPos) + 1;
                    size_t hEnd = maskJSON.find("}", hStart);
                    int maskHeight = std::stoi(maskJSON.substr(hStart, hEnd - hStart));

                    const RECT holeBounds =
                        electrobun::logicalToPhysicalRect(
                            x,
                            y,
                            maskWidth,
                            maskHeight,
                            parentDpi());
                    HRGN holeRegion = CreateRectRgn(
                        holeBounds.left,
                        holeBounds.top,
                        holeBounds.right,
                        holeBounds.bottom);
                    if (holeRegion) {
                        CombineRgn(baseRegion, baseRegion, holeRegion, RGN_DIFF);
                        DeleteObject(holeRegion);
                    }

                    pos = hEnd;
                } catch (...) {
                    pos++;
                }
            }

            SetWindowRgn(hwnd, baseRegion, TRUE);
        } catch (...) {
            // Ignore mask parse errors
        }
    }

    void removeMasks() override {
        if (!hwnd) return;
        RECT windowRect;
        GetClientRect(hwnd, &windowRect);
        HRGN fullRegion = CreateRectRgn(0, 0, windowRect.right, windowRect.bottom);
        SetWindowRgn(hwnd, fullRegion, TRUE);
        maskJSON.clear();
    }
    void toggleMirrorMode(bool enable) override {}

    void findInPage(const char* searchText, bool forward, bool matchCase) override {}
    void stopFindInPage() override {}
    void openDevTools() override {}
    void closeDevTools() override {}
    void toggleDevTools() override {}

    void remove() override {
        if (hwnd) {
            DestroyWindow(hwnd);
            hwnd = NULL;
        }
    }
};

// Helper function to set browser on CEFView (defined after CEFView class)
void SetBrowserOnCEFView(HWND parentWindow, CefRefPtr<CefBrowser> browser) {
    auto viewIt = g_cefViews.find(parentWindow);
    if (viewIt != g_cefViews.end()) {
        auto view = static_cast<CEFView*>(viewIt->second);
        if (view) {
            view->setBrowser(browser);
            
            // Trigger an immediate resize to bring CEF browser to front
            // The resize method will handle the z-ordering
            RECT currentBounds = view->visualBounds;
            view->resize(currentBounds, nullptr);
        }
    }
}

// Helper function to set webview on WebView2View (defined after WebView2View class)
void SetWebViewOnWebView2View(HWND containerWindow, void* webview) {
    std::cout << "[WebView2] Looking for WebView2View with containerWindow: " << containerWindow << std::endl;
    auto viewIt = g_webview2Views.find(containerWindow);
    if (viewIt != g_webview2Views.end()) {
        auto view = static_cast<WebView2View*>(viewIt->second);
        if (view) {
            // WebView2 is already set in the controller creation callback
            std::cout << "[WebView2] Found WebView2View for webview ID: " << view->webviewId << std::endl;
        } else {
            std::cout << "[WebView2] Found WebView2View entry but view is null" << std::endl;
        }
    } else {
        std::cout << "[WebView2] No WebView2View found for containerWindow: " << containerWindow << std::endl;
    }
}

// ContainerView class definition
class ContainerView {
private:
    HWND m_hwnd;
    HWND m_parentWindow;
    std::vector<std::shared_ptr<AbstractView>> m_abstractViews;
    
    // Input management
    AbstractView* m_activeWebView = nullptr;  // Currently active webview for input
    
    // Window procedure for the container
    static LRESULT CALLBACK ContainerWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        ContainerView* container = nullptr;
        
        if (msg == WM_NCCREATE) {
            CREATESTRUCTW* cs = reinterpret_cast<CREATESTRUCTW*>(lParam);
            container = (ContainerView*)cs->lpCreateParams;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)container);
            // CreateWindowExW sends WM_NCCREATE before it returns, so bind the
            // HWND now. HandleMessage's DefWindowProcW call must receive this
            // real handle or window creation returns FALSE and falls back to
            // the STATIC class. See #458.
            if (container) {
                container->m_hwnd = hwnd;
            }
        } else {
            container = (ContainerView*)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
        }
        
        if (container) {
            return container->HandleMessage(msg, wParam, lParam);
        }
        
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
    
    LRESULT HandleMessage(UINT msg, WPARAM wParam, LPARAM lParam) {
        switch (msg) {
            case WM_SIZE: {
                // // Resize all full-size webviews when container resizes
                // int width = LOWORD(lParam);
                // int height = HIWORD(lParam);
                
                // for (auto& view : m_abstractViews) {
                //     if (view->fullSize) {
                //         // Resize the webview to match container
                //         if (view->controller) {
                //             RECT bounds = {0, 0, width, height};
                //             view->controller->put_Bounds(bounds);
                //         }
                //     }
                // }
                int width = LOWORD(lParam);
                int height = HIWORD(lParam);
                
                ResizeAutoSizingViews(width, height);
                
                break;
            }
            
            case WM_MOUSEMOVE: {
                POINT mousePos = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
                UpdateActiveWebviewForMousePosition(mousePos);
                break;
            }
            
            case WM_PAINT: {
                PAINTSTRUCT ps;
                HDC hdc = BeginPaint(m_hwnd, &ps);
                // Don't draw anything - let child windows handle their own painting
                EndPaint(m_hwnd, &ps);
                return 0;
            }
        }
        
        return DefWindowProcW(m_hwnd, msg, wParam, lParam);
    }
    
    void UpdateActiveWebviewForMousePosition(POINT mousePos) {
        AbstractView* newActiveView = nullptr;
        
        // Iterate through webviews in reverse order (top-most first)
        for (auto it = m_abstractViews.rbegin(); it != m_abstractViews.rend(); ++it) {
            auto& view = *it;
            
            if (view->isMousePassthroughEnabled) {
                // Skip passthrough webviews
                view->toggleMirrorMode(true);
                continue;
            }
            
            if (!newActiveView) {
                // Check if mouse is over this webview's bounds
                RECT viewBounds = view->visualBounds;
                
                // For WebView2, try to get actual bounds
                auto webview2 = std::dynamic_pointer_cast<WebView2View>(view);
                auto cefView = std::dynamic_pointer_cast<CEFView>(view);
                
                if (webview2 && webview2->getController()) {
                    webview2->getController()->get_Bounds(&viewBounds);
                } else if (cefView && cefView->getBrowser()) {
                    // For CEF, use the visualBounds which are set by resize
                    viewBounds = view->visualBounds;
                }
                
                if (PtInRect(&viewBounds, mousePos)) {
                    // Convert to local coordinates for mask checking
                    POINT localPoint = {
                        mousePos.x - viewBounds.left,
                        mousePos.y - viewBounds.top
                    };
                    
                    // Check if point is in a masked (cut-out) area
                    if (view->isPointInMask(localPoint)) {
                        // Point is in masked area, don't make this webview active
                        // Continue to check lower webviews
                        view->toggleMirrorMode(true);
                        continue;
                    }
                    
                    // Point is in unmasked area, make this webview active
                    newActiveView = view.get();
                    view->toggleMirrorMode(false);
                    continue;
                }
            }
            
            // All other webviews are non-interactive
            view->toggleMirrorMode(true);
        }
        
        // Update active webview for input routing
        m_activeWebView = newActiveView;
    }
    

    struct EnumChildData {
        RECT targetBounds;
        HWND containerHwnd;
    };
    
    static BOOL CALLBACK EnumChildCallback(HWND child, LPARAM lParam) {
        EnumChildData* data = (EnumChildData*)lParam;
        
        char className[256];
        GetClassNameA(child, className, sizeof(className));
        
        // Look for WebView2/Chrome child windows
        if (strstr(className, "Chrome_WidgetWin") || 
            strstr(className, "Chrome_RenderWidgetHostHWND")) {
            
            RECT childRect;
            GetWindowRect(child, &childRect);
            
            // Convert to container coordinates
            POINT topLeft = {childRect.left, childRect.top};
            POINT bottomRight = {childRect.right, childRect.bottom};
            ScreenToClient(data->containerHwnd, &topLeft);
            ScreenToClient(data->containerHwnd, &bottomRight);
            
            // Check if this matches our WebView's bounds (with some tolerance)
            if (abs(topLeft.x - data->targetBounds.left) < 5 && 
                abs(topLeft.y - data->targetBounds.top) < 5) {
                // This is likely our WebView's child window
                SetWindowPos(child, HWND_TOP, 0, 0, 0, 0,
                           SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                return FALSE; // Stop enumeration
            }
        }
        return TRUE; // Continue enumeration
    }
    
    void BringWebView2ChildWindowToFront(AbstractView* view) {
        // Cast to WebView2View to access controller
        auto webview2 = dynamic_cast<WebView2View*>(view);
        if (!webview2 || !webview2->getController()) return;
        
        // Get the bounds of this WebView to identify its child window
        RECT viewBounds;
        webview2->getController()->get_Bounds(&viewBounds);
        
        EnumChildData enumData;
        enumData.targetBounds = viewBounds;
        enumData.containerHwnd = m_hwnd;
        
        // Find and bring the WebView2's child window to front
        EnumChildWindows(m_hwnd, EnumChildCallback, (LPARAM)&enumData);
    }
    
    void BringCEFChildWindowToFront(AbstractView* view) {
        // Cast to CEFView to access browser
        auto cefView = dynamic_cast<CEFView*>(view);
        if (!cefView || !cefView->getBrowser()) return;
        
        CefRefPtr<CefBrowser> browser = cefView->getBrowser();
        if (!browser) return;
        
        // Get the CEF browser's window handle
        HWND browserHwnd = browser->GetHost()->GetWindowHandle();
        if (!browserHwnd) return;
        
        // char logMsg[256];
        // sprintf_s(logMsg, "BringCEFChildWindowToFront: Bringing CEF browser HWND=%p to front", browserHwnd);
        // ::log(logMsg);
        
        // Bring the CEF browser window to front
        SetWindowPos(browserHwnd, HWND_TOP, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

public:
    ContainerView(HWND parentWindow) : m_parentWindow(parentWindow), m_hwnd(NULL) {
        // Double-check parent window is valid
        if (!IsWindow(parentWindow)) {
            ::log("ERROR: Parent window handle is invalid in ContainerView constructor");
            return;
        }
        
        // Get parent window client area
        RECT clientRect;
        if (!GetClientRect(parentWindow, &clientRect)) {
            DWORD error = GetLastError();
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Failed to get parent window client rect, error: %lu", error);
            ::log(errorMsg);
            return;
        }
        
        // Validate that we have a reasonable client area
        int width = clientRect.right - clientRect.left;
        int height = clientRect.bottom - clientRect.top;
        
        if (width <= 0 || height <= 0) {
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Parent window has invalid client area: %dx%d", width, height);
            ::log(errorMsg);
            return;
        }
        
        // Register our custom window class for proper event handling
        static bool classRegistered = false;
        bool useStaticClass = false;
        if (!classRegistered) {
            WNDCLASSW wc = {0};
            wc.lpfnWndProc = ContainerWndProc;
            wc.hInstance = g_hInstanceDll;
            wc.lpszClassName = L"ContainerViewClass";
            wc.hbrBackground = NULL; // Transparent background
            wc.hCursor = LoadCursorW(NULL, MAKEINTRESOURCEW(32512));
            wc.style = CS_HREDRAW | CS_VREDRAW | CS_GLOBALCLASS;
            
            if (!RegisterClassW(&wc)) {
                DWORD error = GetLastError();
                if (error != ERROR_CLASS_ALREADY_EXISTS) {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "ERROR: Failed to register ContainerViewClass, error: %lu", error);
                    ::log(errorMsg);
                    useStaticClass = true;
                }
            }
            if (!useStaticClass) {
                classRegistered = true;
            }
        }
        
        // Try creating with our custom class first
        if (!useStaticClass) {
            m_hwnd = CreateWindowExW(
                0,
                L"ContainerViewClass",
                L"",  // No title text
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                0, 0, width, height,
                parentWindow,
                NULL,
                g_hInstanceDll,
                this   // Pass this pointer for message handling
            );
        }
        
        if (!m_hwnd) {
            if (!useStaticClass) {
                DWORD error = GetLastError();
                char errorMsg[256];
                sprintf_s(errorMsg, "Custom class failed (error: %lu), falling back to STATIC class", error);
                ::log(errorMsg);
            }

            // Fallback to STATIC class
            m_hwnd = CreateWindowExW(
                0,
                L"STATIC",
                L"",  // No title text
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                0, 0, width, height,
                parentWindow,
                NULL,
                g_hInstanceDll,
                NULL
            );
            
            if (!m_hwnd) {
                DWORD error = GetLastError();
                char errorMsg[256];
                sprintf_s(errorMsg, "ERROR: Failed to create container window even with STATIC class, error: %lu", error);
                ::log(errorMsg);
                return;
            } else {
            }
        } else {
        }
        
        if (m_hwnd) {
            // Verify the container window is valid
            if (!IsWindow(m_hwnd)) {
                ::log("ERROR: Container window creation returned handle but window is not valid");
                m_hwnd = NULL;
                return;
            }
            
            char successMsg[256];
        }
    }

    void ResizeAutoSizingViews(int width, int height) {
        for (auto& view : m_abstractViews) {
            if (view->fullSize) {
                // Resize the webview to match container
                RECT bounds = {0, 0, width, height};
                view->resize(bounds, nullptr);
                
                // char logMsg[256];
                // sprintf_s(logMsg, "Resized auto-sizing WebView %u to %dx%d", 
                //         view->webviewId, width, height);
                // ::log(logMsg);
            }
        }
    }

    void ResizeFixedViewsForDpi(UINT dpi) {
        for (auto& view : m_abstractViews) {
            if (view->fullSize) continue;
            RECT bounds = {};
            if (!view->physicalFrameForDpi(dpi, bounds)) continue;
            view->resize(bounds, view->maskJSON.c_str());
            // A DPI transition changes the pixel edges of an unchanged DIP
            // mask, so force region reconstruction even when the JSON itself
            // did not change.
            view->applyVisualMask();
        }
    }

    void NotifyParentWindowPositionChanged() {
        for (auto& view : m_abstractViews) {
            view->notifyParentWindowPositionChanged();
        }
    }

    void ReleaseCEFReferencesForShutdown() {
        for (auto& view : m_abstractViews) {
            if (auto cefView = std::dynamic_pointer_cast<CEFView>(view)) {
                cefView->ReleaseCEFReferencesForShutdown();
            }
        }
    }

    void FocusActiveView() {
        AbstractView* target = m_activeWebView;
        if (!target) {
            auto fullSizeView = std::find_if(
                m_abstractViews.begin(),
                m_abstractViews.end(),
                [](const std::shared_ptr<AbstractView>& view) {
                    return view->fullSize;
                });
            if (fullSizeView != m_abstractViews.end()) {
                target = fullSizeView->get();
            } else if (!m_abstractViews.empty()) {
                target = m_abstractViews.front().get();
            }
        }
        if (target) target->focus();
    }

    void BringViewToFront(AbstractView* targetView) {
        auto it = std::find_if(m_abstractViews.begin(), m_abstractViews.end(),
            [targetView](const std::shared_ptr<AbstractView>& view) {
                return view.get() == targetView;
            });
        
        if (it != m_abstractViews.end()) {
            auto view = *it;
            // Move to front of vector (most recent first)
            m_abstractViews.erase(it);
            m_abstractViews.insert(m_abstractViews.begin(), view);
            
            // Bring the appropriate child window to front
            auto webview2 = dynamic_cast<WebView2View*>(view.get());
            auto cefView = dynamic_cast<CEFView*>(view.get());
            
            if (webview2) {
                BringWebView2ChildWindowToFront(view.get());
            } else if (cefView) {
                BringCEFChildWindowToFront(view.get());
            } else if (view->hwnd) {
                SetWindowPos(view->hwnd, HWND_TOP, 0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
            }
        }
    }
    
    ~ContainerView() {
        // Explicitly remove each view before destroying HWNDs.
        // This lets CEFView::remove() defer CloseBrowser via dispatch_async
        // instead of ~CEFView() calling CloseBrowser(true) synchronously
        // on an already-destroyed HWND (which would crash).
        for (auto& view : m_abstractViews) {
            g_pendingResizeQueue.remove(view.get());
            if (g_eventLoopStopping.load()) {
                if (auto cefView = std::dynamic_pointer_cast<CEFView>(view)) {
                    // The parent hierarchy is already being destroyed by the
                    // CEF close handshake. Drop app-owned references without
                    // scheduling another CloseBrowser call after OnBeforeClose.
                    cefView->ReleaseCEFReferencesForShutdown();
                } else {
                    view->remove();
                }
            } else {
                view->remove();
            }
            if (dynamic_cast<WGPUView*>(view.get())) {
                releaseRetainedWGPUView(view.get());
            } else {
                untrackAbstractView(view.get());
                releaseRetainedAbstractView(view.get());
            }
        }
        if (m_hwnd) {
            DestroyWindow(m_hwnd);
        }
    }
    
    HWND GetHwnd() const { return m_hwnd; }
    
    void AddAbstractView(std::shared_ptr<AbstractView> view) {
    
        // Add to front of vector so it's top-most first
        m_abstractViews.insert(m_abstractViews.begin(), view); 
        BringViewToFront(view.get());
        
        // TODO: Temporarily disable mirror mode for CEF testing
        // Start new webviews in mirror mode (input disabled)
        // They will be made interactive when mouse hovers over them
        // view->toggleMirrorMode(true);
    }
    
    void RemoveAbstractView(AbstractView* targetView) {
        if (m_activeWebView == targetView) {
            m_activeWebView = nullptr;
        }
        m_abstractViews.erase(
            std::remove_if(m_abstractViews.begin(), m_abstractViews.end(),
                [targetView](const std::shared_ptr<AbstractView>& view) {
                    return view.get() == targetView;
                }),
            m_abstractViews.end());
    }
};

// Helper function to get or create container for a window
ContainerView* GetOrCreateContainer(HWND parentWindow) {
    // Validate the parent window handle
    if (!IsWindow(parentWindow)) {
        ::log("ERROR: Parent window handle is invalid");
        return nullptr;
    }
    
    auto it = g_containerViews.find(parentWindow);
    if (it == g_containerViews.end()) {
        
        auto container = std::make_unique<ContainerView>(parentWindow);
        ContainerView* containerPtr = container.get();
        
        // Only store if creation was successful
        if (containerPtr->GetHwnd() != NULL) {
            g_containerViews[parentWindow] = std::move(container);
            return containerPtr;
        } else {
            ::log("ERROR: Container creation failed, not storing");
            return nullptr;
        }
    }
    
    // log("Using existing container for window");
    return it->second.get();
}

// Stub classes for compatibility
class NSWindow {
public:
    void* contentView;
};



class MyScriptMessageHandlerWithReply {
public:
    HandlePostMessageWithReply zigCallback;
    uint32_t webviewId;
};

class WKWebView {
public:
    void* configuration;
};

struct NSRect {
    double x;
    double y;
    double width;
    double height;
};

struct createNSWindowWithFrameAndStyleParams {
    NSRect frame;
    uint32_t styleMask;
    const char *titleBarStyle;
};

// Define a struct to store window data
typedef struct {
    uint32_t windowId;
    WindowCloseHandler closeHandler;
    WindowShouldCloseHandler shouldCloseHandler;
    WindowMoveHandler moveHandler;
    WindowResizeHandler resizeHandler;
    WindowFocusHandler focusHandler;
    WindowBlurHandler blurHandler;
    WindowKeyHandler keyHandler;
    ChromeStyle chromeStyle;
    bool bypassShouldClose;
    wchar_t pendingHighSurrogate;
} WindowData;

// Text produced by TranslateMessage/WM_CHAR, after Windows has applied the
// active keyboard layout, dead keys, and IME composition. The value is one
// Unicode scalar; UTF-16 surrogate pairs are coalesced per window below.
typedef void (*WindowTextHandler)(uint32_t windowId, uint32_t codePoint);
static std::atomic<WindowTextHandler> g_windowTextHandler{nullptr};

extern "C" ELECTROBUN_EXPORT void setWindowTextHandler(WindowTextHandler handler) {
    g_windowTextHandler.store(handler, std::memory_order_release);
}

static void dispatchWindowText(WindowData* data, wchar_t codeUnit) {
    if (!data) return;
    WindowTextHandler handler =
        g_windowTextHandler.load(std::memory_order_acquire);
    if (!handler) return;

    const uint32_t value = static_cast<uint32_t>(codeUnit);
    if (value < 0x20 || value == 0x7f) {
        data->pendingHighSurrogate = 0;
        return;
    }
    if (value >= 0xd800 && value <= 0xdbff) {
        data->pendingHighSurrogate = codeUnit;
        return;
    }

    uint32_t codePoint = value;
    if (value >= 0xdc00 && value <= 0xdfff) {
        const uint32_t high =
            static_cast<uint32_t>(data->pendingHighSurrogate);
        data->pendingHighSurrogate = 0;
        if (high < 0xd800 || high > 0xdbff) return;
        codePoint = 0x10000 + ((high - 0xd800) << 10) + (value - 0xdc00);
    } else {
        // Drop an unmatched high surrogate rather than forwarding invalid
        // Unicode if a different character interrupted the pair.
        data->pendingHighSurrogate = 0;
    }

    handler(data->windowId, codePoint);
}

static bool readAppsUseDarkTheme(BOOL* useDarkTheme) {
    DWORD appsUseLightTheme = 1;
    DWORD valueSize = sizeof(appsUseLightTheme);
    LONG status = RegGetValueW(
        HKEY_CURRENT_USER,
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
        L"AppsUseLightTheme",
        RRF_RT_REG_DWORD,
        nullptr,
        &appsUseLightTheme,
        &valueSize);
    if (status != ERROR_SUCCESS) return false;

    *useDarkTheme = appsUseLightTheme == 0 ? TRUE : FALSE;
    return true;
}

static void updateWindowTheme(HWND hwnd) {
    using DwmSetWindowAttributeFn = HRESULT(WINAPI*)(HWND, DWORD, LPCVOID, DWORD);
    static HMODULE dwmApi = LoadLibraryW(L"dwmapi.dll");
    static auto setWindowAttribute = dwmApi
        ? reinterpret_cast<DwmSetWindowAttributeFn>(
              GetProcAddress(dwmApi, "DwmSetWindowAttribute"))
        : nullptr;
    if (!setWindowAttribute) return;

    BOOL useDarkTheme = FALSE;
    if (!readAppsUseDarkTheme(&useDarkTheme)) return;

    // Attribute 20 is DWMWA_USE_IMMERSIVE_DARK_MODE on current Windows SDKs.
    // Windows 10 1809 used the same behavior under attribute 19.
    HRESULT result = setWindowAttribute(
        hwnd, 20, &useDarkTheme, sizeof(useDarkTheme));
    if (FAILED(result)) {
        setWindowAttribute(hwnd, 19, &useDarkTheme, sizeof(useDarkTheme));
    }
}


// Handle application menu item selection
void handleApplicationMenuSelection(UINT menuId) {
    auto it = g_menuItemActions.find(menuId);
    if (it != g_menuItemActions.end()) {
        const std::string& action = it->second;
        
        // char logMsg[256];
        // sprintf_s(logMsg, "Application menu action: %s", action.c_str());
        // ::log(logMsg);
        
        if (g_appMenuTarget && g_appMenuTarget->zigHandler) {
            if (action == "__quit__") {
                if (g_quitRequestedHandler && !g_eventLoopStopping.load()) {
                    g_quitRequestedHandler();
                } else {
                    PostQuitMessage(0);
                }
            } else if (action == "__undo__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, WM_UNDO, 0, 0);
                }
            } else if (action == "__redo__") {
                // Windows doesn't have a standard WM_REDO message
                // Use Ctrl+Y keypress simulation or application-specific handling
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    // Try sending Ctrl+Y keystroke
                    keybd_event(VK_CONTROL, 0, 0, 0);
                    keybd_event('Y', 0, 0, 0);
                    keybd_event('Y', 0, KEYEVENTF_KEYUP, 0);
                    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
                }
            } else if (action == "__cut__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, WM_CUT, 0, 0);
                }
            } else if (action == "__copy__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, WM_COPY, 0, 0);
                }
            } else if (action == "__paste__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, WM_PASTE, 0, 0);
                }
            } else if (action == "__pasteAndMatchStyle__") {
                // Paste as plain text: get clipboard text and paste it without formatting
                HWND focusedWindow = GetFocus();
                if (focusedWindow && OpenClipboard(NULL)) {
                    HANDLE hData = GetClipboardData(CF_UNICODETEXT);
                    if (hData) {
                        wchar_t* pszText = static_cast<wchar_t*>(GlobalLock(hData));
                        if (pszText) {
                            // Clear clipboard and set as plain text
                            std::wstring text(pszText);
                            GlobalUnlock(hData);
                            EmptyClipboard();

                            HGLOBAL hMem = GlobalAlloc(GMEM_MOVEABLE, (text.length() + 1) * sizeof(wchar_t));
                            if (hMem) {
                                wchar_t* pMem = static_cast<wchar_t*>(GlobalLock(hMem));
                                if (pMem) {
                                    wcscpy(pMem, text.c_str());
                                    GlobalUnlock(hMem);
                                    SetClipboardData(CF_UNICODETEXT, hMem);
                                }
                            }
                        }
                    }
                    CloseClipboard();
                    // Now paste the plain text
                    SendMessage(focusedWindow, WM_PASTE, 0, 0);
                }
            } else if (action == "__delete__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, WM_CLEAR, 0, 0);
                }
            } else if (action == "__selectAll__") {
                HWND focusedWindow = GetFocus();
                if (focusedWindow) {
                    SendMessage(focusedWindow, EM_SETSEL, 0, -1);
                }
            } else if (action == "__minimize__") {
                HWND activeWindow = GetActiveWindow();
                if (activeWindow) {
                    ShowWindow(activeWindow, SW_MINIMIZE);
                }
            } else if (action == "__toggleFullScreen__") {
                HWND activeWindow = GetActiveWindow();
                if (activeWindow) {
                    // Toggle between maximized and normal state
                    WINDOWPLACEMENT wp = { sizeof(WINDOWPLACEMENT) };
                    GetWindowPlacement(activeWindow, &wp);
                    if (wp.showCmd == SW_MAXIMIZE) {
                        ShowWindow(activeWindow, SW_RESTORE);
                    } else {
                        ShowWindow(activeWindow, SW_MAXIMIZE);
                    }
                }
            } else if (action == "__zoom__") {
                HWND activeWindow = GetActiveWindow();
                if (activeWindow) {
                    // Zoom toggles between maximized and normal (same as toggleFullScreen on Windows)
                    WINDOWPLACEMENT wp = { sizeof(WINDOWPLACEMENT) };
                    GetWindowPlacement(activeWindow, &wp);
                    if (wp.showCmd == SW_MAXIMIZE) {
                        ShowWindow(activeWindow, SW_RESTORE);
                    } else {
                        ShowWindow(activeWindow, SW_MAXIMIZE);
                    }
                }
            } else if (action == "__close__") {
                HWND activeWindow = GetActiveWindow();
                if (activeWindow) {
                    PostMessage(activeWindow, WM_CLOSE, 0, 0);
                }
            } else {
                g_appMenuTarget->zigHandler(g_appMenuTarget->trayId, action.c_str());
            }
        }
    }
}


// Window procedure that will handle events and call your handlers
LRESULT CALLBACK WindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    // Get our custom data
    WindowData* data = (WindowData*)GetWindowLongPtr(hwnd, GWLP_USERDATA);
    
    switch (msg) {
        case WM_GETMINMAXINFO: {
            // WS_POPUP is used for hidden/custom chrome and otherwise maximizes
            // to rcMonitor, covering the taskbar. Clamp it to this monitor's
            // work area, including monitors with negative desktop coordinates.
            LONG_PTR style = GetWindowLongPtr(hwnd, GWL_STYLE);
            if ((style & WS_POPUP) != 0) {
                HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                MONITORINFO monitorInfo = { sizeof(MONITORINFO) };
                if (GetMonitorInfoW(monitor, &monitorInfo)) {
                    MINMAXINFO* minMaxInfo = reinterpret_cast<MINMAXINFO*>(lParam);
                    minMaxInfo->ptMaxPosition.x =
                        monitorInfo.rcWork.left - monitorInfo.rcMonitor.left;
                    minMaxInfo->ptMaxPosition.y =
                        monitorInfo.rcWork.top - monitorInfo.rcMonitor.top;
                    minMaxInfo->ptMaxSize.x =
                        monitorInfo.rcWork.right - monitorInfo.rcWork.left;
                    minMaxInfo->ptMaxSize.y =
                        monitorInfo.rcWork.bottom - monitorInfo.rcWork.top;
                    return 0;
                }
            }
            break;
        }

        case WM_DPICHANGED: {
            // Windows supplies a physical-pixel rectangle that preserves the
            // window's logical size on the destination monitor.
            const RECT* suggested = reinterpret_cast<const RECT*>(lParam);
            if (suggested) {
                SetWindowPos(
                    hwnd,
                    nullptr,
                    suggested->left,
                    suggested->top,
                    suggested->right - suggested->left,
                    suggested->bottom - suggested->top,
                    SWP_NOACTIVATE | SWP_NOZORDER);
            }
            auto containerIt = g_containerViews.find(hwnd);
            if (containerIt != g_containerViews.end()) {
                containerIt->second->ResizeFixedViewsForDpi(
                    HIWORD(wParam));
                containerIt->second->NotifyParentWindowPositionChanged();
            }
            return 0;
        }

        case WM_SETTINGCHANGE:
            // Windows broadcasts ImmersiveColorSet when the app color mode
            // changes. Re-reading for every settings broadcast is cheap and
            // also covers shell versions that use a different lParam string.
            updateWindowTheme(hwnd);
            break;

        case WM_NCCALCSIZE:
            if (wParam == TRUE && data && data->chromeStyle == ChromeStyle::HiddenInset) {
                NCCALCSIZE_PARAMS* p = (NCCALCSIZE_PARAMS*)lParam;
                RECT original = p->rgrc[0];
                LRESULT ret = DefWindowProcW(hwnd, msg, wParam, lParam);
                if (IsZoomed(hwnd)) {
                    // Maximized: clip client area to monitor work area so
                    // we still strip the caption bar without pushing content
                    // above the visible screen.
                    MONITORINFO mi = { sizeof(MONITORINFO) };
                    HMONITOR hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                    if (GetMonitorInfo(hmon, &mi)) {
                        p->rgrc[0].top = mi.rcWork.top;
                    }
                } else {
                    p->rgrc[0].top = original.top;
                }
                return ret;
            }
            break;

        case WM_INPUT: {
            if (g_isMovingWindow && g_targetWindow) {
                UINT dwSize = 0;
                GetRawInputData((HRAWINPUT)lParam, RID_INPUT, NULL, &dwSize, sizeof(RAWINPUTHEADER));
                
                LPBYTE lpb = new BYTE[dwSize];
                if (GetRawInputData((HRAWINPUT)lParam, RID_INPUT, lpb, &dwSize, sizeof(RAWINPUTHEADER)) == dwSize) {
                    RAWINPUT* raw = (RAWINPUT*)lpb;
                    
                    if (raw->header.dwType == RIM_TYPEMOUSE) {
                        // Check for mouse button release
                        if (raw->data.mouse.usButtonFlags & RI_MOUSE_LEFT_BUTTON_UP) {
                            // Stop window move
                            RAWINPUTDEVICE rid;
                            rid.usUsagePage = 0x01;
                            rid.usUsage = 0x02;
                            rid.dwFlags = RIDEV_REMOVE;
                            rid.hwndTarget = NULL;
                            
                            RegisterRawInputDevices(&rid, 1, sizeof(RAWINPUTDEVICE));
                            g_isMovingWindow = FALSE;
                            g_targetWindow = NULL;
                        }
                        
                        // Handle mouse movement using cursor position tracking
                        else if (raw->data.mouse.lLastX != 0 || raw->data.mouse.lLastY != 0) {
                            POINT currentCursor;
                            GetCursorPos(&currentCursor);
                            
                            // Calculate delta from initial cursor position when drag started
                            int deltaX = currentCursor.x - g_initialCursorPos.x;
                            int deltaY = currentCursor.y - g_initialCursorPos.y;
                            
                            // Calculate new window position
                            int newX = g_initialWindowPos.x + deltaX;
                            int newY = g_initialWindowPos.y + deltaY;
                            
                            SetWindowPos(g_targetWindow, NULL, newX, newY, 0, 0, 
                                       SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                        }
                    }
                }
                delete[] lpb;
            }
            break;
        }
        case WM_NCHITTEST:
            {
                // For layered windows, we need to handle hit testing to receive mouse events
                // Check if this is a CEF OSR window
                auto viewIt = g_cefViews.find(hwnd);
                if (viewIt != g_cefViews.end()) {
                    auto cefView = static_cast<CEFView*>(viewIt->second);
                    if (cefView && cefView->isOSRMode()) {
                        // Return HTCLIENT to indicate this is the client area and should receive mouse events
                        return HTCLIENT;
                    }
                }
            }
            break;

        case WM_COMMAND:
            // Check if this is an application menu command
            if (HIWORD(wParam) == 0) { // Menu item selected
                UINT menuId = LOWORD(wParam);
                handleApplicationMenuSelection(menuId);
                return 0;
            }
            break;

        // Forward mouse and keyboard events to CEF OSR view if present
        case WM_MOUSEMOVE:
        case WM_LBUTTONDOWN:
        case WM_LBUTTONUP:
        case WM_RBUTTONDOWN:
        case WM_RBUTTONUP:
        case WM_MBUTTONDOWN:
        case WM_MBUTTONUP:
        case WM_MOUSEWHEEL:
        case WM_KEYDOWN:
        case WM_KEYUP:
        case WM_CHAR:
        case WM_SYSKEYDOWN:
        case WM_SYSKEYUP:
        case WM_SYSCHAR:
            {
                // Check if this window has a CEF OSR view
                auto viewIt = g_cefViews.find(hwnd);
                if (viewIt != g_cefViews.end()) {
                    auto cefView = static_cast<CEFView*>(viewIt->second);
                    if (cefView && cefView->isOSRMode()) {
                        if (msg == WM_LBUTTONDOWN) {
                            printf("WindowProc: WM_LBUTTONDOWN received for OSR window\n");
                        }
                        cefView->HandleWindowMessage(msg, wParam, lParam);
                    }
                }

                // Dispatch keyboard events to keyHandler callback
                if (data && data->keyHandler &&
                    (msg == WM_KEYDOWN || msg == WM_KEYUP || msg == WM_SYSKEYDOWN || msg == WM_SYSKEYUP)) {
                    uint32_t keyCode = (uint32_t)wParam;
                    uint32_t modifiers = 0;
                    if (GetKeyState(VK_SHIFT) & 0x8000) modifiers |= 1 << 0;
                    if (GetKeyState(VK_CONTROL) & 0x8000) modifiers |= 1 << 1;
                    if (GetKeyState(VK_MENU) & 0x8000) modifiers |= 1 << 2;
                    uint32_t isDown = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) ? 1 : 0;
                    uint32_t isRepeat = (lParam & (1 << 30)) ? 1 : 0;
                    data->keyHandler(data->windowId, keyCode, modifiers, isDown, isRepeat);
                }

                // WM_KEYDOWN identifies editing/navigation keys; WM_CHAR is
                // the authoritative text stream. Ignore its control codes so
                // Backspace/Return are handled exactly once by keyDown.
                if (data && msg == WM_CHAR) {
                    dispatchWindowText(data, static_cast<wchar_t>(wParam));
                }
            }
            break;

        case WM_CLOSE:
            if (g_eventLoopStopping.load()) {
                DestroyWindow(hwnd);
                return 0;
            }
            if (data && data->shouldCloseHandler && !data->bypassShouldClose) {
                data->shouldCloseHandler(data->windowId);
                return 0;
            }
            if (data && data->closeHandler) {
                data->bypassShouldClose = false;
                data->closeHandler(data->windowId);
            }
            break;
            
        case WM_MOVE: {
            auto containerIt = g_containerViews.find(hwnd);
            if (containerIt != g_containerViews.end()) {
                containerIt->second->NotifyParentWindowPositionChanged();
            }
            if (data && data->moveHandler) {
                RECT physicalFrame = {};
                if (GetWindowRect(hwnd, &physicalFrame)) {
                    const auto monitor = electrobun::windowsMonitorForHandle(
                        MonitorFromRect(
                            &physicalFrame, MONITOR_DEFAULTTONEAREST));
                    const POINT logicalOrigin =
                        electrobun::physicalScreenPointToLogical(
                            physicalFrame.left,
                            physicalFrame.top,
                            monitor);
                    data->moveHandler(
                        data->windowId,
                        logicalOrigin.x,
                        logicalOrigin.y);
                }
            }
            break;
        }
            
        case WM_SIZE:
            {
                // Resize container to match window client area
                auto containerIt = g_containerViews.find(hwnd);
                if (containerIt != g_containerViews.end()) {
                    RECT clientRect;
                    GetClientRect(hwnd, &clientRect);
                    int width = clientRect.right - clientRect.left;
                    int height = clientRect.bottom - clientRect.top;
                    
                    // Resize the container window itself
                    SetWindowPos(containerIt->second->GetHwnd(), NULL, 
                        0, 0, width, height,
                        SWP_NOZORDER | SWP_NOACTIVATE);
                    
                    // Resize all auto-resizing webviews in this container
                    containerIt->second->ResizeAutoSizingViews(width, height);
                }
                
                if (data && data->resizeHandler) {
                    int width = LOWORD(lParam);
                    int height = HIWORD(lParam);
                    const UINT dpi = electrobun::windowsDpiForWindow(hwnd);
                    RECT physicalFrame = {};
                    POINT logicalOrigin = {};
                    if (GetWindowRect(hwnd, &physicalFrame)) {
                        const auto monitor =
                            electrobun::windowsMonitorForHandle(
                                MonitorFromRect(
                                    &physicalFrame,
                                    MONITOR_DEFAULTTONEAREST));
                        logicalOrigin =
                            electrobun::physicalScreenPointToLogical(
                                physicalFrame.left,
                                physicalFrame.top,
                                monitor);
                    }
                    data->resizeHandler(
                        data->windowId,
                        logicalOrigin.x,
                        logicalOrigin.y,
                        electrobun::physicalToLogicalCoordinate(width, dpi),
                        electrobun::physicalToLogicalCoordinate(height, dpi));
                }
            }
            break;

        case WM_ACTIVATE:
            // Window activation - WA_ACTIVE or WA_CLICKACTIVE means window is being activated
            if (LOWORD(wParam) == WA_INACTIVE) {
                if (data) data->pendingHighSurrogate = 0;
                if (data && data->blurHandler) {
                    data->blurHandler(data->windowId);
                }
            } else {
                if (data && data->focusHandler) {
                    data->focusHandler(data->windowId);
                }
            }
            break;

        case WM_PAINT:
            {
                PAINTSTRUCT ps;
                HDC hdc = BeginPaint(hwnd, &ps);
                // Don't need to do anything here, just validate the paint region
                EndPaint(hwnd, &ps);
            }
            return 0;
            
        case WM_TIMER:
            if (wParam == 1) {
                KillTimer(hwnd, 1);
                ::log("Timer fired - forcing window refresh");
                InvalidateRect(hwnd, NULL, TRUE);
                UpdateWindow(hwnd);
            }
            return 0;
            
        case WM_DESTROY:
            // Clean up application menu when main window is destroyed
            if (g_applicationMenu) {
                DestroyMenu(g_applicationMenu);
                g_applicationMenu = NULL;
            }
            g_appMenuTarget.reset();
            {
                std::lock_guard<std::mutex> lock(g_visibleOnAllWorkspacesMutex);
                g_visibleOnAllWorkspaces.erase(hwnd);
            }
            
            // Clean up container view
            g_containerViews.erase(hwnd);
            
            // Clean up window data
            if (data) {
                free(data);
                SetWindowLongPtr(hwnd, GWLP_USERDATA, 0);
            }
            break;
    }
    
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static void removeTransientNotificationIcon(HWND hwnd, UINT notificationId) {
    KillTimer(hwnd, notificationId);
    NOTIFYICONDATAW nid = {};
    nid.cbSize = sizeof(nid);
    nid.hWnd = hwnd;
    nid.uID = notificationId;
    Shell_NotifyIconW(NIM_DELETE, &nid);
}

static VOID CALLBACK transientNotificationTimerProc(
    HWND hwnd,
    UINT,
    UINT_PTR timerId,
    DWORD
) {
    removeTransientNotificationIcon(hwnd, static_cast<UINT>(timerId));
}

// handles window things on Windows
LRESULT CALLBACK MessageWindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_EXECUTE_SYNC_BLOCK:
            MainThreadDispatcher::handleSyncTask(lParam);
            return 0;
        case WM_EXECUTE_ASYNC_BLOCK:
            MainThreadDispatcher::handleSyncTask(lParam);
            return 0;
        case WM_ELECTROBUN_NOTIFICATION: {
            // NOTIFYICON_VERSION_4 places the event in LOWORD(lParam) and the
            // icon ID in HIWORD(lParam). Fall back to the legacy layout if the
            // shell rejected the version request.
            UINT eventCode = LOWORD(lParam);
            UINT notificationId = HIWORD(lParam);
            if (notificationId == 0) {
                eventCode = static_cast<UINT>(lParam);
                notificationId = static_cast<UINT>(wParam);
            }
            if (eventCode == NIN_BALLOONHIDE ||
                eventCode == NIN_BALLOONTIMEOUT ||
                eventCode == NIN_BALLOONUSERCLICK) {
                removeTransientNotificationIcon(hwnd, notificationId);
            }
            return 0;
        }
        default:
            return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
}


class NSStatusItem {
public:
    NOTIFYICONDATAW nid;
    HWND hwnd;
    uint32_t trayId;
    ZigStatusItemHandler handler;
    HMENU contextMenu;
    std::string title;
    std::string imagePath;
    
    NSStatusItem() {
        memset(&nid, 0, sizeof(NOTIFYICONDATAW));
        hwnd = NULL;
        trayId = 0;
        handler = nullptr;
        contextMenu = NULL;
    }
    
    ~NSStatusItem() {
        if (contextMenu) {
            DestroyMenu(contextMenu);
        }
        // Remove from system tray
        Shell_NotifyIconW(NIM_DELETE, &nid);
    }
};

// Global map to store tray items by their window handle
static std::map<HWND, NSStatusItem*> g_trayItems;
static UINT g_trayMessageId = WM_USER + 100;

struct SimpleJsonValue {
    enum Type { STRING, BOOL, ARRAY, OBJECT, UNKNOWN };
    Type type = UNKNOWN;
    std::string stringValue;
    bool boolValue = false;
    std::vector<SimpleJsonValue> arrayValue;
    std::map<std::string, SimpleJsonValue> objectValue;
};

// Simple JSON parsing functions
std::string trimWhitespace(const std::string& str) {
    size_t start = str.find_first_not_of(" \t\n\r");
    if (start == std::string::npos) return "";
    size_t end = str.find_last_not_of(" \t\n\r");
    return str.substr(start, end - start + 1);
}

std::string extractQuotedString(const std::string& json, size_t& pos) {
    if (pos >= json.length() || json[pos] != '"') return "";
    pos++; // Skip opening quote
    
    std::string result;
    while (pos < json.length() && json[pos] != '"') {
        if (json[pos] == '\\' && pos + 1 < json.length()) {
            pos++; // Skip escape character
            switch (json[pos]) {
                case 'n': result += '\n'; break;
                case 't': result += '\t'; break;
                case 'r': result += '\r'; break;
                case '\\': result += '\\'; break;
                case '"': result += '"'; break;
                default: result += json[pos]; break;
            }
        } else {
            result += json[pos];
        }
        pos++;
    }
    
    if (pos < json.length() && json[pos] == '"') {
        pos++; // Skip closing quote
    }
    
    return result;
}

SimpleJsonValue parseJsonValue(const std::string& json, size_t& pos);

SimpleJsonValue parseJsonObject(const std::string& json, size_t& pos) {
    SimpleJsonValue obj;
    obj.type = SimpleJsonValue::OBJECT;
    
    if (pos >= json.length() || json[pos] != '{') return obj;
    pos++; // Skip '{'
    
    while (pos < json.length()) {
        // Skip whitespace
        while (pos < json.length() && isspace(json[pos])) pos++;
        
        if (pos >= json.length()) break;
        if (json[pos] == '}') {
            pos++; // Skip '}'
            break;
        }
        
        // Parse key
        std::string key = extractQuotedString(json, pos);
        
        // Skip whitespace and ':'
        while (pos < json.length() && (isspace(json[pos]) || json[pos] == ':')) pos++;
        
        // Parse value
        SimpleJsonValue value = parseJsonValue(json, pos);
        obj.objectValue[key] = value;
        
        // Skip whitespace and optional ','
        while (pos < json.length() && (isspace(json[pos]) || json[pos] == ',')) pos++;
    }
    
    return obj;
}

SimpleJsonValue parseJsonArray(const std::string& json, size_t& pos) {
    SimpleJsonValue arr;
    arr.type = SimpleJsonValue::ARRAY;
    
    if (pos >= json.length() || json[pos] != '[') return arr;
    pos++; // Skip '['
    
    while (pos < json.length()) {
        // Skip whitespace
        while (pos < json.length() && isspace(json[pos])) pos++;
        
        if (pos >= json.length()) break;
        if (json[pos] == ']') {
            pos++; // Skip ']'
            break;
        }
        
        // Parse value
        SimpleJsonValue value = parseJsonValue(json, pos);
        arr.arrayValue.push_back(value);
        
        // Skip whitespace and optional ','
        while (pos < json.length() && (isspace(json[pos]) || json[pos] == ',')) pos++;
    }
    
    return arr;
}

SimpleJsonValue parseJsonValue(const std::string& json, size_t& pos) {
    SimpleJsonValue value;
    
    // Skip whitespace
    while (pos < json.length() && isspace(json[pos])) pos++;
    
    if (pos >= json.length()) return value;
    
    if (json[pos] == '"') {
        // String value
        value.type = SimpleJsonValue::STRING;
        value.stringValue = extractQuotedString(json, pos);
    } else if (json[pos] == '{') {
        // Object value
        value = parseJsonObject(json, pos);
    } else if (json[pos] == '[') {
        // Array value
        value = parseJsonArray(json, pos);
    } else if (json.substr(pos, 4) == "true") {
        // Boolean true
        value.type = SimpleJsonValue::BOOL;
        value.boolValue = true;
        pos += 4;
    } else if (json.substr(pos, 5) == "false") {
        // Boolean false
        value.type = SimpleJsonValue::BOOL;
        value.boolValue = false;
        pos += 5;
    } else {
        // Skip unknown values
        while (pos < json.length() && json[pos] != ',' && json[pos] != '}' && json[pos] != ']') pos++;
    }
    
    return value;
}

SimpleJsonValue parseJson(const std::string& json) {
    size_t pos = 0;
    return parseJsonValue(json, pos);
}

// Helper to parse virtual key code from key string for menu accelerators
static UINT getMenuVirtualKeyCode(const std::string& key) {
    std::string lowerKey = key;
    std::transform(lowerKey.begin(), lowerKey.end(), lowerKey.begin(), ::tolower);

    // Letters
    if (lowerKey.length() == 1 && lowerKey[0] >= 'a' && lowerKey[0] <= 'z') {
        return 'A' + (lowerKey[0] - 'a');
    }
    // Numbers
    if (lowerKey.length() == 1 && lowerKey[0] >= '0' && lowerKey[0] <= '9') {
        return '0' + (lowerKey[0] - '0');
    }
    // Function keys
    if (lowerKey[0] == 'f' && lowerKey.length() >= 2) {
        try {
            int fNum = std::stoi(lowerKey.substr(1));
            if (fNum >= 1 && fNum <= 24) return VK_F1 + (fNum - 1);
        } catch (...) {}
    }
    // Special keys
    if (lowerKey == "space" || lowerKey == " ") return VK_SPACE;
    if (lowerKey == "return" || lowerKey == "enter") return VK_RETURN;
    if (lowerKey == "tab") return VK_TAB;
    if (lowerKey == "escape" || lowerKey == "esc") return VK_ESCAPE;
    if (lowerKey == "backspace") return VK_BACK;
    if (lowerKey == "delete" || lowerKey == "del") return VK_DELETE;
    if (lowerKey == "insert") return VK_INSERT;
    if (lowerKey == "up") return VK_UP;
    if (lowerKey == "down") return VK_DOWN;
    if (lowerKey == "left") return VK_LEFT;
    if (lowerKey == "right") return VK_RIGHT;
    if (lowerKey == "home") return VK_HOME;
    if (lowerKey == "end") return VK_END;
    if (lowerKey == "pageup") return VK_PRIOR;
    if (lowerKey == "pagedown") return VK_NEXT;
    // Symbols
    if (lowerKey == "plus") return VK_OEM_PLUS;
    if (lowerKey == "minus") return VK_OEM_MINUS;
    if (lowerKey == "-") return VK_OEM_MINUS;
    if (lowerKey == "=" || lowerKey == "+") return VK_OEM_PLUS;
    if (lowerKey == "[") return VK_OEM_4;
    if (lowerKey == "]") return VK_OEM_6;
    if (lowerKey == "\\") return VK_OEM_5;
    if (lowerKey == ";") return VK_OEM_1;
    if (lowerKey == "'") return VK_OEM_7;
    if (lowerKey == ",") return VK_OEM_COMMA;
    if (lowerKey == ".") return VK_OEM_PERIOD;
    if (lowerKey == "/") return VK_OEM_2;
    if (lowerKey == "`") return VK_OEM_3;

    return 0;
}

// Parse modifiers from accelerator string for menu accelerators using the
// shared cross-platform parser. Returns FCONTROL, FALT, FSHIFT flags.
static BYTE parseMenuModifiers(const std::string& accelerator, std::string& outKey) {
    auto parts = electrobun::parseAccelerator(accelerator);
    outKey = parts.key;

    BYTE modifiers = FVIRTKEY;
    if (parts.commandOrControl || parts.command || parts.control) modifiers |= FCONTROL;
    if (parts.alt)                                                modifiers |= FALT;
    if (parts.shift)                                              modifiers |= FSHIFT;
    return modifiers;
}

// Build display string for accelerator (e.g., "Ctrl+S", "Ctrl+Shift+N")
static std::string buildAcceleratorDisplayString(const std::string& accelerator) {
    std::string keyPart;
    BYTE modifiers = parseMenuModifiers(accelerator, keyPart);

    std::string display;
    if (modifiers & FCONTROL) {
        display += "Ctrl+";
    }
    if (modifiers & FALT) {
        display += "Alt+";
    }
    if (modifiers & FSHIFT) {
        display += "Shift+";
    }

    // Capitalize the key for display
    std::string upperKey = keyPart;
    if (!upperKey.empty()) {
        upperKey[0] = toupper(upperKey[0]);
    }

    // Handle special key display names
    std::string lowerKey = keyPart;
    std::transform(lowerKey.begin(), lowerKey.end(), lowerKey.begin(), ::tolower);
    if (lowerKey == "return" || lowerKey == "enter") {
        upperKey = "Enter";
    } else if (lowerKey == "escape" || lowerKey == "esc") {
        upperKey = "Esc";
    } else if (lowerKey == "delete" || lowerKey == "del") {
        upperKey = "Del";
    } else if (lowerKey == "backspace") {
        upperKey = "Backspace";
    } else if (lowerKey == "space") {
        upperKey = "Space";
    } else if (lowerKey == "pageup") {
        upperKey = "PgUp";
    } else if (lowerKey == "pagedown") {
        upperKey = "PgDn";
    } else if (lowerKey == "plus") {
        upperKey = "+";
    } else if (lowerKey == "minus") {
        upperKey = "-";
    }

    display += upperKey;
    return display;
}

// Function to create Windows menu from JSON config (equivalent to createMenuFromConfig)
HMENU createMenuFromConfig(const SimpleJsonValue& menuConfig, NSStatusItem* statusItem) {
    HMENU menu = CreatePopupMenu();
    if (!menu) {
        ::log("ERROR: Failed to create popup menu");
        return NULL;
    }
    
    if (menuConfig.type != SimpleJsonValue::ARRAY) {
        ::log("ERROR: Menu config is not an array");
        return menu;
    }
    
    for (const auto& itemValue : menuConfig.arrayValue) {
        if (itemValue.type != SimpleJsonValue::OBJECT) continue;
        
        const auto& itemData = itemValue.objectValue;
        
        // Helper lambda to get string value
        auto getString = [&](const std::string& key, const std::string& defaultVal = "") -> std::string {
            auto it = itemData.find(key);
            if (it != itemData.end() && it->second.type == SimpleJsonValue::STRING) {
                return it->second.stringValue;
            }
            return defaultVal;
        };
        
        // Helper lambda to get bool value
        auto getBool = [&](const std::string& key, bool defaultVal = false) -> bool {
            auto it = itemData.find(key);
            if (it != itemData.end() && it->second.type == SimpleJsonValue::BOOL) {
                return it->second.boolValue;
            }
            return defaultVal;
        };
        
        std::string type = getString("type");
        std::string label = getString("label");
        std::string action = getString("action");
        std::string role = getString("role");
        std::string accelerator = getString("accelerator");

        bool enabled = getBool("enabled", true);
        bool checked = getBool("checked", false);
        bool hidden = getBool("hidden", false);
        std::string tooltip = getString("tooltip");

        if (hidden) {
            continue;
        } else if (type == "divider") {
            AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
        } else {
            UINT flags = MF_STRING;
            if (!enabled) flags |= MF_GRAYED;

            UINT menuId = g_nextMenuId++;

            // Store the action for this menu ID
            if (!action.empty()) {
                g_menuItemActions[menuId] = action;
            }

            // Handle system roles (similar to macOS implementation)
            if (!role.empty()) {
                if (role == "quit") {
                    // For quit, we'll handle it specially in the menu callback
                    g_menuItemActions[menuId] = "__quit__";
                }

                // Set default accelerators for common roles if not specified
                if (accelerator.empty()) {
                    if (role == "undo") {
                        accelerator = "z";
                    } else if (role == "redo") {
                        accelerator = "y";
                    } else if (role == "cut") {
                        accelerator = "x";
                    } else if (role == "copy") {
                        accelerator = "c";
                    } else if (role == "paste") {
                        accelerator = "v";
                    } else if (role == "selectAll") {
                        accelerator = "a";
                    }
                }
            }

            // Build the label with accelerator display for context menus
            // On Windows, context menus use mnemonic keys (just the letter, not Ctrl+Letter)
            std::string displayLabel = label;
            if (!accelerator.empty()) {
                // For context menus, display just the letter (mnemonic key)
                // The user presses just the letter while the menu is open
                if (accelerator.length() == 1 && isalpha(accelerator[0])) {
                    displayLabel += "\t" + std::string(1, (char)toupper(accelerator[0]));
                } else {
                    // For complex accelerators, extract just the key part
                    std::string accelDisplay = buildAcceleratorDisplayString(accelerator);
                    // Remove "Ctrl+" prefix for context menus since they use mnemonics
                    size_t ctrlPos = accelDisplay.find("Ctrl+");
                    if (ctrlPos != std::string::npos) {
                        accelDisplay = accelDisplay.substr(ctrlPos + 5); // Skip "Ctrl+"
                    }
                    if (!accelDisplay.empty()) {
                        displayLabel += "\t" + accelDisplay;
                    }
                }
            }

            // Append the menu item
            electrobun::appendMenuUtf8(menu, flags, menuId, displayLabel);

            if (checked) {
                CheckMenuItem(menu, menuId, MF_BYCOMMAND | MF_CHECKED);
            }

            // Handle submenus
            auto submenuIt = itemData.find("submenu");
            if (submenuIt != itemData.end() && submenuIt->second.type == SimpleJsonValue::ARRAY) {
                HMENU submenu = createMenuFromConfig(submenuIt->second, statusItem);
                if (submenu) {
                    electrobun::modifyMenuUtf8(
                        menu,
                        menuId,
                        MF_BYCOMMAND | MF_POPUP,
                        (UINT_PTR)submenu,
                        displayLabel);
                }
            }
        }
    }
    
    return menu;
}

// Function to handle menu item selection
void handleMenuItemSelection(UINT menuId, NSStatusItem* statusItem) {
    auto it = g_menuItemActions.find(menuId);
    if (it != g_menuItemActions.end()) {
        const std::string& action = it->second;

        if (statusItem && statusItem->handler) {
            if (action == "__quit__") {
                if (g_quitRequestedHandler && !g_eventLoopStopping.load()) {
                    g_quitRequestedHandler();
                } else {
                    PostQuitMessage(0);
                }
            } else {
                statusItem->handler(statusItem->trayId, action.c_str());
            }
        }
    }
}

// Rebuild the accelerator table from collected accelerators
static void rebuildAcceleratorTable() {
    if (g_hAccelTable) {
        DestroyAcceleratorTable(g_hAccelTable);
        g_hAccelTable = NULL;
    }

    if (!g_menuAccelerators.empty()) {
        g_hAccelTable = CreateAcceleratorTableW(g_menuAccelerators.data(), (int)g_menuAccelerators.size());
        if (g_hAccelTable) {
            // ::log("Created accelerator table with " + std::to_string(g_menuAccelerators.size()) + " entries");
        }
    }
}

// Clear all menu accelerators (call before rebuilding menu)
static void clearMenuAccelerators() {
    g_menuAccelerators.clear();
    if (g_hAccelTable) {
        DestroyAcceleratorTable(g_hAccelTable);
        g_hAccelTable = NULL;
    }
}

// Function to set accelerator keys for menu items
// Returns the display string to append to the menu label
std::string setMenuItemAccelerator(HMENU menu, UINT menuId, const std::string& accelerator, UINT modifierMask = 0) {
    if (accelerator.empty()) return "";

    std::string keyPart;
    BYTE modifiers;
    UINT vkCode;

    // Check if this is a simple single-letter accelerator (for role defaults)
    if (accelerator.length() == 1 && isalpha(accelerator[0])) {
        // Single letter with Ctrl modifier (from role defaults)
        vkCode = toupper(accelerator[0]);
        modifiers = FVIRTKEY | FCONTROL;
        keyPart = accelerator;
    } else {
        // Parse the full accelerator string
        modifiers = parseMenuModifiers(accelerator, keyPart);
        vkCode = getMenuVirtualKeyCode(keyPart);
    }

    // Apply modifierMask override if specified
    if (modifierMask > 0) {
        modifiers = FVIRTKEY;
        if (modifierMask & 1) modifiers |= FCONTROL;
        if (modifierMask & 2) modifiers |= FSHIFT;
        if (modifierMask & 4) modifiers |= FALT;
    }

    if (vkCode == 0) {
        // ::log("Failed to parse accelerator key: " + accelerator);
        return "";
    }

    // Add to accelerator table
    ACCEL accel;
    accel.fVirt = modifiers;
    accel.key = (WORD)vkCode;
    accel.cmd = (WORD)menuId;
    g_menuAccelerators.push_back(accel);

    // Build and return the display string
    if (accelerator.length() == 1 && isalpha(accelerator[0])) {
        return "Ctrl+" + std::string(1, (char)toupper(accelerator[0]));
    }
    return buildAcceleratorDisplayString(accelerator);
}

// Enhanced createMenuFromConfig for application menu
HMENU createApplicationMenuFromConfig(const SimpleJsonValue& menuConfig, StatusItemTarget* target) {
    HMENU menuBar = CreateMenu();
    if (!menuBar) {
        ::log("ERROR: Failed to create menu bar");
        return NULL;
    }
    
    if (menuConfig.type != SimpleJsonValue::ARRAY) {
        ::log("ERROR: Application menu config is not an array");
        DestroyMenu(menuBar);
        return NULL;
    }
    
    for (const auto& topLevelItem : menuConfig.arrayValue) {
        if (topLevelItem.type != SimpleJsonValue::OBJECT) continue;
        
        const auto& itemData = topLevelItem.objectValue;
        
        // Helper lambda to get string value
        auto getString = [&](const std::string& key, const std::string& defaultVal = "") -> std::string {
            auto it = itemData.find(key);
            if (it != itemData.end() && it->second.type == SimpleJsonValue::STRING) {
                return it->second.stringValue;
            }
            return defaultVal;
        };
        
        // Helper lambda to get bool value
        auto getBool = [&](const std::string& key, bool defaultVal = false) -> bool {
            auto it = itemData.find(key);
            if (it != itemData.end() && it->second.type == SimpleJsonValue::BOOL) {
                return it->second.boolValue;
            }
            return defaultVal;
        };
        
        std::string label = getString("label");
        bool hidden = getBool("hidden", false);
        
        if (hidden) continue;
        
        // Check if this has a submenu
        auto submenuIt = itemData.find("submenu");
        if (submenuIt != itemData.end() && submenuIt->second.type == SimpleJsonValue::ARRAY) {
            HMENU popupMenu = CreatePopupMenu();
            if (!popupMenu) continue;
            
            // Process submenu items
            for (const auto& subItemValue : submenuIt->second.arrayValue) {
                if (subItemValue.type != SimpleJsonValue::OBJECT) continue;
                
                const auto& subItemData = subItemValue.objectValue;
                
                // Helper lambdas for subitem data
                auto getSubString = [&](const std::string& key, const std::string& defaultVal = "") -> std::string {
                    auto it = subItemData.find(key);
                    if (it != subItemData.end() && it->second.type == SimpleJsonValue::STRING) {
                        return it->second.stringValue;
                    }
                    return defaultVal;
                };
                
                auto getSubBool = [&](const std::string& key, bool defaultVal = false) -> bool {
                    auto it = subItemData.find(key);
                    if (it != subItemData.end() && it->second.type == SimpleJsonValue::BOOL) {
                        return it->second.boolValue;
                    }
                    return defaultVal;
                };
                
                std::string subType = getSubString("type");
                std::string subLabel = getSubString("label");
                std::string subAction = getSubString("action");
                std::string subRole = getSubString("role");
                std::string subAccelerator = getSubString("accelerator");
                
                bool subEnabled = getSubBool("enabled", true);
                bool subChecked = getSubBool("checked", false);
                bool subHidden = getSubBool("hidden", false);
                
                if (subHidden) {
                    continue;
                } else if (subType == "divider") {
                    AppendMenuW(popupMenu, MF_SEPARATOR, 0, NULL);
                } else {
                    UINT flags = MF_STRING;
                    if (!subEnabled) flags |= MF_GRAYED;
                    
                    UINT menuId = g_nextMenuId++;
                    
                    // Store the action for this menu ID
                    if (!subAction.empty()) {
                        g_menuItemActions[menuId] = subAction;
                    }
                    
                    // Handle system roles
                    if (!subRole.empty()) {
                        if (subRole == "quit") {
                            g_menuItemActions[menuId] = "__quit__";
                        } else if (subRole == "undo") {
                            g_menuItemActions[menuId] = "__undo__";
                        } else if (subRole == "redo") {
                            g_menuItemActions[menuId] = "__redo__";
                        } else if (subRole == "cut") {
                            g_menuItemActions[menuId] = "__cut__";
                        } else if (subRole == "copy") {
                            g_menuItemActions[menuId] = "__copy__";
                        } else if (subRole == "paste") {
                            g_menuItemActions[menuId] = "__paste__";
                        } else if (subRole == "pasteAndMatchStyle") {
                            g_menuItemActions[menuId] = "__pasteAndMatchStyle__";
                        } else if (subRole == "delete") {
                            g_menuItemActions[menuId] = "__delete__";
                        } else if (subRole == "selectAll") {
                            g_menuItemActions[menuId] = "__selectAll__";
                        } else if (subRole == "minimize") {
                            g_menuItemActions[menuId] = "__minimize__";
                        } else if (subRole == "toggleFullScreen" || subRole == "togglefullscreen") {
                            g_menuItemActions[menuId] = "__toggleFullScreen__";
                        } else if (subRole == "zoom") {
                            g_menuItemActions[menuId] = "__zoom__";
                        } else if (subRole == "close") {
                            g_menuItemActions[menuId] = "__close__";
                        }
                        // Note: The following roles are macOS-only and not implemented on Windows:
                        // hide, hideOthers, showAll, startSpeaking, stopSpeaking, bringAllToFront

                        // Set default accelerators for common roles if not specified
                        if (subAccelerator.empty()) {
                            if (subRole == "undo") {
                                subAccelerator = "z";
                            } else if (subRole == "redo") {
                                subAccelerator = "y";
                            } else if (subRole == "cut") {
                                subAccelerator = "x";
                            } else if (subRole == "copy") {
                                subAccelerator = "c";
                            } else if (subRole == "paste" || subRole == "pasteAndMatchStyle") {
                                subAccelerator = "v";
                            } else if (subRole == "delete") {
                                subAccelerator = "Delete";
                            } else if (subRole == "selectAll") {
                                subAccelerator = "a";
                            } else if (subRole == "toggleFullScreen" || subRole == "togglefullscreen") {
                                subAccelerator = "F11";
                            }
                        }
                    }
                    
                    // Build the label with accelerator display
                    std::string displayLabel = subLabel;
                    if (!subAccelerator.empty()) {
                        std::string accelDisplay = setMenuItemAccelerator(popupMenu, menuId, subAccelerator, 0);
                        if (!accelDisplay.empty()) {
                            displayLabel += "\t" + accelDisplay;
                        }
                    }

                    // Append the menu item
                    electrobun::appendMenuUtf8(popupMenu, flags, menuId, displayLabel);

                    if (subChecked) {
                        CheckMenuItem(popupMenu, menuId, MF_BYCOMMAND | MF_CHECKED);
                    }
                    
                    // Handle nested submenus
                    auto nestedSubmenuIt = subItemData.find("submenu");
                    if (nestedSubmenuIt != subItemData.end() && nestedSubmenuIt->second.type == SimpleJsonValue::ARRAY) {
                        HMENU nestedSubmenu = createMenuFromConfig(nestedSubmenuIt->second, reinterpret_cast<NSStatusItem*>(target));
                        if (nestedSubmenu) {
                            electrobun::modifyMenuUtf8(
                                popupMenu,
                                menuId,
                                MF_BYCOMMAND | MF_POPUP,
                                (UINT_PTR)nestedSubmenu,
                                subLabel);
                        }
                    }
                }
            }
            
            // Add the popup menu to the menu bar
            electrobun::appendMenuUtf8(
                menuBar, MF_POPUP, (UINT_PTR)popupMenu, label);
        } else {
            // Top-level item without submenu
            UINT menuId = g_nextMenuId++;
            std::string action = getString("action");
            
            if (!action.empty()) {
                g_menuItemActions[menuId] = action;
            }
            
            UINT flags = MF_STRING;
            if (!getBool("enabled", true)) flags |= MF_GRAYED;
            
            electrobun::appendMenuUtf8(menuBar, flags, menuId, label);
        }
    }
    
    return menuBar;
}


















ELECTROBUN_EXPORT bool initCEF() {
    if (g_cef_initialized.load()) {
        return true; // Already initialized
    }
    
    // Create a job object to track all child processes
    if (!g_job_object) {
        g_job_object = CreateJobObject(nullptr, nullptr);
        if (g_job_object) {
            // Configure the job object to terminate all child processes when the main process exits
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = {0};
            jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(g_job_object, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
            
            // Assign the current process to the job object
            // This ensures all child processes (CEF helpers) are part of this job
            AssignProcessToJobObject(g_job_object, GetCurrentProcess());
            std::cout << "[CEF] Created job object for process tracking" << std::endl;
        }
    }

    // Keep startup filesystem paths in UTF-16. Windows' ANSI APIs cannot
    // represent every valid profile or installation directory.
    const std::wstring executablePath = electrobun::getModuleFileNameWide();
    const size_t lastSlash = executablePath.find_last_of(L"\\/");
    if (executablePath.empty() || lastSlash == std::wstring::npos) {
        ::log("Failed to resolve the executable path for CEF");
        return false;
    }
    const std::wstring executableDir = executablePath.substr(0, lastSlash);

    std::wstring helperBaseName = L"bun";
    {
        std::wstring exeName = executablePath.substr(lastSlash + 1);
        const size_t dot = exeName.find_last_of(L'.');
        if (dot != std::wstring::npos) {
            exeName = exeName.substr(0, dot);
        }
        if (!exeName.empty()) {
            helperBaseName = exeName;
        }
    }

    // Set up CEF paths (resources are in ./cef relative to executable)
    const std::wstring cefResourceDir = executableDir + L"\\cef";

    std::wstring identifier;
    std::wstring channel;
    if (!electrobun::utf8ToWide(g_electrobunIdentifier, identifier) ||
        !electrobun::utf8ToWide(g_electrobunChannel, channel)) {
        ::log("Failed to decode the Electrobun identifier or channel as UTF-8");
        return false;
    }

    // Build cache path with identifier/channel structure (consistent with CLI and updater)
    // Use %LOCALAPPDATA%\{identifier}\{channel}\CEF
    std::wstring userDataDir;
    const std::wstring localAppData =
        electrobun::getEnvironmentVariableWide(L"LOCALAPPDATA");
    if (!localAppData.empty()) {
        userDataDir = buildAppDataPath(
            localAppData, identifier, channel, L"CEF", L'\\');
        std::cout << "[CEF] Using path: " << WStringToString(userDataDir)
                  << std::endl;
    } else {
        // Fallback to executable directory if LOCALAPPDATA not available
        userDataDir = buildAppDataPath(
            executableDir, identifier, channel, L"cef_cache", L'\\');
    }

    // Create every missing parent without narrowing the path.
    SHCreateDirectoryExW(nullptr, userDataDir.c_str(), nullptr);

    // One-shot wipe if Electrobun's cache format version has been bumped
    // since the user's last launch. See cache_migration.h.
    if (!electrobun::migrateCacheFolderIfNeeded(
            std::filesystem::path(userDataDir),
            electrobun::WINDOWS_CEF_CACHE_FORMAT_VERSION)) {
        ::log("Failed to prepare the Windows CEF cache format safely");
        return false;
    }

    // Initialize CEF
    CefMainArgs main_args(GetModuleHandle(NULL));
    
    // Create the app
    g_cef_app = new ElectrobunCefApp();

    // Read user-defined chromium flags from build.json
    const std::filesystem::path buildJsonPath =
        std::filesystem::path(executableDir) / L".." / L"Resources" /
        L"build.json";
    std::string buildJsonContent = electrobun::readFileToString(buildJsonPath);
    if (!buildJsonContent.empty()) {
        g_userChromiumFlags = electrobun::parseChromiumFlags(buildJsonContent);
    }

    // CEF settings
    CefSettings settings;
    settings.no_sandbox = true;
    settings.multi_threaded_message_loop = false;
    settings.external_message_pump = true; // We pump CEF via OnScheduleMessagePumpWork
    settings.windowless_rendering_enabled = true; // Required for OSR/transparent windows

    const auto remoteDebugging = electrobun::resolveRemoteDebugging(
        buildJsonContent,
        g_userChromiumFlags,
        getenv(electrobun::kRemoteDebuggingPortEnvironment));
    const int selectedPort = electrobun::selectRemoteDebuggingPort(
        remoteDebugging,
        IsPortAvailable);
    g_remoteDebugPort = selectedPort;
    if (selectedPort != 0) {
        settings.remote_debugging_port = selectedPort;
        std::cout << "[CEF] Remote debugging enabled on 127.0.0.1:"
                  << selectedPort << " ("
                  << electrobun::remoteDebuggingSourceName(remoteDebugging.source)
                  << ")" << std::endl;
    } else if (remoteDebugging.enabled()) {
        std::cout << "[CEF] Remote debugging disabled: no free port in "
                  << electrobun::kDefaultRemoteDebuggingPort << "-"
                  << electrobun::kLastAutomaticRemoteDebuggingPort << std::endl;
    } else if (remoteDebugging.source == electrobun::RemoteDebuggingSource::invalid_configuration ||
               remoteDebugging.source == electrobun::RemoteDebuggingSource::invalid_environment) {
        std::cout << "[CEF] Remote debugging disabled: "
                  << electrobun::remoteDebuggingSourceName(remoteDebugging.source)
                  << std::endl;
    }

    // Set the subprocess path to the helper executable
    CefString(&settings.browser_subprocess_path) =
        executableDir + L"\\" + helperBaseName + L" Helper.exe";
    
    // Set paths - icudtl.dat and .pak files are in cef directory root
    CefString(&settings.resources_dir_path) = cefResourceDir;
    CefString(&settings.locales_dir_path) = cefResourceDir + L"\\Resources\\locales";
    CefString(&settings.root_cache_path) = userDataDir;
    CefString(&settings.cache_path) = userDataDir;
    
    // Add language settings like macOS
    CefString(&settings.accept_language_list) = "en-US,en";
    
    // Set minimal logging
    settings.log_severity = LOGSEVERITY_ERROR;
    CefString(&settings.log_file) = "";
    
    
    bool success = CefInitialize(main_args, settings, g_cef_app.get(), nullptr);
    if (success) {
        g_cef_initialized.store(true);
        // Register the views:// scheme handler factory
        CefRegisterSchemeHandlerFactory("views", "", new ElectrobunSchemeHandlerFactory());
        
        // We'll start the message pump timer when we create the first browser
    } else {
        ::log("Failed to initialize CEF");
    }
    
    return success;
}

static RECT initialWebView2Bounds(
    HWND containerHwnd,
    bool fullSize,
    double x,
    double y,
    double width,
    double height) {
    RECT bounds = electrobun::logicalToPhysicalRect(
        x,
        y,
        width,
        height,
        electrobun::windowsDpiForWindow(containerHwnd));

    // The window's first WM_SIZE can run before the asynchronous WebView2
    // controller exists. Read the container's current client area here so a
    // full-size view starts with the same bounds used by later WM_SIZE events.
    if (fullSize) {
        RECT clientBounds = {};
        if (GetClientRect(containerHwnd, &clientBounds)) {
            bounds = clientBounds;
        }
    }

    return bounds;
}

// Internal factory method for creating WebView2 instances
static std::shared_ptr<WebView2View> createWebView2View(uint32_t webviewId,
                                                 HWND hwnd,
                                                 const char *url,
                                                 double x, double y,
                                                 double width, double height,
                                                 bool autoResize,
                                                 const char *partitionIdentifier,
                                                 DecideNavigationCallback navigationCallback,
                                                 WebviewEventHandler webviewEventHandler,
                                                 HandlePostMessage eventBridgeHandler,
                                                 HandlePostMessage bunBridgeHandler,
                                                 HandlePostMessage internalBridgeHandler,
                                                 const char *electrobunPreloadScript,
                                                 const char *customPreloadScript,
                                                 bool startTransparent,
                                                 bool startPassthrough,
                                                 bool transparent,
                                                 bool sandbox) {
    // Check if WebView2 runtime is available
    LPWSTR versionInfo = nullptr;
    HRESULT result = GetAvailableCoreWebView2BrowserVersionString(nullptr, &versionInfo);
    if (FAILED(result)) {
        ::log("ERROR: WebView2 runtime is not available. Please install Microsoft Edge WebView2 Runtime");
        auto view = std::make_shared<WebView2View>(webviewId, eventBridgeHandler, bunBridgeHandler, internalBridgeHandler, sandbox);
        view->pendingStartTransparent = startTransparent;
        view->pendingStartPassthrough = startPassthrough;
        view->setCreationFailed(true);
        return view;
    }
    if (versionInfo) {
        CoTaskMemFree(versionInfo);
    }
    
    
    // Make safe copies of string parameters to avoid memory corruption in lambda captures
    std::string urlString = url ? std::string(url) : "";
    std::string electrobunScript = electrobunPreloadScript ? std::string(electrobunPreloadScript) : "";
    std::string customScript = customPreloadScript ? std::string(customPreloadScript) : "";
    std::string partitionStr = partitionIdentifier ? std::string(partitionIdentifier) : "";

    auto view = std::make_shared<WebView2View>(webviewId, eventBridgeHandler, bunBridgeHandler, internalBridgeHandler, sandbox);
    view->hwnd = hwnd;
    view->parentWindow = hwnd;
    view->fullSize = autoResize;
    view->pendingStartTransparent = startTransparent;
    view->pendingStartPassthrough = startPassthrough;
    view->setLogicalFrame(x, y, width, height);
    view->webviewEventHandler = webviewEventHandler;

    // Store URL and scripts in view to survive async callbacks
    view->pendingUrl = urlString;
    view->electrobunScript = electrobunScript;
    view->customScript = customScript;

    // Create WebView2 on main thread
    MainThreadDispatcher::dispatch_sync([view, urlString, x, y, width, height, hwnd, partitionStr, transparent]() {
        // Initialize COM for this thread
        HRESULT comResult = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
        if (FAILED(comResult) && comResult != RPC_E_CHANGED_MODE) {
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Failed to initialize COM, HRESULT: 0x%08X", comResult);
            ::log(errorMsg);
            view->setCreationFailed(true);
            return;
        }
        
        // Get or create container
        auto container = GetOrCreateContainer(hwnd);
        if (!container) {
            ::log("ERROR: Failed to create container");
            view->setCreationFailed(true);
            return;
        }
        
        HWND containerHwnd = container->GetHwnd();
        // char debugMsg[256];
        // sprintf_s(debugMsg, "[WebView2] Creating controller for container HWND: %p, parent HWND: %p", containerHwnd, hwnd);
        // ::log(debugMsg);
        
        // Verify the container window is valid
        if (!IsWindow(containerHwnd)) {
            ::log("ERROR: Container window handle is invalid");
            view->setCreationFailed(true);
            return;
        }
        
        // Get window info for debugging
        RECT windowRect;
        GetWindowRect(containerHwnd, &windowRect);
        DWORD windowStyle = GetWindowLong(containerHwnd, GWL_STYLE);
        // char windowDebug[512];
        // sprintf_s(windowDebug, "[WebView2] Container window - Rect: (%d,%d,%d,%d), Style: 0x%08X", 
        //          windowRect.left, windowRect.top, windowRect.right, windowRect.bottom, windowStyle);
        // ::log(windowDebug);
        
        // Make sure the window is visible (WebView2 requirement)
        ShowWindow(containerHwnd, SW_SHOW);
        UpdateWindow(containerHwnd);
        
        // Create WebView2 environment
        // Store values to avoid complex object captures in lambda
        uint32_t webviewId = view->webviewId;
        HWND parentHwnd = hwnd;
        
        auto environmentCompletedHandler = Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [view, container, x, y, width, height, transparent](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                if (FAILED(result)) {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "ERROR: Failed to create WebView2 environment, HRESULT: 0x%08X", result);
                    ::log(errorMsg);
                    view->setCreationFailed(true);
                    return result;
                }
                
                // Create WebView2 controller
                // When DComp is active, use CreateCoreWebView2CompositionController
                // so WebView2 renders into a DComp visual (enabling GPU layering).
                // Otherwise, use standard CreateCoreWebView2Controller.
                HWND targetHwnd = container->GetHwnd();

                if (!IsWindow(targetHwnd)) {
                    ::log("ERROR: Target window is no longer valid");
                    view->setCreationFailed(true);
                    return S_OK;
                }

                return env->CreateCoreWebView2Controller(targetHwnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [view, container, x, y, width, height, env, transparent](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                            if (FAILED(result)) {
                                char errorMsg[256];
                                sprintf_s(errorMsg, "ERROR: Failed to create WebView2 controller, HRESULT: 0x%08X", result);
                                ::log(errorMsg);
                                view->setCreationFailed(true);
                                return result;
                            }
                            
                            
                            // Controller setup with composition fallback
                            ComPtr<ICoreWebView2Controller> ctrl(controller);
                            ComPtr<ICoreWebView2> webview;
                            ctrl->get_CoreWebView2(&webview);
                            
                            view->setController(ctrl);
                            view->setWebView(webview);

                            // Keep WebView2's rasterization scale and popup/OOPIF
                            // screen origin synchronized when the host crosses
                            // monitors with different DPI/origin values.
                            ComPtr<ICoreWebView2Controller3> ctrl3;
                            if (SUCCEEDED(ctrl.As(&ctrl3)) && ctrl3) {
                                ctrl3->put_ShouldDetectMonitorScaleChanges(TRUE);
                                ctrl3->put_BoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS);
                            }

                            // Let WebView2 participate in Win32 non-client hit
                            // testing for CSS app-region elements. Older runtimes
                            // simply fail QueryInterface and retain the JS fallback.
                            ComPtr<ICoreWebView2Settings> settings;
                            if (webview && SUCCEEDED(webview->get_Settings(&settings)) && settings) {
                                ComPtr<ICoreWebView2Settings9> settings9;
                                if (SUCCEEDED(settings.As(&settings9)) && settings9) {
                                    settings9->put_IsNonClientRegionSupportEnabled(TRUE);
                                }
                            }

                            // Try to get composition controller interface if available
                            ComPtr<ICoreWebView2CompositionController> compCtrl;
                            HRESULT compResult = ctrl->QueryInterface(IID_PPV_ARGS(&compCtrl));
                            if (SUCCEEDED(compResult) && compCtrl) {
                                view->setCompositionController(compCtrl);
                                // ::log("[WebView2] Composition controller interface available");
                            } else {
                            }

                            // Store container HWND for masking support
                            view->setContainerHwnd(container->GetHwnd());

                            // Set up JavaScript bridge objects
                            view->setupJavaScriptBridges();
                            
                            // Set bounds and visibility. BrowserWindow's full-size view must use
                            // the live client area rather than its requested outer-frame size.
                            RECT bounds = initialWebView2Bounds(
                                container->GetHwnd(),
                                view->fullSize,
                                x,
                                y,
                                width,
                                height);
                            HRESULT boundsResult = ctrl->put_Bounds(bounds);
                            if (FAILED(boundsResult)) {
                                char errorLog[256];
                                sprintf_s(
                                    errorLog,
                                    "[WebView2] Initial put_Bounds failed for webview %u, HRESULT: 0x%08X",
                                    view->webviewId,
                                    boundsResult);
                                ::log(errorLog);
                            }
                            view->visualBounds = bounds;

                            // Make sure the controller is visible
                            ctrl->put_IsVisible(TRUE);
                            view->applyPageZoom();

                            // Set transparent background if requested
                            if (transparent) {
                                ComPtr<ICoreWebView2Controller2> ctrl2;
                                HRESULT hr = ctrl->QueryInterface(IID_PPV_ARGS(&ctrl2));
                                if (SUCCEEDED(hr) && ctrl2) {
                                    // Set background color to transparent (0x00000000 = ARGB fully transparent)
                                    COREWEBVIEW2_COLOR transparentColor = {0, 0, 0, 0}; // A, R, G, B
                                    ctrl2->put_DefaultBackgroundColor(transparentColor);
                                }
                            }

                            // Capture webviewId and handler for event handlers
                            uint32_t capturedWebviewId = view->webviewId;
                            WebviewEventHandler capturedHandler = view->webviewEventHandler;
                            auto latestNavigationId = std::make_shared<UINT64>(0);

                            // Add views:// scheme support - TEST ADDITION
                            webview->AddWebResourceRequestedFilter(L"views://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);

                            // Set up WebResourceRequested event handler for views:// scheme
                            webview->add_WebResourceRequested(
                                Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                                    [env, capturedWebviewId, capturedHandler](ICoreWebView2* sender, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                                        // ::log("[WebView2] WebResourceRequested event triggered");
                                        ComPtr<ICoreWebView2WebResourceRequest> request;
                                        args->get_Request(&request);
                                        
                                        LPWSTR uri;
                                        request->get_Uri(&uri);
                                        
                                        std::string uriStr;
                                        if (uri && !electrobun::wideToUtf8(uri, uriStr)) {
                                            ::log("[WebView2] Request URI is not valid UTF-16");
                                            CoTaskMemFree(uri);
                                            return E_INVALIDARG;
                                        }
                                        
                                        // ::log("[WebView2] Request URI converted successfully");
                                        
                                        if (uriStr.substr(0, 8) == "views://") {
                                            std::string filePath = normalizeViewsRelativePath(uriStr);
                                            std::string content;

                                            // Check for internal/index.html (inline HTML content)
                                            if (filePath == "internal/index.html") {
                                                const char* htmlContent = getWebviewHTMLContent(capturedWebviewId);
                                                if (htmlContent && strlen(htmlContent) > 0) {
                                                    content = std::string(htmlContent);
                                                    free((void*)htmlContent);
                                                } else {
                                                    content = "<html><body><h1>No content set</h1></body></html>";
                                                }
                                            } else {
                                                content = loadViewsFile(filePath);
                                            }

                                            if (!content.empty()) {
                                                // ::log("[WebView2] Loaded views file content, creating response");

                                                // Create response (simplified)
                                                std::string mimeType = "text/html";
                                                bool isDocument = false;
                                                if (filePath.find(".js") != std::string::npos) mimeType = "application/javascript";
                                                else if (filePath.find(".css") != std::string::npos) mimeType = "text/css";
                                                else if (filePath.find(".png") != std::string::npos) mimeType = "image/png";
                                                else {
                                                    isDocument = true; // HTML document
                                                }

                                                // For HTML documents (main frame navigation), fire navigation events manually
                                                // since WebResourceRequested bypasses NavigationStarting/NavigationCompleted
                                                // These events are already fired in loadURL, so we don't need to fire them here
                                                // This block can be removed if we want to clean up
                                                if (isDocument && capturedHandler) {
                                                    // Events are now fired in loadURL() for consistency
                                                    // This avoids duplicate events and ensures proper timing
                                                }

                                                std::wstring wMimeType;
                                                if (!electrobun::utf8ToWide(mimeType, wMimeType)) {
                                                    wMimeType = L"application/octet-stream";
                                                }

                                                // Create memory stream
                                                ComPtr<IStream> contentStream;
                                                HGLOBAL hGlobal = GlobalAlloc(GMEM_MOVEABLE, content.size());
                                                if (hGlobal) {
                                                    void* pData = GlobalLock(hGlobal);
                                                    memcpy(pData, content.c_str(), content.size());
                                                    GlobalUnlock(hGlobal);
                                                    CreateStreamOnHGlobal(hGlobal, TRUE, &contentStream);
                                                }

                                                std::wstring headers = L"Content-Type: " + wMimeType + L"\r\nAccess-Control-Allow-Origin: *";

                                                ComPtr<ICoreWebView2WebResourceResponse> response;
                                                env->CreateWebResourceResponse(
                                                    contentStream.Get(),
                                                    200,
                                                    L"OK",
                                                    headers.c_str(),
                                                    &response);

                                                args->put_Response(response.Get());
                                                // ::log("[WebView2] Successfully served views:// file");
                                            }
                                        }
                                        
                                        CoTaskMemFree(uri);
                                        return S_OK;
                                    }).Get(),
                                nullptr);
                            
                            
                            // Add preload scripts
                            std::string combinedScript;
                            if (!view->electrobunScript.empty()) {
                                combinedScript += view->electrobunScript;
                            }
                            if (!view->customScript.empty()) {
                                if (!combinedScript.empty()) {
                                    combinedScript += "\n";
                                }
                                // Resolve views:// URLs to file content (matching macOS behavior)
                                if (view->customScript.substr(0, 8) == "views://") {
                                    std::string fileContent = loadViewsFile(normalizeViewsRelativePath(view->customScript));
                                    if (!fileContent.empty()) {
                                        combinedScript += fileContent;
                                    } else {
                                        std::cout << "[WebView2] Could not read custom preload script from: " << view->customScript << std::endl;
                                    }
                                } else {
                                    combinedScript += view->customScript;
                                }
                            }

                            // Add Ctrl+Click detection and navigation rules handler
                            webview->add_NavigationStarting(
                                Callback<ICoreWebView2NavigationStartingEventHandler>(
                                    [capturedWebviewId, capturedHandler, latestNavigationId](ICoreWebView2* sender, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                                        printf("[WebView2] NavigationStarting fired for webview %u\n", capturedWebviewId);
                                        UINT64 navigationId = 0;
                                        if (SUCCEEDED(args->get_NavigationId(&navigationId))) {
                                            *latestNavigationId = navigationId;
                                        }
                                        // Get URL first - needed for both ctrl+click and navigation rules
                                        wchar_t* uriWStr = nullptr;
                                        args->get_Uri(&uriWStr);
                                        std::string uri;
                                        if (uriWStr) {
                                            if (!electrobun::wideToUtf8(uriWStr, uri)) {
                                                ::log("[WebView2] Navigation URI is not valid UTF-16");
                                            }
                                            CoTaskMemFree(uriWStr);
                                        }

                                        // Check if Ctrl key is held
                                        SHORT ctrlState = GetKeyState(VK_CONTROL);
                                        bool isCtrlHeld = (ctrlState & 0x8000) != 0;

                                        // Handle Ctrl+click for new window
                                        if (isCtrlHeld && capturedHandler) {
                                            printf("[WebView2 NavigationStarting] Ctrl+click detected, url=%s\n", uri.c_str());

                                            // Debounce: ignore ctrl+click navigations within 500ms
                                            auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                                                std::chrono::system_clock::now().time_since_epoch()).count() / 1000.0;

                                            if (now - WebView2View::lastCtrlClickTime >= 0.5) {
                                                WebView2View::lastCtrlClickTime = now;

                                                // Escape URL for JSON
                                                std::string escapedUrl;
                                                for (char c : uri) {
                                                    switch (c) {
                                                        case '"': escapedUrl += "\\\""; break;
                                                        case '\\': escapedUrl += "\\\\"; break;
                                                        default: escapedUrl += c; break;
                                                    }
                                                }

                                                std::string eventData = "{\"url\":\"" + escapedUrl +
                                                                       "\",\"isCmdClick\":true,\"modifierFlags\":0}";
                                                printf("[WebView2 NavigationStarting] Firing new-window-open: %s\n", eventData.c_str());
                                                capturedHandler(capturedWebviewId, _strdup("new-window-open"), _strdup(eventData.c_str()));

                                                args->put_Cancel(TRUE);
                                                return S_OK;
                                            } else {
                                                printf("[WebView2 NavigationStarting] Debounced\n");
                                            }
                                        }

                                        // Check navigation rules synchronously from native-stored rules
                                        bool shouldAllow = true;
                                        {
                                            std::lock_guard<std::mutex> lock(g_abstractViewsMutex);
                                            auto it = g_abstractViews.find(capturedWebviewId);
                                            if (it != g_abstractViews.end() && it->second != nullptr) {
                                                shouldAllow = it->second->shouldAllowNavigationToURL(uri);
                                            }
                                        }

                                        // Fire will-navigate event with allowed status
                                        if (capturedHandler) {
                                            // Escape URL for JSON
                                            std::string escapedUrl;
                                            for (char c : uri) {
                                                switch (c) {
                                                    case '"': escapedUrl += "\\\""; break;
                                                    case '\\': escapedUrl += "\\\\"; break;
                                                    default: escapedUrl += c; break;
                                                }
                                            }
                                            std::string eventData = "{\"url\":\"" + escapedUrl + "\",\"allowed\":" +
                                                                   (shouldAllow ? "true" : "false") + "}";
                                            capturedHandler(capturedWebviewId, _strdup("will-navigate"), _strdup(eventData.c_str()));
                                        }

                                        // Cancel navigation if not allowed
                                        if (!shouldAllow) {
                                            args->put_Cancel(TRUE);
                                        }

                                        return S_OK;
                                    }).Get(),
                                nullptr);

                            // SourceChanged with IsNewDocument is WebView2's commit point:
                            // the main-frame URL has changed, but loading has not completed.
                            webview->add_SourceChanged(
                                Callback<ICoreWebView2SourceChangedEventHandler>(
                                    [capturedWebviewId, capturedHandler](ICoreWebView2* sender, ICoreWebView2SourceChangedEventArgs* args) -> HRESULT {
                                        BOOL isNewDocument = FALSE;
                                        if (FAILED(args->get_IsNewDocument(&isNewDocument)) || !isNewDocument) {
                                            return S_OK;
                                        }

                                        wchar_t* uriWStr = nullptr;
                                        sender->get_Source(&uriWStr);
                                        std::string uri;
                                        if (uriWStr) {
                                            if (!electrobun::wideToUtf8(uriWStr, uri)) {
                                                ::log("[WebView2] Source URI is not valid UTF-16");
                                            }
                                            CoTaskMemFree(uriWStr);
                                        }

                                        if (capturedHandler && !uri.empty()) {
                                            std::string escapedUrl;
                                            for (char c : uri) {
                                                switch (c) {
                                                    case '"': escapedUrl += "\\\""; break;
                                                    case '\\': escapedUrl += "\\\\"; break;
                                                    default: escapedUrl += c; break;
                                                }
                                            }
                                            std::string eventData = "{\"url\":\"" + escapedUrl + "\"}";
                                            capturedHandler(capturedWebviewId, _strdup("did-commit-navigation"), _strdup(eventData.c_str()));
                                        }

                                        return S_OK;
                                    }).Get(),
                                nullptr);

                            // Add NavigationCompleted handler for successful navigations only.
                            webview->add_NavigationCompleted(
                                Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                    [capturedWebviewId, capturedHandler, latestNavigationId](ICoreWebView2* sender, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                                        printf("[WebView2] NavigationCompleted fired for webview %u\n", capturedWebviewId);
                                        UINT64 navigationId = 0;
                                        if (FAILED(args->get_NavigationId(&navigationId)) ||
                                            navigationId != *latestNavigationId) {
                                            return S_OK;
                                        }
                                        BOOL isSuccess = FALSE;
                                        if (FAILED(args->get_IsSuccess(&isSuccess)) || !isSuccess) {
                                            return S_OK;
                                        }

                                        // Get current URL
                                        wchar_t* uriWStr = nullptr;
                                        sender->get_Source(&uriWStr);
                                        std::string uri;
                                        if (uriWStr) {
                                            if (!electrobun::wideToUtf8(uriWStr, uri)) {
                                                ::log("[WebView2] Source URI is not valid UTF-16");
                                            }
                                            CoTaskMemFree(uriWStr);
                                        }

                                        // Fire did-navigate event
                                        if (capturedHandler && !uri.empty()) {
                                            // Escape URL for JSON
                                            std::string escapedUrl;
                                            for (char c : uri) {
                                                switch (c) {
                                                    case '"': escapedUrl += "\\\""; break;
                                                    case '\\': escapedUrl += "\\\\"; break;
                                                    default: escapedUrl += c; break;
                                                }
                                            }
                                            std::string eventData = "{\"url\":\"" + escapedUrl + "\"}";
                                            capturedHandler(capturedWebviewId, _strdup("did-navigate"), _strdup(eventData.c_str()));
                                        }

                                        return S_OK;
                                    }).Get(),
                                nullptr);

                            if (!combinedScript.empty()) {
                                std::wstring wScript;
                                if (electrobun::utf8ToWide(combinedScript, wScript)) {
                                    webview->AddScriptToExecuteOnDocumentCreated(wScript.c_str(), nullptr);
                                } else {
                                    ::log("[WebView2] Refusing initial preload that is not valid UTF-8");
                                }

                                // NOTE: Do NOT re-run the preload via NavigationStarting + ExecuteScript.
                                // AddScriptToExecuteOnDocumentCreated already handles this correctly.
                                // Re-running the preload after NavigationCompleted (when queued ExecuteScript
                                // fires) would replace handlers and reset pendingRequests, breaking
                                // any in-flight internal bridge requests.

                                // Add permission request handler
                                webview->add_PermissionRequested(
                                    Callback<ICoreWebView2PermissionRequestedEventHandler>(
                                        [](ICoreWebView2* sender, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                                            COREWEBVIEW2_PERMISSION_KIND kind;
                                            args->get_PermissionKind(&kind);
                                            
                                            wchar_t* uriWStr = nullptr;
                                            args->get_Uri(&uriWStr);
                                            
                                            std::string uri;
                                            if (uriWStr) {
                                                if (!electrobun::wideToUtf8(uriWStr, uri)) {
                                                    ::log("[WebView2] Permission URI is not valid UTF-16");
                                                }
                                                CoTaskMemFree(uriWStr);
                                            }
                                            
                                            std::string origin = getOriginFromUrl(uri);
                                            PermissionType permType = PermissionType::OTHER;
                                            std::string permissionName = "Permission";
                                            
                                            // Determine permission type
                                            switch (kind) {
                                                case COREWEBVIEW2_PERMISSION_KIND_CAMERA:
                                                case COREWEBVIEW2_PERMISSION_KIND_MICROPHONE:
                                                    permType = PermissionType::USER_MEDIA;
                                                    permissionName = "Camera & Microphone Access";
                                                    break;
                                                case COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION:
                                                    permType = PermissionType::GEOLOCATION;
                                                    permissionName = "Location Access";
                                                    break;
                                                case COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS:
                                                    permType = PermissionType::NOTIFICATIONS;
                                                    permissionName = "Notification Permission";
                                                    break;
                                                default:
                                                    permType = PermissionType::OTHER;
                                                    permissionName = "Permission Request";
                                                    break;
                                            }
                                            
                                            printf("WebView2: %s requested for %s\n", permissionName.c_str(), origin.c_str());

                                            // Explicit developer policy takes precedence over cached user
                                            // decisions and dialogs. Do not cache this result: keeping it
                                            // kind-specific means granting camera never implicitly grants
                                            // microphone (both otherwise share the USER_MEDIA cache bucket).
                                            if (shouldAutoGrantWebView2Permission(kind)) {
                                                printf("WebView2: Auto-granting configured %s for %s\n", permissionName.c_str(), origin.c_str());
                                                args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                                                return S_OK;
                                            }

                                            // Check cache first
                                            PermissionStatus cachedStatus = getPermissionFromCache(origin, permType);
                                            
                                            if (cachedStatus == PermissionStatus::ALLOWED) {
                                                printf("WebView2: Using cached permission: User previously allowed %s for %s\n", permissionName.c_str(), origin.c_str());
                                                args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                                                return S_OK;
                                            } else if (cachedStatus == PermissionStatus::DENIED) {
                                                printf("WebView2: Using cached permission: User previously blocked %s for %s\n", permissionName.c_str(), origin.c_str());
                                                args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
                                                return S_OK;
                                            }
                                            
                                            // No cached permission, show dialog
                                            printf("WebView2: No cached permission found for %s, showing dialog\n", origin.c_str());
                                            
                                            std::string message = "This page wants to access ";
                                            switch (kind) {
                                                case COREWEBVIEW2_PERMISSION_KIND_CAMERA:
                                                    message += "your camera.\n\nDo you want to allow this?";
                                                    break;
                                                case COREWEBVIEW2_PERMISSION_KIND_MICROPHONE:
                                                    message += "your microphone.\n\nDo you want to allow this?";
                                                    break;
                                                case COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION:
                                                    message += "your location.\n\nDo you want to allow this?";
                                                    break;
                                                case COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS:
                                                    message += "show notifications.\n\nDo you want to allow this?";
                                                    break;
                                                default:
                                                    message += "additional permissions.\n\nDo you want to allow this?";
                                                    break;
                                            }
                                            
                                            // Show Windows message box
                                            int result = electrobun::messageBoxUtf8(
                                                nullptr,
                                                message,
                                                permissionName,
                                                MB_YESNO | MB_ICONQUESTION | MB_TOPMOST
                                            );
                                            
                                            // Handle response and cache the decision
                                            if (result == IDYES) {
                                                args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                                                cachePermission(origin, permType, PermissionStatus::ALLOWED);
                                                printf("WebView2: User allowed %s for %s (cached)\n", permissionName.c_str(), origin.c_str());
                                            } else {
                                                args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
                                                cachePermission(origin, permType, PermissionStatus::DENIED);
                                                printf("WebView2: User blocked %s for %s (cached)\n", permissionName.c_str(), origin.c_str());
                                            }
                                            
                                            return S_OK;
                                        }).Get(),
                                    nullptr);
                                
                                // Add file dialog handler for <input type="file">
                                // Note: WebView2 generally handles file dialogs automatically,
                                // but we can enhance support by enabling the necessary permissions
                                // in the AdditionalBrowserArguments (already done above with --disable-web-security)

                                // Add download handler - requires ICoreWebView2_4
                                Microsoft::WRL::ComPtr<ICoreWebView2_4> webview4;
                                if (SUCCEEDED(webview->QueryInterface(IID_PPV_ARGS(&webview4)))) {
                                    webview4->add_DownloadStarting(
                                        Callback<ICoreWebView2DownloadStartingEventHandler>(
                                            [](ICoreWebView2* sender, ICoreWebView2DownloadStartingEventArgs* args) -> HRESULT {
                                                printf("WebView2: Download starting\n");

                                                // Get the download operation
                                                Microsoft::WRL::ComPtr<ICoreWebView2DownloadOperation> downloadOp;
                                                args->get_DownloadOperation(&downloadOp);

                                                if (downloadOp) {
                                                    // Get suggested filename from URI
                                                    wchar_t* uriWStr = nullptr;
                                                    downloadOp->get_Uri(&uriWStr);

                                                    // Get the content disposition filename if available
                                                    wchar_t* contentDisp = nullptr;
                                                    downloadOp->get_ContentDisposition(&contentDisp);

                                                    // Get Downloads folder path
                                                    wchar_t* downloadsPath = nullptr;
                                                    HRESULT hr = SHGetKnownFolderPath(FOLDERID_Downloads, 0, NULL, &downloadsPath);

                                                    if (SUCCEEDED(hr) && downloadsPath) {
                                                        // Get the suggested filename from the args
                                                        wchar_t* resultFilePath = nullptr;
                                                        args->get_ResultFilePath(&resultFilePath);

                                                        std::wstring suggestedName;
                                                        if (resultFilePath) {
                                                            // Extract just the filename from the full path
                                                            std::wstring fullPath(resultFilePath);
                                                            size_t lastSlash = fullPath.find_last_of(L"\\/");
                                                            if (lastSlash != std::wstring::npos) {
                                                                suggestedName = fullPath.substr(lastSlash + 1);
                                                            } else {
                                                                suggestedName = fullPath;
                                                            }
                                                            CoTaskMemFree(resultFilePath);
                                                        } else if (uriWStr) {
                                                            // Extract filename from URI
                                                            std::wstring uri(uriWStr);
                                                            size_t lastSlash = uri.find_last_of(L'/');
                                                            size_t queryStart = uri.find(L'?');
                                                            if (lastSlash != std::wstring::npos) {
                                                                if (queryStart != std::wstring::npos && queryStart > lastSlash) {
                                                                    suggestedName = uri.substr(lastSlash + 1, queryStart - lastSlash - 1);
                                                                } else {
                                                                    suggestedName = uri.substr(lastSlash + 1);
                                                                }
                                                            } else {
                                                                suggestedName = L"download";
                                                            }
                                                        } else {
                                                            suggestedName = L"download";
                                                        }

                                                        // Build full destination path
                                                        std::wstring destPath = downloadsPath;
                                                        destPath += L"\\";
                                                        destPath += suggestedName;

                                                        // Handle duplicate filenames
                                                        std::wstring basePath = destPath;
                                                        std::wstring extension;
                                                        size_t dotPos = destPath.find_last_of(L'.');
                                                        size_t slashPos = destPath.find_last_of(L"\\/");
                                                        if (dotPos != std::wstring::npos && (slashPos == std::wstring::npos || dotPos > slashPos)) {
                                                            basePath = destPath.substr(0, dotPos);
                                                            extension = destPath.substr(dotPos);
                                                        }

                                                        int counter = 1;
                                                        while (GetFileAttributesW(destPath.c_str()) != INVALID_FILE_ATTRIBUTES) {
                                                            destPath = basePath + L" (" + std::to_wstring(counter) + L")" + extension;
                                                            counter++;
                                                        }

                                                        // Set the download destination
                                                        args->put_ResultFilePath(destPath.c_str());

                                                        // Hide the default download dialog
                                                        args->put_Handled(TRUE);

                                                        std::string utf8Path;
                                                        if (electrobun::wideToUtf8(destPath, utf8Path)) {
                                                            printf("WebView2: Downloading to %s\n", utf8Path.c_str());
                                                        }

                                                        CoTaskMemFree(downloadsPath);
                                                    } else {
                                                        printf("WebView2: Could not get Downloads folder, using default behavior\n");
                                                    }

                                                    if (uriWStr) CoTaskMemFree(uriWStr);
                                                    if (contentDisp) CoTaskMemFree(contentDisp);
                                                }

                                                return S_OK;
                                            }).Get(),
                                        nullptr);
                                    printf("WebView2: Download handler registered successfully\n");
                                } else {
                                    printf("WebView2: Warning - Could not get ICoreWebView2_4 interface for download handling\n");
                                }

                            } else {
                            }
                            
                            // Navigate to URL or load pending HTML
                            if (!view->pendingHtml.empty()) {
                                std::wstring html;
                                if (electrobun::utf8ToWide(view->pendingHtml, html)) {
                                    webview->NavigateToString(html.c_str());
                                } else {
                                    ::log("[WebView2] Refusing queued HTML that is not valid UTF-8");
                                }
                                view->pendingHtml.clear();
                            } else if (!view->pendingUrl.empty()) {
                                view->loadURL(view->pendingUrl.c_str());
                            }
                            
                            view->setCreationComplete(true);
                            container->AddAbstractView(view);

                            // Apply deferred initial transparent/passthrough state now that view is ready
                            if (view->pendingStartTransparent) {
                                view->setTransparent(true);
                                view->pendingStartTransparent = false;
                            }
                            if (view->pendingStartPassthrough) {
                                view->setPassthrough(true);
                                view->pendingStartPassthrough = false;
                            }

                            // Register in global AbstractView map for navigation rules
                            trackAbstractView(view.get());

                            // Store WebView2View in global map for JavaScript execution
                            HWND containerHwnd = container->GetHwnd();
                            g_webview2Views[containerHwnd] = view.get();


                            return S_OK;
                        }).Get());
            });
        
        
        
        // Create WebView2 environment with custom scheme support
        try {
            auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
            options->put_AdditionalBrowserArguments(L"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --allow-insecure-localhost --disable-web-security");

            // Get the interface that supports custom scheme registration
            Microsoft::WRL::ComPtr<ICoreWebView2EnvironmentOptions4> options4;
            if (SUCCEEDED(options.As(&options4))) {
                // ::log("Setting up views:// custom scheme registration");

                // Set allowed origins for the custom scheme
                const WCHAR* allowedOrigins[1] = {L"*"};

                // Create custom scheme registration for "views"
                auto viewsSchemeRegistration = Microsoft::WRL::Make<CoreWebView2CustomSchemeRegistration>(L"views");
                viewsSchemeRegistration->put_TreatAsSecure(TRUE);
                viewsSchemeRegistration->put_HasAuthorityComponent(TRUE); // This allows views://host/path format
                viewsSchemeRegistration->SetAllowedOrigins(1, allowedOrigins);

                // Set the custom scheme registrations
                ICoreWebView2CustomSchemeRegistration* registrations[1] = {
                    viewsSchemeRegistration.Get()
                };

                HRESULT schemeResult = options4->SetCustomSchemeRegistrations(1, registrations);

                if (SUCCEEDED(schemeResult)) {
                    // ::log("views:// custom scheme registration set successfully");
                } else {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "Failed to set views:// custom scheme registration: 0x%lx", schemeResult);
                    ::log(errorMsg);
                }
            } else {
                ::log("ERROR: Failed to get ICoreWebView2EnvironmentOptions4 interface for custom scheme registration");
            }

            // Create user data folder path based on partition
            // Build path with identifier/channel structure (consistent with CLI and updater)
            std::wstring userDataFolder;
            const std::wstring localAppData =
                electrobun::getEnvironmentVariableWide(L"LOCALAPPDATA");
            if (!localAppData.empty()) {
                std::wstring identifier;
                std::wstring channel;
                std::wstring partition;
                if (electrobun::utf8ToWide(g_electrobunIdentifier, identifier) &&
                    electrobun::utf8ToWide(g_electrobunChannel, channel) &&
                    electrobun::utf8ToWide(partitionStr, partition)) {
                    userDataFolder = electrobun::buildWebView2UserDataPath(
                        localAppData,
                        identifier,
                        channel,
                        partition,
                        view->webviewId);
                    SHCreateDirectoryExW(
                        nullptr, userDataFolder.c_str(), nullptr);
                } else {
                    ::log("ERROR: WebView2 profile path contains invalid UTF-8");
                }
            }

            // Use partition-specific user data folder (nullptr if empty for default behavior)
            LPCWSTR userDataFolderPtr = userDataFolder.empty() ? nullptr : userDataFolder.c_str();

            HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, userDataFolderPtr, options.Get(), environmentCompletedHandler.Get());
            
            
            if (FAILED(hr)) {
                char errorMsg[256];
                sprintf_s(errorMsg, "ERROR: CreateCoreWebView2EnvironmentWithOptions failed with HRESULT: 0x%08X", hr);
                ::log(errorMsg);
                view->setCreationFailed(true);
            } else {
                // ::log("[WebView2] CreateCoreWebView2EnvironmentWithOptions succeeded");
            }
        } catch (const std::exception& e) {
            std::cout << "[WebView2] Exception in WebView2 creation: " << e.what() << std::endl;
        } catch (...) {
            std::cout << "[WebView2] Unknown exception in WebView2 creation" << std::endl;
        }
    });
    
    return view;
}

// Utility function for creating CEF request contexts with partition support
// Platform implementation for partition_context.h — builds the on-disk
// cache_path for a persistent partition under %LOCALAPPDATA%, creating any
// missing parent directories. Returns "" when a safe persistent path cannot
// be built, which makes the caller fail closed instead of merging storage.
namespace electrobun {
std::string buildAndEnsurePartitionCachePath(const std::string& partitionName) {
    const std::wstring localAppData =
        getEnvironmentVariableWide(L"LOCALAPPDATA");
    if (localAppData.empty()) {
        printf("ERROR CEF: LOCALAPPDATA not found for partition '%s'\n", partitionName.c_str());
        return "";
    }

    std::wstring identifier;
    std::wstring channel;
    const auto partition =
        buildWindowsCEFPartitionDirectoryName(partitionName);
    if (!partition) {
        printf("ERROR CEF: persistent partition name is not supported on Windows\n");
        return "";
    }
    if (!utf8ToWide(g_electrobunIdentifier, identifier) ||
        !utf8ToWide(g_electrobunChannel, channel)) {
        printf("ERROR CEF: invalid UTF-8 in partition cache path\n");
        return "";
    }

    const std::wstring cachePath = buildCEFPartitionPath(
        localAppData, identifier, channel, L"CEF", *partition, L'\\');
    const int createResult =
        SHCreateDirectoryExW(nullptr, cachePath.c_str(), nullptr);
    if (createResult != ERROR_SUCCESS &&
        createResult != ERROR_ALREADY_EXISTS &&
        createResult != ERROR_FILE_EXISTS) {
        printf(
            "ERROR CEF: failed to create persistent partition directory (%d)\n",
            createResult);
        return "";
    }

    const DWORD attributes = GetFileAttributesW(cachePath.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        printf("ERROR CEF: persistent partition path is not a directory\n");
        return "";
    }

    // partition_context.h accepts UTF-8 at the CEF boundary. Keep all Windows
    // filesystem work above in UTF-16 and convert exactly once here.
    std::string utf8CachePath;
    if (!wideToUtf8(cachePath, utf8CachePath)) {
        printf("ERROR CEF: failed to encode partition cache path as UTF-8\n");
        return "";
    }
    return utf8CachePath;
}
} // namespace electrobun

static CefRefPtr<ElectrobunSchemeHandlerFactory> g_partitionSchemeFactory;

CefRefPtr<CefRequestContext> CreateRequestContextForPartition(const char* partitionIdentifier,
                                                               uint32_t webviewId) {
    if (!g_partitionSchemeFactory) {
        g_partitionSchemeFactory = new ElectrobunSchemeHandlerFactory();
    }
    return electrobun::getOrCreateRequestContextForPartition(
        partitionIdentifier,
        webviewId,
        g_partitionSchemeFactory);
}

static void beginCEFShutdownOnMainThread() {
    if (g_cefShutdownStartedOnUI) {
        quitCEFMessageLoopWhenDrained();
        return;
    }
    g_cefShutdownStartedOnUI = true;

    // No background DevTools fetch may retain a client or enqueue new CEF work
    // once browser teardown begins.
    joinRemoteDevToolsThreads();

    std::vector<CefRefPtr<CefBrowser>> browsers;
    browsers.reserve(g_cefBrowsers.size());
    for (const auto& [browserId, browser] : g_cefBrowsers) {
        (void)browserId;
        if (browser) {
            browsers.push_back(browser);
        }
    }

    if (!browsers.empty() || g_pendingCefBrowserCreations.load() != 0) {
        const HWND pumpWindow = g_cefPumpWindow.load();
        if (pumpWindow) {
            SetTimer(
                pumpWindow,
                CEF_SHUTDOWN_TIMER_ID,
                CEF_SHUTDOWN_TIMEOUT_MS,
                nullptr);
        }
    }

    // Force-close is appropriate during application shutdown: beforeunload
    // handlers must not keep the native event-loop thread alive indefinitely.
    // OnBeforeClose removes each browser from g_cefBrowsers and posts WM_QUIT
    // only after the final browser has completed CEF teardown.
    for (const auto& browser : browsers) {
        CefRefPtr<CefBrowserHost> host = browser->GetHost();
        if (host) {
            host->CloseBrowser(true);
        }
    }

    quitCEFMessageLoopWhenDrained();
}

static bool drainCEFForShutdownOnMainThread(int timeoutMs) {
    beginCEFShutdownOnMainThread();
    if (g_cefShutdownTimedOut.load()) {
        return false;
    }
    const auto deadline = std::chrono::steady_clock::now() +
        std::chrono::milliseconds(timeoutMs);

    while ((!g_cefBrowsers.empty() ||
            g_pendingCefBrowserCreations.load() != 0) &&
           std::chrono::steady_clock::now() < deadline) {
        CefDoMessageLoopWork();

        MSG message;
        while (PeekMessage(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) {
                continue;
            }
            TranslateMessage(&message);
            DispatchMessage(&message);
        }
        Sleep(1);
    }

    return g_cefBrowsers.empty() &&
        g_pendingCefBrowserCreations.load() == 0 &&
        !g_cefShutdownTimedOut.load();
}

static void releaseCEFReferencesBeforeShutdown() {
    // A failed asynchronous creation can be retained by the FFI owner without
    // ever reaching a ContainerView. Release every retained CEF view as well as
    // the container-owned views so no CefRefPtr survives CefShutdown.
    std::vector<std::shared_ptr<CEFView>> retainedCefViews;
    {
        std::lock_guard<std::mutex> lock(g_retainedAbstractViewsMutex);
        for (const auto& [webviewId, view] : g_retainedAbstractViews) {
            (void)webviewId;
            if (auto cefView = std::dynamic_pointer_cast<CEFView>(view)) {
                retainedCefViews.push_back(std::move(cefView));
            }
        }
    }
    for (const auto& cefView : retainedCefViews) {
        cefView->ReleaseCEFReferencesForShutdown();
    }

    for (const auto& [window, container] : g_containerViews) {
        (void)window;
        if (container) {
            container->ReleaseCEFReferencesForShutdown();
        }
    }

    g_cefViews.clear();
    g_cefClients.clear();
    g_cefBrowsers.clear();
    {
        std::lock_guard<std::mutex> lock(
            electrobun::partitionContextMutex_());
        electrobun::partitionContextMap_().clear();
    }
    g_partitionSchemeFactory = nullptr;
    g_cef_app = nullptr;
}

// Internal factory method for creating CEF instances
static std::shared_ptr<CEFView> createCEFView(uint32_t webviewId,
                                       HWND hwnd,
                                       const char *url,
                                       double x, double y,
                                       double width, double height,
                                       bool autoResize,
                                       const char *partitionIdentifier,
                                       DecideNavigationCallback navigationCallback,
                                       WebviewEventHandler webviewEventHandler,
                                       HandlePostMessage eventBridgeHandler,
                                       HandlePostMessage bunBridgeHandler,
                                       HandlePostMessage internalBridgeHandler,
                                       const char *electrobunPreloadScript,
                                       const char *customPreloadScript,
                                       bool startTransparent,
                                       bool startPassthrough,
                                       bool transparent,
                                       bool sandbox) {
    
    auto view = std::make_shared<CEFView>(webviewId);
    if (g_eventLoopStopping.load()) {
        view->setCreationFailed(true);
        return view;
    }
    view->hwnd = hwnd;
    view->parentWindow = hwnd;
    view->fullSize = autoResize;
    view->pendingStartTransparent = startTransparent;
    view->pendingStartPassthrough = startPassthrough;
    view->setLogicalFrame(x, y, width, height);
    
    // Initialize CEF on main thread
    bool cefInitResult = MainThreadDispatcher::dispatch_sync([=]() -> bool {
        return initCEF();
    });
    
    if (!cefInitResult) {
        ::log("ERROR: Failed to initialize CEF");
        view->setCreationFailed(true);
        return view;
    }
    
    // CEF browser creation logic
    MainThreadDispatcher::dispatch_sync([=]() {
        if (g_eventLoopStopping.load()) {
            view->setCreationFailed(true);
            return;
        }
        auto container = GetOrCreateContainer(hwnd);
        if (!container) {
            ::log("ERROR: Failed to create container");
            view->setCreationFailed(true);
            return;
        }
        
        // Create CEF browser info
        CefWindowInfo windowInfo;
        windowInfo.runtime_style = CEF_RUNTIME_STYLE_ALLOY;
        const RECT physicalBounds = electrobun::logicalToPhysicalRect(
            x,
            y,
            width,
            height,
            electrobun::windowsDpiForWindow(hwnd));
        CefRect cefBounds(
            physicalBounds.left,
            physicalBounds.top,
            physicalBounds.right - physicalBounds.left,
            physicalBounds.bottom - physicalBounds.top);

        CefBrowserSettings browserSettings;
        // Note: web_security setting for CEF would need correct API

        // Set transparent background if requested
        if (transparent) {
            // CEF uses ARGB format: 0x00000000 = fully transparent
            browserSettings.background_color = 0;
        }

        // Create CEF client with bridge handlers
        auto client = new ElectrobunCefClient(webviewId, eventBridgeHandler, bunBridgeHandler, internalBridgeHandler, sandbox);

        // Configure OSR mode for transparent windows
        if (transparent) {
            int osrWidthPixels = physicalBounds.right - physicalBounds.left;
            int osrHeightPixels = physicalBounds.bottom - physicalBounds.top;
            if (autoResize) {
                RECT clientBounds = {};
                if (GetClientRect(hwnd, &clientBounds)) {
                    osrWidthPixels = clientBounds.right - clientBounds.left;
                    osrHeightPixels = clientBounds.bottom - clientBounds.top;
                }
            }

            // Enable OSR mode
            client->EnableOSR(osrWidthPixels, osrHeightPixels);

            // Create OSR window for rendering
            // For OSR, the window should fill the parent window's client area (0, 0)
            OSRWindow* osrWindow = new OSRWindow(
                hwnd, 0, 0, osrWidthPixels, osrHeightPixels);
            view->setOSRWindow(osrWindow);
            client->SetOSRWindow(osrWindow);

            // Use windowless (off-screen) rendering
            windowInfo.SetAsWindowless(hwnd);
        } else {
            // Use windowed mode
            windowInfo.SetAsChild(container->GetHwnd(), cefBounds);
        }
        
        // Set up preload scripts
        if (electrobunPreloadScript && strlen(electrobunPreloadScript) > 0) {
            client->AddPreloadScript(std::string(electrobunPreloadScript));
        }
        if (customPreloadScript && strlen(customPreloadScript) > 0) {
            client->UpdateCustomPreloadScript(std::string(customPreloadScript));
        }
        
        // Set the webview event handler for ctrl+click handling
        client->SetWebviewEventHandler(webviewEventHandler);

        // Set the abstract view pointer for navigation rules
        client->SetAbstractView(view.get());

        view->setClient(client);

        // Set up load-end callback for deferred transparency/passthrough
        // application. Use a weak reference because browser close can outlive
        // removal of the app-owned view.
        std::weak_ptr<CEFView> weakView = view;
        client->SetLoadEndCallback([weakView]() {
            auto readyView = weakView.lock();
            if (!readyView) return;

            if (readyView->pendingStartTransparent) {
                readyView->setTransparent(true);
                readyView->pendingStartTransparent = false;
            }
            if (readyView->pendingStartPassthrough) {
                readyView->setPassthrough(true);
                readyView->pendingStartPassthrough = false;
            }
            // Re-apply passthrough if it was already set (in case navigation
            // reset it).
            if (readyView->isMousePassthroughEnabled &&
                !readyView->pendingStartPassthrough) {
                readyView->setPassthrough(true);
            }
        });

        // Create request context for partition isolation
        CefRefPtr<CefRequestContext> requestContext = CreateRequestContextForPartition(
            partitionIdentifier,
            webviewId
        );
        if (!requestContext) {
            ::log("ERROR: Failed to initialize the CEF request context");
            client->PrepareForBrowserClose();
            view->setClient(nullptr);
            view->setCreationFailed(true);
            return;
        }

        // Pass sandbox flag to renderer process via extra_info
        CefRefPtr<CefDictionaryValue> extra_info = CefDictionaryValue::Create();
        extra_info->SetBool("sandbox", sandbox);

        // Install app-owned state before requesting creation. CreateBrowser is
        // intentionally asynchronous: CEF may need to initialize a newly
        // created named request context, and manually pumping that initialization
        // from this synchronous FFI call re-enters Bun before initWebview has
        // returned and installed the native view pointer.
        const HWND containerHwnd = container->GetHwnd();
        const HWND mapKey = transparent ? hwnd : containerHwnd;
        const RECT initialBounds = physicalBounds;
        view->visualBounds = initialBounds;
        container->AddAbstractView(view);

        trackAbstractView(view.get());
        g_cefClients[mapKey] = client;
        g_cefViews[mapKey] = view.get();

        if (url && url[0] != '\0') {
            view->loadURL(url);
        }

        ElectrobunCefClient* clientPtr = client;
        client->SetBrowserCreatedCallback(
            [weakView, clientPtr, webviewId, mapKey, transparent, initialBounds](
                CefRefPtr<CefBrowser> browser) {
                auto readyView = weakView.lock();
                if (!readyView ||
                    readyView->getClient().get() != clientPtr ||
                    g_eventLoopStopping.load()) {
                    CefRefPtr<CefBrowserHost> host = browser->GetHost();
                    if (host) {
                        host->CloseBrowser(true);
                    }
                    return;
                }

                SetBrowserOnClient(clientPtr, browser);
                {
                    std::lock_guard<std::mutex> lock(browserMapMutex);
                    browserToWebviewMap[browser->GetIdentifier()] = webviewId;
                }
                readyView->setBrowser(browser);

                printf(
                    "CEF: Registered view with hwnd=%p (transparent=%d)\n",
                    mapKey,
                    transparent);

                // Bring the asynchronously-created child into its requested
                // position and apply initial window state. Load-end repeats the
                // state in case navigation resets it.
                readyView->resize(initialBounds, nullptr);
                if (readyView->pendingStartTransparent) {
                    readyView->setTransparent(true);
                }
                if (readyView->pendingStartPassthrough) {
                    readyView->setPassthrough(true);
                }
            });

        client->MarkInitialBrowserCreationPending();
        const bool browserCreationStarted = CefBrowserHost::CreateBrowser(
            windowInfo,
            client,
            "about:blank",
            browserSettings,
            extra_info,
            requestContext);

        if (!browserCreationStarted) {
            client->ResolveInitialBrowserCreationPending();
            client->PrepareForBrowserClose();
            view->setClient(nullptr);
            view->setCreationFailed(true);
            if (auto it = g_cefViews.find(mapKey);
                it != g_cefViews.end() && it->second == view.get()) {
                g_cefViews.erase(it);
            }
            if (auto it = g_cefClients.find(mapKey);
                it != g_cefClients.end() && it->second.get() == clientPtr) {
                g_cefClients.erase(it);
            }
            ::log("ERROR: CefBrowserHost::CreateBrowser returned false");
            quitCEFMessageLoopWhenDrained();
        }
    });

    return view;
}

// Console control handler for graceful shutdown
BOOL WINAPI ConsoleControlHandler(DWORD dwCtrlType) {
    switch (dwCtrlType) {
        case CTRL_C_EVENT:
        case CTRL_BREAK_EVENT:
        case CTRL_CLOSE_EVENT:
        case CTRL_LOGOFF_EVENT:
        case CTRL_SHUTDOWN_EVENT:
            std::cout << "[shutdown] Received console shutdown signal" << std::endl;

            if (g_quitRequestedHandler && !g_eventLoopStopping.load()) {
                // Route through bun's quit sequence for proper beforeQuit handling
                g_quitRequestedHandler();
                // Wait for orderly shutdown (Windows gives ~5s for CTRL_CLOSE_EVENT)
                int waited = 0;
                while (!g_shutdownComplete.load() && waited < 4000) {
                    Sleep(10);
                    waited += 10;
                }
            } else {
                // Fallback: direct shutdown - post WM_QUIT to exit the message loop
                if (g_mainThreadId != 0) {
                    PostThreadMessage(g_mainThreadId, WM_QUIT, 0, 0);
                }
            }
            return TRUE;
        default:
            return FALSE;
    }
}

extern "C" {

ELECTROBUN_EXPORT void startEventLoop(const char* identifier, const char* name, const char* channel) {
    configurePerMonitorDpiAwareness();
    g_mainThreadId = GetCurrentThreadId();

    // Store identifier, name, and channel globally for use in CEF initialization
    if (identifier && identifier[0]) {
        g_electrobunIdentifier = std::string(identifier);
    }
    if (name && name[0]) {
        g_electrobunName = std::string(name);
    }
    if (channel && channel[0]) {
        g_electrobunChannel = std::string(channel);
    }

    loadWebView2PermissionPolicy();

    // Set up console control handler for graceful shutdown on Ctrl+C
    if (!SetConsoleCtrlHandler(ConsoleControlHandler, TRUE)) {
        std::cout << "[CEF] Warning: Failed to set console control handler" << std::endl;
    }
    
    // Create a hidden message-only window for dispatching
    WNDCLASSW wc = {0};
    wc.lpfnWndProc = MessageWindowProc;
    wc.hInstance = g_hInstanceDll;
    wc.lpszClassName = L"MessageWindowClass";
    RegisterClassW(&wc);
    
    HWND messageWindow = CreateWindowW(
        L"MessageWindowClass",
        L"",
        0, 0, 0, 0, 0,
        HWND_MESSAGE, // This makes it a message-only window
        NULL, 
        g_hInstanceDll,
        NULL
    );
    
    // Initialize the dispatcher
    MainThreadDispatcher::initialize(messageWindow);
    
    // Initialize CEF if available
    if (isCEFAvailable()) {
        if (initCEF()) {
            // With external_message_pump=true, CefDoMessageLoopWork does NOT
            // internally pump Windows messages. This prevents CEF from stealing
            // WebView2 messages while still processing CEF work on a timer.
            //
            // OnScheduleMessagePumpWork posts WM_CEF_SCHEDULE_WORK for immediate
            // work and uses SetTimer for delayed work. We also keep a baseline
            // timer to ensure CEF always gets serviced.
            WNDCLASSW cefPumpWc = {0};
            cefPumpWc.lpfnWndProc = [](HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) -> LRESULT {
                if (msg == WM_TIMER && wParam == CEF_SHUTDOWN_TIMER_ID) {
                    KillTimer(hwnd, CEF_SHUTDOWN_TIMER_ID);
                    if (g_eventLoopStopping.load() &&
                        (!g_cefBrowsers.empty() ||
                         g_pendingCefBrowserCreations.load() != 0)) {
                        g_cefShutdownTimedOut.store(true);
                        std::cerr
                            << "[CEF] Timed out waiting for browser teardown"
                            << std::endl;
                        PostQuitMessage(0);
                    }
                    return 0;
                }
                if (msg == WM_CEF_SCHEDULE_WORK || msg == WM_TIMER) {
                    CefDoMessageLoopWork();
                    return 0;
                }
                return DefWindowProcW(hwnd, msg, wParam, lParam);
            };
            cefPumpWc.hInstance = g_hInstanceDll;
            cefPumpWc.lpszClassName = L"CefPumpWindowClass";
            RegisterClassW(&cefPumpWc);
            const HWND cefPumpWindow = CreateWindowW(
                L"CefPumpWindowClass", L"", 0, 0, 0, 0, 0,
                HWND_MESSAGE, NULL, g_hInstanceDll, NULL);
            g_cefPumpWindow.store(cefPumpWindow);

            // Baseline timer ensures CEF always gets serviced even if
            // OnScheduleMessagePumpWork misses a beat
            SetTimer(cefPumpWindow, 2, 16, nullptr);

            // Kick off initial CEF work
            CefDoMessageLoopWork();

            // Standard Windows message loop
            MSG msg;
            while (GetMessage(&msg, NULL, 0, 0)) {
                if (g_hAccelTable && TranslateAccelerator(msg.hwnd, g_hAccelTable, &msg)) {
                    continue;
                }
                TranslateMessage(&msg);
                DispatchMessage(&msg);
            }
            // Clean up after shutdown
            std::cout << "[CEF] CEF message loop ended, performing cleanup..." << std::endl;
            const bool browsersDrained =
                drainCEFForShutdownOnMainThread(CEF_SHUTDOWN_TIMEOUT_MS);

            const HWND pumpWindow = g_cefPumpWindow.exchange(nullptr);
            if (pumpWindow) {
                KillTimer(pumpWindow, 1);
                KillTimer(pumpWindow, 2);
                KillTimer(pumpWindow, CEF_SHUTDOWN_TIMER_ID);
                DestroyWindow(pumpWindow);
            }

            if (browsersDrained) {
                releaseCEFReferencesBeforeShutdown();
                std::cout << "[CEF] Calling CefShutdown" << std::endl;
                CefShutdown();
                std::cout << "[CEF] CefShutdown complete" << std::endl;
                g_cef_initialized.store(false);
            } else {
                std::cerr << "[CEF] Timed out waiting for OnBeforeClose; "
                             "skipping CefShutdown before forced process exit"
                          << std::endl;
            }
            g_shutdownComplete.store(true);
        } else {
            // Fall back to Windows message loop if CEF init fails
            MSG msg;
            while (GetMessage(&msg, NULL, 0, 0)) {
                // Check for menu accelerators first
                if (g_hAccelTable && TranslateAccelerator(msg.hwnd, g_hAccelTable, &msg)) {
                    continue;
                }
                TranslateMessage(&msg);
                DispatchMessage(&msg);
            }
            g_shutdownComplete.store(true);
        }
    } else {
        // Use Windows message loop if CEF is not available
        MSG msg;
        while (GetMessage(&msg, NULL, 0, 0)) {
            // Check for menu accelerators first
            if (g_hAccelTable && TranslateAccelerator(msg.hwnd, g_hAccelTable, &msg)) {
                continue;
            }
            TranslateMessage(&msg);
            DispatchMessage(&msg);
        }
        g_shutdownComplete.store(true);
    }
}


ELECTROBUN_EXPORT void stopEventLoop() {
    if (g_eventLoopStopping.exchange(true)) {
        return;
    }

    std::cout << "[stopEventLoop] Initiating clean event loop exit" << std::endl;

    if (isCEFAvailable() && g_cef_initialized.load()) {
        MainThreadDispatcher::dispatch_async([]() {
            beginCEFShutdownOnMainThread();
        });
    } else {
        // Post WM_QUIT to the main thread's message queue
        if (g_mainThreadId != 0) {
            PostThreadMessage(g_mainThreadId, WM_QUIT, 0, 0);
        }
    }
}

ELECTROBUN_EXPORT void killApp() {
    // Deprecated - delegates to stopEventLoop for backward compatibility
    stopEventLoop();
}

ELECTROBUN_EXPORT void waitForShutdownComplete(int timeoutMs) {
    const int effectiveTimeoutMs = g_cef_initialized.load()
        ? (std::max)(timeoutMs, CEF_GRACEFUL_SHUTDOWN_WAIT_MS)
        : timeoutMs;
    int waited = 0;
    while (!g_shutdownComplete.load() && waited < effectiveTimeoutMs) {
        Sleep(10);
        waited += 10;
    }
}

ELECTROBUN_EXPORT void forceExit(int code) {
    _exit(code);
}

ELECTROBUN_EXPORT void setQuitRequestedHandler(QuitRequestedHandler handler) {
    g_quitRequestedHandler = handler;
}

ELECTROBUN_EXPORT void shutdownApplication() {
    // Deprecated - use stopEventLoop() instead
    stopEventLoop();
}

// Global flags set by setNextWebviewFlags, consumed by initWebview
static struct {
    bool startTransparent;
    bool startPassthrough;
} g_nextWebviewFlags = {false, false};

ELECTROBUN_EXPORT void setNextWebviewFlags(bool startTransparent, bool startPassthrough) {
    g_nextWebviewFlags.startTransparent = startTransparent;
    g_nextWebviewFlags.startPassthrough = startPassthrough;
}

// Clean, elegant initWebview function - Windows version matching Mac pattern
ELECTROBUN_EXPORT AbstractView* initWebview(uint32_t webviewId,
                         NSWindow *window,  // Actually HWND on Windows
                         const char *renderer,
                         const char *url,
                         double x, double y,
                         double width, double height,
                         bool autoResize,
                         const char *partitionIdentifier,
                         DecideNavigationCallback navigationCallback,
                         WebviewEventHandler webviewEventHandler,
                         HandlePostMessage eventBridgeHandler,
                         HandlePostMessage bunBridgeHandler,
                         HandlePostMessage internalBridgeHandler,
                         const char *electrobunPreloadScript,
                         const char *customPreloadScript,
                         const char *viewsRoot,
                         bool transparent,
                         bool sandbox) {

    // Read and clear pre-set flags
    bool startTransparent = g_nextWebviewFlags.startTransparent;
    bool startPassthrough = g_nextWebviewFlags.startPassthrough;
    g_nextWebviewFlags = {false, false};

    // Serialize webview creation to avoid CEF/WebView2 conflicts
    std::lock_guard<std::mutex> lock(g_webviewCreationMutex);


    HWND hwnd = reinterpret_cast<HWND>(window);

    // Factory pattern - choose implementation based on renderer
    AbstractView* view = nullptr;

    if (renderer && strcmp(renderer, "cef") == 0 && isCEFAvailable()) {
        auto cefView = createCEFView(webviewId, hwnd, url, x, y, width, height, autoResize,
                                    partitionIdentifier, navigationCallback, webviewEventHandler,
                                    eventBridgeHandler, bunBridgeHandler, internalBridgeHandler,
                                    electrobunPreloadScript, customPreloadScript,
                                    startTransparent, startPassthrough,
                                    transparent, sandbox);
        retainAbstractView(cefView);
        view = cefView.get();
    } else {
        auto webview2View = createWebView2View(webviewId, hwnd, url, x, y, width, height, autoResize,
                                              partitionIdentifier, navigationCallback, webviewEventHandler,
                                              eventBridgeHandler, bunBridgeHandler, internalBridgeHandler,
                                              electrobunPreloadScript, customPreloadScript,
                                              startTransparent, startPassthrough,
                                              transparent, sandbox);
        retainAbstractView(webview2View);
        view = webview2View.get();
    }

    // Note: Object lifetime is managed by the ContainerView which holds shared_ptr references
    // The factories add the views to containers, so they remain alive after this function returns

    return view;

}

ELECTROBUN_EXPORT AbstractView* initWGPUView(uint32_t webviewId,
                         NSWindow *window,  // Actually HWND on Windows
                         double x, double y,
                         double width, double height,
                         bool autoResize,
                         bool startTransparent,
                         bool startPassthrough) {

    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) {
        ::log("ERROR: initWGPUView called with invalid window handle");
        return nullptr;
    }

    auto view = std::make_shared<WGPUView>(webviewId);
    view->parentWindow = hwnd;
    view->fullSize = autoResize;
    view->setLogicalFrame(x, y, width, height);

    // Create both container and WGPUView child on the main thread to avoid
    // cross-thread child window deadlock (container on FFI thread + child on
    // main thread would deadlock because CreateWindowExW sends messages to
    // the parent's thread which is blocked on dispatch_sync).
    ContainerView* container = nullptr;
    bool initialized = false;
    MainThreadDispatcher::dispatch_sync([&container, &initialized, view, hwnd, x, y, width, height, startTransparent, startPassthrough]() {
        // Get or create container on main thread
        container = GetOrCreateContainer(hwnd);
        if (!container) {
            ::log("ERROR: Failed to create container for WGPUView");
            return;
        }

        HWND containerHwnd = container->GetHwnd();
        if (!IsWindow(containerHwnd)) {
            ::log("ERROR: Container window handle invalid for WGPUView");
            return;
        }

        RECT physicalBounds = electrobun::logicalToPhysicalRect(
            x,
            y,
            width,
            height,
            electrobun::windowsDpiForWindow(hwnd));
        if (view->fullSize) {
            // The public window frame includes Win32 non-client chrome. A
            // full-size WGPU view fills the drawable client area instead.
            GetClientRect(containerHwnd, &physicalBounds);
        }
        view->hwnd = CreateWindowExW(
            0,
            L"STATIC",
            L"",
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            physicalBounds.left,
            physicalBounds.top,
            physicalBounds.right - physicalBounds.left,
            physicalBounds.bottom - physicalBounds.top,
            containerHwnd,
            NULL,
            GetModuleHandle(NULL),
            NULL
        );

        if (!view->hwnd) {
            ::log("ERROR: Failed to create WGPUView child window");
            return;
        }

        view->visualBounds = physicalBounds;

        if (startTransparent) {
            view->setTransparent(true);
        }
        if (startPassthrough) {
            view->setPassthrough(true);
        }

        // ContainerView and its child list belong to the Windows UI thread.
        // Register the view here as part of the same operation that creates
        // its HWND so message handling and z-order updates cannot race the
        // Cottontail/FFI thread.
        retainWGPUView(view);
        container->AddAbstractView(view);
        initialized = true;
    });

    if (!initialized) {
        ::log("ERROR: initWGPUView dispatch_sync failed to create a native view");
        return nullptr;
    }

    return view.get();
}

ELECTROBUN_EXPORT MyScriptMessageHandlerWithReply* addScriptMessageHandlerWithReply(WKWebView *webView,
                                                              uint32_t webviewId,
                                                              const char *name,
                                                              HandlePostMessageWithReply callback) {
    // Stub implementation
    MyScriptMessageHandlerWithReply* handler = new MyScriptMessageHandlerWithReply();
    handler->zigCallback = callback;
    handler->webviewId = webviewId;
    return handler;
}
ELECTROBUN_EXPORT void loadURLInWebView(AbstractView *abstractView, const char *urlString) {
    if (!abstractView || !urlString) {
        ::log("ERROR: Invalid parameters passed to loadURLInWebView");
        return;
    }
    
    const std::string url(urlString);
    MainThreadDispatcher::dispatch_sync([abstractView, url]() {
        abstractView->loadURL(url.c_str());
    });
}

ELECTROBUN_EXPORT void wgpuViewSetFrame(AbstractView *abstractView, double x, double y, double width, double height) {
    if (!abstractView) return;
    abstractView->setLogicalFrame(x, y, width, height);
    const RECT bounds = electrobun::logicalToPhysicalRect(
        x, y, width, height, abstractView->parentDpi());
    abstractView->storePendingResize(bounds, "");
    g_pendingResizeQueue.enqueue(abstractView);
    schedulePendingResizeDrain();
}

ELECTROBUN_EXPORT void wgpuViewSetTransparent(AbstractView *abstractView, BOOL transparent) {
    if (!abstractView) return;
    MainThreadDispatcher::dispatch_sync([abstractView, transparent]() {
        abstractView->setTransparent(transparent);
    });
}

ELECTROBUN_EXPORT void wgpuViewSetPassthrough(AbstractView *abstractView, BOOL enablePassthrough) {
    if (!abstractView) return;
    MainThreadDispatcher::dispatch_sync([abstractView, enablePassthrough]() {
        abstractView->setPassthrough(enablePassthrough);
    });
}

ELECTROBUN_EXPORT void wgpuViewSetHidden(AbstractView *abstractView, BOOL hidden) {
    if (!abstractView) return;
    MainThreadDispatcher::dispatch_sync([abstractView, hidden]() {
        abstractView->setHidden(hidden);
    });
}

ELECTROBUN_EXPORT void wgpuViewRemove(AbstractView *abstractView) {
    if (!abstractView) return;
    MainThreadDispatcher::dispatch_sync([abstractView]() {
        std::shared_ptr<AbstractView> retainedView =
            takeRetainedWGPUView(abstractView);
        if (!retainedView) return;

        g_pendingResizeQueue.remove(retainedView.get());
        retainedView->remove();
    });
}

ELECTROBUN_EXPORT void* wgpuViewGetNativeHandle(AbstractView *abstractView) {
    if (!abstractView) return nullptr;
    return abstractView->hwnd;
}

// ----------------------- WGPU Main-Thread Shims -----------------------

typedef void* (*PFN_wgpuInstanceCreateSurface)(void* instance, const void* descriptor);
typedef void (*PFN_wgpuSurfaceConfigure)(void* surface, const void* config);
typedef void (*PFN_wgpuSurfaceGetCurrentTexture)(void* surface, void* surfaceTexture);
typedef int32_t (*PFN_wgpuSurfacePresent)(void* surface);
typedef WGPUFuture (*PFN_wgpuQueueOnSubmittedWorkDone)(WGPUQueue queue, WGPUQueueWorkDoneCallbackInfo callbackInfo);
typedef WGPUFuture (*PFN_wgpuBufferMapAsync)(WGPUBuffer buffer, WGPUMapMode mode, size_t offset, size_t size, WGPUBufferMapCallbackInfo callbackInfo);
typedef WGPUWaitStatus (*PFN_wgpuInstanceWaitAny)(WGPUInstance instance, size_t futureCount, WGPUFutureWaitInfo* futures, uint64_t timeoutNS);
typedef void* (*PFN_wgpuBufferGetMappedRange)(WGPUBuffer buffer, size_t offset, size_t size);
typedef void* (*PFN_wgpuBufferGetConstMappedRange)(WGPUBuffer buffer, size_t offset, size_t size);
typedef void (*PFN_wgpuBufferUnmap)(WGPUBuffer buffer);

static HMODULE wgpuLibHandle = nullptr;
static PFN_wgpuInstanceCreateSurface p_wgpuInstanceCreateSurface = nullptr;
static PFN_wgpuSurfaceConfigure p_wgpuSurfaceConfigure = nullptr;
static PFN_wgpuSurfaceGetCurrentTexture p_wgpuSurfaceGetCurrentTexture = nullptr;
static PFN_wgpuSurfacePresent p_wgpuSurfacePresent = nullptr;
static PFN_wgpuQueueOnSubmittedWorkDone p_wgpuQueueOnSubmittedWorkDone = nullptr;
static PFN_wgpuBufferMapAsync p_wgpuBufferMapAsync = nullptr;
static PFN_wgpuInstanceWaitAny p_wgpuInstanceWaitAny = nullptr;
static PFN_wgpuBufferGetMappedRange p_wgpuBufferGetMappedRange = nullptr;
static PFN_wgpuBufferGetConstMappedRange p_wgpuBufferGetConstMappedRange = nullptr;
static PFN_wgpuBufferUnmap p_wgpuBufferUnmap = nullptr;

// ----------------------- WGPU GPU Test (native cube) -----------------------

// Helper for formatted WGPU test logging
// Uses fprintf(stderr) + fflush for immediate visibility, plus the normal log() for file output
static void wgpu_log(const char* fmt, ...) {
    char buf[512];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    fprintf(stderr, "[WGPU] %s\n", buf);
    fflush(stderr);
    std::cout << "[WGPU] " << buf << std::endl;
    std::cout.flush();
}

// Additional typedefs for the GPU test (matches macOS reference)
typedef WGPUInstance (*PFN_wgpuCreateInstance)(WGPUInstanceDescriptor const* descriptor);
typedef WGPUFuture (*PFN_wgpuInstanceRequestAdapter)(WGPUInstance instance, WGPURequestAdapterOptions const* options, WGPURequestAdapterCallbackInfo callbackInfo);
typedef WGPUFuture (*PFN_wgpuAdapterRequestDevice)(WGPUAdapter adapter, WGPUDeviceDescriptor const* descriptor, WGPURequestDeviceCallbackInfo callbackInfo);
typedef WGPUBool (*PFN_wgpuAdapterHasFeature)(WGPUAdapter adapter, WGPUFeatureName feature);
typedef WGPUQueue (*PFN_wgpuDeviceGetQueue)(WGPUDevice device);
typedef void (*PFN_wgpuSurfaceGetCapabilities2)(WGPUSurface surface, WGPUAdapter adapter, WGPUSurfaceCapabilities* capabilities);
typedef void (*PFN_wgpuSurfaceCapabilitiesFreeMembers2)(WGPUSurfaceCapabilities capabilities);
typedef WGPUShaderModule (*PFN_wgpuDeviceCreateShaderModule)(WGPUDevice device, WGPUShaderModuleDescriptor const* descriptor);
typedef WGPURenderPipeline (*PFN_wgpuDeviceCreateRenderPipeline)(WGPUDevice device, WGPURenderPipelineDescriptor const* descriptor);
typedef void (*PFN_wgpuDeviceSetLabel)(WGPUDevice device, WGPUStringView label);
typedef WGPUBuffer (*PFN_wgpuDeviceCreateBuffer)(WGPUDevice device, WGPUBufferDescriptor const* descriptor);
typedef void (*PFN_wgpuQueueWriteBuffer)(WGPUQueue queue, WGPUBuffer buffer, uint64_t bufferOffset, void const* data, size_t size);
typedef WGPUCommandEncoder (*PFN_wgpuDeviceCreateCommandEncoder)(WGPUDevice device, WGPUCommandEncoderDescriptor const* descriptor);
typedef WGPURenderPassEncoder (*PFN_wgpuCommandEncoderBeginRenderPass)(WGPUCommandEncoder encoder, WGPURenderPassDescriptor const* descriptor);
typedef void (*PFN_wgpuRenderPassEncoderSetPipeline)(WGPURenderPassEncoder pass, WGPURenderPipeline pipeline);
typedef void (*PFN_wgpuRenderPassEncoderSetVertexBuffer)(WGPURenderPassEncoder pass, uint32_t slot, WGPUBuffer buffer, uint64_t offset, uint64_t size);
typedef void (*PFN_wgpuRenderPassEncoderDraw)(WGPURenderPassEncoder pass, uint32_t vertexCount, uint32_t instanceCount, uint32_t firstVertex, uint32_t firstInstance);
typedef void (*PFN_wgpuRenderPassEncoderEnd)(WGPURenderPassEncoder pass);
typedef WGPUCommandBuffer (*PFN_wgpuCommandEncoderFinish)(WGPUCommandEncoder encoder, WGPUCommandBufferDescriptor const* descriptor);
typedef void (*PFN_wgpuQueueSubmit)(WGPUQueue queue, size_t commandCount, WGPUCommandBuffer const* commands);
typedef WGPUTextureView (*PFN_wgpuTextureCreateView)(WGPUTexture texture, WGPUTextureViewDescriptor const* descriptor);
typedef void (*PFN_wgpuTextureViewRelease)(WGPUTextureView view);
typedef void (*PFN_wgpuTextureRelease)(WGPUTexture texture);
typedef void (*PFN_wgpuCommandBufferRelease)(WGPUCommandBuffer buffer);
typedef void (*PFN_wgpuCommandEncoderRelease)(WGPUCommandEncoder encoder);

static PFN_wgpuCreateInstance p_wgpuCreateInstance = nullptr;
static PFN_wgpuInstanceRequestAdapter p_wgpuInstanceRequestAdapter = nullptr;
static PFN_wgpuAdapterRequestDevice p_wgpuAdapterRequestDevice = nullptr;
static PFN_wgpuAdapterHasFeature p_wgpuAdapterHasFeature = nullptr;
static PFN_wgpuDeviceGetQueue p_wgpuDeviceGetQueue = nullptr;
static PFN_wgpuSurfaceGetCapabilities2 p_wgpuSurfaceGetCapabilities = nullptr;
static PFN_wgpuSurfaceCapabilitiesFreeMembers2 p_wgpuSurfaceCapabilitiesFreeMembers = nullptr;
static PFN_wgpuDeviceCreateShaderModule p_wgpuDeviceCreateShaderModule = nullptr;
static PFN_wgpuDeviceCreateRenderPipeline p_wgpuDeviceCreateRenderPipeline = nullptr;
static PFN_wgpuDeviceSetLabel p_wgpuDeviceSetLabel = nullptr;
static PFN_wgpuDeviceCreateBuffer p_wgpuDeviceCreateBuffer = nullptr;
static PFN_wgpuQueueWriteBuffer p_wgpuQueueWriteBuffer = nullptr;
static PFN_wgpuDeviceCreateCommandEncoder p_wgpuDeviceCreateCommandEncoder = nullptr;
static PFN_wgpuCommandEncoderBeginRenderPass p_wgpuCommandEncoderBeginRenderPass = nullptr;
static PFN_wgpuRenderPassEncoderSetPipeline p_wgpuRenderPassEncoderSetPipeline = nullptr;
static PFN_wgpuRenderPassEncoderSetVertexBuffer p_wgpuRenderPassEncoderSetVertexBuffer = nullptr;
static PFN_wgpuRenderPassEncoderDraw p_wgpuRenderPassEncoderDraw = nullptr;
static PFN_wgpuRenderPassEncoderEnd p_wgpuRenderPassEncoderEnd = nullptr;
static PFN_wgpuCommandEncoderFinish p_wgpuCommandEncoderFinish = nullptr;
static PFN_wgpuQueueSubmit p_wgpuQueueSubmit = nullptr;
static PFN_wgpuTextureCreateView p_wgpuTextureCreateView = nullptr;
static PFN_wgpuTextureViewRelease p_wgpuTextureViewRelease = nullptr;
static PFN_wgpuTextureRelease p_wgpuTextureRelease = nullptr;
static PFN_wgpuCommandBufferRelease p_wgpuCommandBufferRelease = nullptr;
static PFN_wgpuCommandEncoderRelease p_wgpuCommandEncoderRelease = nullptr;

// DComp zero-copy bridge function pointers (SharedTextureMemory API)
static WGPUProcDeviceHasFeature p_wgpuDeviceHasFeature = nullptr;
static WGPUProcDeviceImportSharedFence p_wgpuDeviceImportSharedFence = nullptr;
static WGPUProcDeviceImportSharedTextureMemory p_wgpuDeviceImportSharedTextureMemory = nullptr;
static WGPUProcSharedTextureMemoryGetProperties p_wgpuSharedTextureMemoryGetProperties = nullptr;
static WGPUProcSharedTextureMemoryCreateTexture p_wgpuSharedTextureMemoryCreateTexture = nullptr;
static WGPUProcSharedTextureMemoryBeginAccess p_wgpuSharedTextureMemoryBeginAccess = nullptr;
static WGPUProcSharedTextureMemoryEndAccess p_wgpuSharedTextureMemoryEndAccess = nullptr;
static WGPUProcSharedTextureMemoryEndAccessStateFreeMembers p_wgpuSharedTextureMemoryEndAccessStateFreeMembers = nullptr;
static WGPUProcSharedTextureMemoryRelease p_wgpuSharedTextureMemoryRelease = nullptr;
static WGPUProcSharedFenceExportInfo p_wgpuSharedFenceExportInfo = nullptr;
static WGPUProcSharedFenceRelease p_wgpuSharedFenceRelease = nullptr;
static WGPUProcTextureDestroy p_wgpuTextureDestroy = nullptr;
static WGPUProcTextureGetUsage p_wgpuTextureGetUsage = nullptr;
static WGPUProcTextureAddRef p_wgpuTextureAddRef = nullptr;
static WGPUProcSurfaceRelease p_wgpuSurfaceRelease = nullptr;
static bool g_dcompSymbolsLoaded = false;
static HMODULE loadWgpuLibrary();  // forward declaration

static bool ensureDCompSymbols() {
    if (g_dcompSymbolsLoaded) return true;
    HMODULE handle = loadWgpuLibrary();
    if (!handle) return false;
#define LOAD_DCOMP_SYM(name) \
    p_##name = (decltype(p_##name))GetProcAddress(handle, #name); \
    if (!p_##name) { printf("[DComp] missing symbol " #name "\n"); return false; }
    LOAD_DCOMP_SYM(wgpuDeviceHasFeature);
    LOAD_DCOMP_SYM(wgpuDeviceImportSharedFence);
    LOAD_DCOMP_SYM(wgpuDeviceImportSharedTextureMemory);
    LOAD_DCOMP_SYM(wgpuSharedTextureMemoryGetProperties);
    LOAD_DCOMP_SYM(wgpuSharedTextureMemoryCreateTexture);
    LOAD_DCOMP_SYM(wgpuSharedTextureMemoryBeginAccess);
    LOAD_DCOMP_SYM(wgpuSharedTextureMemoryEndAccess);
    LOAD_DCOMP_SYM(wgpuSharedTextureMemoryEndAccessStateFreeMembers);
    LOAD_DCOMP_SYM(wgpuSharedTextureMemoryRelease);
    LOAD_DCOMP_SYM(wgpuSharedFenceExportInfo);
    LOAD_DCOMP_SYM(wgpuSharedFenceRelease);
    LOAD_DCOMP_SYM(wgpuTextureDestroy);
    LOAD_DCOMP_SYM(wgpuTextureGetUsage);
    LOAD_DCOMP_SYM(wgpuTextureAddRef);
    LOAD_DCOMP_SYM(wgpuTextureRelease);
    LOAD_DCOMP_SYM(wgpuSurfaceRelease);
#undef LOAD_DCOMP_SYM
    g_dcompSymbolsLoaded = true;
    // All symbols loaded
    return true;
}

// DirectComposition zero-copy bridge state (per-surface)
struct DCompBridgeState {
    DCompCompositor compositor;
    ComPtr<ID3D12Resource> stagingDx12;
    ComPtr<ID3D11Device5> presentDevice;
    ComPtr<ID3D11DeviceContext4> presentContext;
    ComPtr<ID3D11Texture2D> presentStagingTex;
    ComPtr<ID3D11Fence> presentationFence;
    WGPUSharedFence presentationSharedFence = nullptr;
    uint64_t presentationFenceValue = 0;
    bool presentationFencePending = false;
    HANDLE stagingSharedHandle = nullptr;
    WGPUSharedTextureMemory sharedTexMem = nullptr;
    WGPUTexture zeroCopyTexture = nullptr;
    std::mutex frameMutex;
    bool accessActive = false;
    std::atomic<bool> unusable{false};
    WGPUDevice wgpuDevice = nullptr;
    uint32_t width = 0;
    uint32_t height = 0;

    void cleanup() {
        std::lock_guard<std::mutex> lock(frameMutex);
        if (accessActive && sharedTexMem && zeroCopyTexture &&
            p_wgpuSharedTextureMemoryEndAccess &&
            p_wgpuSharedTextureMemoryEndAccessStateFreeMembers) {
            WGPUSharedTextureMemoryEndAccessState endState =
                WGPU_SHARED_TEXTURE_MEMORY_END_ACCESS_STATE_INIT;
            p_wgpuSharedTextureMemoryEndAccess(sharedTexMem, zeroCopyTexture, &endState);
            p_wgpuSharedTextureMemoryEndAccessStateFreeMembers(endState);
            accessActive = false;
        }

        if (zeroCopyTexture) {
            if (p_wgpuTextureDestroy) p_wgpuTextureDestroy(zeroCopyTexture);
            // Release our internal ref (the one from SharedTextureMemoryCreateTexture)
            if (p_wgpuTextureRelease) p_wgpuTextureRelease(zeroCopyTexture);
            zeroCopyTexture = nullptr;
        }
        if (sharedTexMem) {
            if (p_wgpuSharedTextureMemoryRelease) p_wgpuSharedTextureMemoryRelease(sharedTexMem);
            sharedTexMem = nullptr;
        }
        if (presentationSharedFence) {
            if (p_wgpuSharedFenceRelease) p_wgpuSharedFenceRelease(presentationSharedFence);
            presentationSharedFence = nullptr;
        }
        presentationFence.Reset();
        presentationFencePending = false;
        presentStagingTex.Reset();
        stagingDx12.Reset();
        if (stagingSharedHandle) {
            CloseHandle(stagingSharedHandle);
            stagingSharedHandle = nullptr;
        }
        presentContext.Reset();
        presentDevice.Reset();
        compositor.shutdown();
    }

    ~DCompBridgeState() { cleanup(); }
};

extern "C++" {

static std::shared_ptr<DCompBridgeState> makeDCompBridge() {
    return std::shared_ptr<DCompBridgeState>(
        new DCompBridgeState(),
        [](DCompBridgeState* bridge) {
            MainThreadDispatcher::dispatch_sync([bridge]() { delete bridge; });
        });
}

static void destroyDCompBridgeOnMainThread(std::shared_ptr<DCompBridgeState> bridge) {
    bridge.reset();
}

static void retireDCompBridge(
    void* surface,
    const std::shared_ptr<DCompBridgeState>& expectedBridge) {
    std::shared_ptr<DCompBridgeState> retiredBridge;
    {
        std::lock_guard<std::mutex> lock(g_dcompBridgeMapMutex);
        auto it = g_dcompBridges.find(surface);
        if (it != g_dcompBridges.end() && it->second == expectedBridge) {
            retiredBridge = std::move(it->second);
            g_dcompBridges.erase(it);
        }
    }
    destroyDCompBridgeOnMainThread(std::move(retiredBridge));
}

static bool drainD3D11Context(ID3D11Device* device, ID3D11DeviceContext* context) {
    if (!device || !context) return false;

    D3D11_QUERY_DESC queryDesc = {};
    queryDesc.Query = D3D11_QUERY_EVENT;
    ComPtr<ID3D11Query> eventQuery;
    if (FAILED(device->CreateQuery(&queryDesc, &eventQuery))) return false;

    context->End(eventQuery.Get());
    context->Flush();
    const ULONGLONG deadline = GetTickCount64() + 2000;
    for (;;) {
        BOOL complete = FALSE;
        const HRESULT hr = context->GetData(
            eventQuery.Get(), &complete, sizeof(complete), 0);
        if (hr == S_OK) return complete == TRUE;
        if (hr != S_FALSE || GetTickCount64() >= deadline) return false;
        SwitchToThread();
    }
}

} // extern "C++"

static std::wstring getExecutableDirW() {
    wchar_t buffer[MAX_PATH];
    DWORD len = GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    if (len == 0 || len == MAX_PATH) return L".";
    std::wstring path(buffer, len);
    size_t pos = path.find_last_of(L"\\/");
    if (pos == std::wstring::npos) return L".";
    return path.substr(0, pos);
}

static HMODULE loadWgpuLibrary() {
    if (wgpuLibHandle) return wgpuLibHandle;
    std::wstring execDir = getExecutableDirW();
    std::vector<std::wstring> candidates = {
        execDir + L"\\webgpu_dawn.dll",
        execDir + L"\\libwebgpu_dawn.dll",
        execDir + L"\\..\\Resources\\webgpu_dawn.dll",
        execDir + L"\\..\\Resources\\libwebgpu_dawn.dll",
    };
    for (const auto& path : candidates) {
        wgpuLibHandle = LoadLibraryW(path.c_str());
        if (wgpuLibHandle) break;
    }
    if (!wgpuLibHandle) {
        wgpuLibHandle = LoadLibraryW(L"webgpu_dawn.dll");
        if (!wgpuLibHandle) wgpuLibHandle = LoadLibraryW(L"libwebgpu_dawn.dll");
    }
    if (!wgpuLibHandle) {
        ::log("WGPU: failed to load webgpu_dawn.dll");
    }
    return wgpuLibHandle;
}

static bool ensureWgpuSymbols() {
    if (p_wgpuInstanceCreateSurface && p_wgpuSurfaceConfigure && p_wgpuSurfaceGetCurrentTexture && p_wgpuSurfacePresent
        && p_wgpuQueueOnSubmittedWorkDone && p_wgpuBufferMapAsync && p_wgpuInstanceWaitAny
        && p_wgpuBufferGetMappedRange && p_wgpuBufferUnmap) {
        return true;
    }
    HMODULE handle = loadWgpuLibrary();
    if (!handle) return false;
    p_wgpuInstanceCreateSurface = (PFN_wgpuInstanceCreateSurface)GetProcAddress(handle, "wgpuInstanceCreateSurface");
    p_wgpuSurfaceConfigure = (PFN_wgpuSurfaceConfigure)GetProcAddress(handle, "wgpuSurfaceConfigure");
    p_wgpuSurfaceGetCurrentTexture = (PFN_wgpuSurfaceGetCurrentTexture)GetProcAddress(handle, "wgpuSurfaceGetCurrentTexture");
    p_wgpuSurfacePresent = (PFN_wgpuSurfacePresent)GetProcAddress(handle, "wgpuSurfacePresent");
    p_wgpuQueueOnSubmittedWorkDone = (PFN_wgpuQueueOnSubmittedWorkDone)GetProcAddress(handle, "wgpuQueueOnSubmittedWorkDone");
    p_wgpuBufferMapAsync = (PFN_wgpuBufferMapAsync)GetProcAddress(handle, "wgpuBufferMapAsync");
    p_wgpuInstanceWaitAny = (PFN_wgpuInstanceWaitAny)GetProcAddress(handle, "wgpuInstanceWaitAny");
    p_wgpuBufferGetMappedRange = (PFN_wgpuBufferGetMappedRange)GetProcAddress(handle, "wgpuBufferGetMappedRange");
    p_wgpuBufferGetConstMappedRange = (PFN_wgpuBufferGetConstMappedRange)GetProcAddress(handle, "wgpuBufferGetConstMappedRange");
    p_wgpuBufferUnmap = (PFN_wgpuBufferUnmap)GetProcAddress(handle, "wgpuBufferUnmap");
    if (!p_wgpuInstanceCreateSurface || !p_wgpuSurfaceConfigure || !p_wgpuSurfaceGetCurrentTexture || !p_wgpuSurfacePresent
        || !p_wgpuQueueOnSubmittedWorkDone || !p_wgpuBufferMapAsync || !p_wgpuInstanceWaitAny
        || !p_wgpuBufferGetMappedRange || !p_wgpuBufferUnmap) {
        ::log("WGPU: missing symbols");
        return false;
    }
    return true;
}

static bool ensureWgpuTestSymbols() {
    if (!ensureWgpuSymbols()) return false;
    HMODULE handle = loadWgpuLibrary();
    if (!handle) return false;
#define LOAD_TEST_SYM(name) \
    p_##name = (decltype(p_##name))GetProcAddress(handle, #name); \
    if (!p_##name) { \
        wgpu_log("WGPU test: missing symbol " #name); \
        return false; \
    }
    LOAD_TEST_SYM(wgpuCreateInstance);
    LOAD_TEST_SYM(wgpuInstanceRequestAdapter);
    LOAD_TEST_SYM(wgpuAdapterRequestDevice);
    LOAD_TEST_SYM(wgpuAdapterHasFeature);
    LOAD_TEST_SYM(wgpuDeviceGetQueue);
    LOAD_TEST_SYM(wgpuSurfaceGetCapabilities);
    LOAD_TEST_SYM(wgpuSurfaceCapabilitiesFreeMembers);
    LOAD_TEST_SYM(wgpuDeviceCreateShaderModule);
    LOAD_TEST_SYM(wgpuDeviceCreateRenderPipeline);
    LOAD_TEST_SYM(wgpuDeviceSetLabel);
    LOAD_TEST_SYM(wgpuDeviceCreateBuffer);
    LOAD_TEST_SYM(wgpuQueueWriteBuffer);
    LOAD_TEST_SYM(wgpuDeviceCreateCommandEncoder);
    LOAD_TEST_SYM(wgpuCommandEncoderBeginRenderPass);
    LOAD_TEST_SYM(wgpuRenderPassEncoderSetPipeline);
    LOAD_TEST_SYM(wgpuRenderPassEncoderSetVertexBuffer);
    LOAD_TEST_SYM(wgpuRenderPassEncoderDraw);
    LOAD_TEST_SYM(wgpuRenderPassEncoderEnd);
    LOAD_TEST_SYM(wgpuCommandEncoderFinish);
    LOAD_TEST_SYM(wgpuQueueSubmit);
    LOAD_TEST_SYM(wgpuTextureCreateView);
    LOAD_TEST_SYM(wgpuTextureViewRelease);
    LOAD_TEST_SYM(wgpuTextureRelease);
    LOAD_TEST_SYM(wgpuCommandBufferRelease);
    LOAD_TEST_SYM(wgpuCommandEncoderRelease);
#undef LOAD_TEST_SYM
    wgpu_log("WGPU test: all 24 test symbols loaded successfully");
    return true;
}

ELECTROBUN_EXPORT void wgpuSurfaceCapabilitiesFreeMembersShim(void* capabilitiesPtr) {
    if (!capabilitiesPtr || !ensureWgpuTestSymbols()) return;
    WGPUSurfaceCapabilities* capabilities = (WGPUSurfaceCapabilities*)capabilitiesPtr;
    p_wgpuSurfaceCapabilitiesFreeMembers(*capabilities);
    *capabilities = {};
}

// ---- GPU Test State and Rendering ----

struct GPUTestState {
    WGPUInstance instance = nullptr;
    WGPUSurface surface = nullptr;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    WGPURenderPipeline pipelineA = nullptr;
    WGPURenderPipeline pipelineB = nullptr;
    WGPUBuffer vertexBuffer = nullptr;
    WGPUTextureFormat surfaceFormat = WGPUTextureFormat_BGRA8UnormSrgb;
    WGPUCompositeAlphaMode alphaMode = WGPUCompositeAlphaMode_Opaque;
    HWND hwnd = NULL;
    UINT_PTR timerId = 0;
    float angle = 0.0f;
    uint32_t lastWidth = 0;
    uint32_t lastHeight = 0;
    bool useAlt = false;
    bool running = false;
};

static GPUTestState g_gpuTest;

static const float kCubeVertices[] = {
    // front
    -0.5f,-0.5f, 0.5f,  0.5f,-0.5f, 0.5f,  0.5f, 0.5f, 0.5f,
    -0.5f,-0.5f, 0.5f,  0.5f, 0.5f, 0.5f, -0.5f, 0.5f, 0.5f,
    // back
    -0.5f,-0.5f,-0.5f, -0.5f, 0.5f,-0.5f,  0.5f, 0.5f,-0.5f,
    -0.5f,-0.5f,-0.5f,  0.5f, 0.5f,-0.5f,  0.5f,-0.5f,-0.5f,
    // left
    -0.5f,-0.5f,-0.5f, -0.5f,-0.5f, 0.5f, -0.5f, 0.5f, 0.5f,
    -0.5f,-0.5f,-0.5f, -0.5f, 0.5f, 0.5f, -0.5f, 0.5f,-0.5f,
    // right
     0.5f,-0.5f,-0.5f,  0.5f, 0.5f,-0.5f,  0.5f, 0.5f, 0.5f,
     0.5f,-0.5f,-0.5f,  0.5f, 0.5f, 0.5f,  0.5f,-0.5f, 0.5f,
    // top
    -0.5f, 0.5f,-0.5f, -0.5f, 0.5f, 0.5f,  0.5f, 0.5f, 0.5f,
    -0.5f, 0.5f,-0.5f,  0.5f, 0.5f, 0.5f,  0.5f, 0.5f,-0.5f,
    // bottom
    -0.5f,-0.5f,-0.5f,  0.5f,-0.5f,-0.5f,  0.5f,-0.5f, 0.5f,
    -0.5f,-0.5f,-0.5f,  0.5f,-0.5f, 0.5f, -0.5f,-0.5f, 0.5f,
};

static constexpr size_t kCubeFloatCount = sizeof(kCubeVertices) / sizeof(float);
static constexpr size_t kCubeVertexCount = kCubeFloatCount / 3;
static constexpr size_t kGpuTestStrideFloats = 7;

static void buildRotatedVertices(float angle, float* out, size_t count) {
    const float sinY = sinf(angle);
    const float cosY = cosf(angle);
    const float sinX = sinf(angle * 0.7f);
    const float cosX = cosf(angle * 0.7f);
    for (size_t i = 0; i < count; i += 3) {
        float x = kCubeVertices[i];
        float y = kCubeVertices[i + 1];
        float z = kCubeVertices[i + 2];
        float x1 = x * cosY + z * sinY;
        float z1 = -x * sinY + z * cosY;
        float y1 = y * cosX - z1 * sinX;
        float z2 = y * sinX + z1 * cosX;
        float depth = z2 + 2.5f;
        float proj = 1.2f / depth;
        out[i] = x1 * proj;
        out[i + 1] = y1 * proj;
        out[i + 2] = 0.0f;
    }
}

static float clamp01f(float value) {
    if (value < 0.0f) return 0.0f;
    if (value > 1.0f) return 1.0f;
    return value;
}

static void gpuTestGetMouseState(GPUTestState* state, float* outX, float* outY, float* outDown) {
    if (outX) *outX = 0.5f;
    if (outY) *outY = 0.5f;
    if (outDown) *outDown = 0.0f;
    if (!state || !state->hwnd || !IsWindow(state->hwnd)) return;

    RECT rc;
    if (!GetClientRect(state->hwnd, &rc)) return;
    const int width = std::max(1L, rc.right - rc.left);
    const int height = std::max(1L, rc.bottom - rc.top);

    POINT point;
    if (GetCursorPos(&point) && ScreenToClient(state->hwnd, &point)) {
        if (outX) *outX = clamp01f((float)point.x / (float)width);
        if (outY) *outY = clamp01f((float)point.y / (float)height);
    }
    if (outDown) *outDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) ? 1.0f : 0.0f;
}

static void buildInterleavedVertices(
    float angle,
    float mouseX,
    float mouseY,
    float mouseDown,
    float timeValue,
    float* out
) {
    float positions[kCubeFloatCount];
    buildRotatedVertices(angle, positions, kCubeFloatCount);
    for (size_t vertexIndex = 0; vertexIndex < kCubeVertexCount; vertexIndex++) {
        const size_t positionIndex = vertexIndex * 3;
        const size_t outputIndex = vertexIndex * kGpuTestStrideFloats;
        out[outputIndex] = positions[positionIndex];
        out[outputIndex + 1] = positions[positionIndex + 1];
        out[outputIndex + 2] = positions[positionIndex + 2];
        out[outputIndex + 3] = mouseX;
        out[outputIndex + 4] = mouseY;
        out[outputIndex + 5] = mouseDown;
        out[outputIndex + 6] = timeValue;
    }
}

static void gpuTestConfigureSurface(GPUTestState* state) {
    if (!state->surface || !state->device || !state->hwnd) return;

    WGPUSurfaceCapabilities caps = {};
    p_wgpuSurfaceGetCapabilities(state->surface, state->adapter, &caps);
    if (caps.formatCount > 0 && caps.formats) {
        state->surfaceFormat = caps.formats[0];
        wgpu_log("WGPU test: surface format = %d (from %zu available)", (int)state->surfaceFormat, caps.formatCount);
    }
    if (caps.alphaModeCount > 0 && caps.alphaModes) {
        state->alphaMode = caps.alphaModes[0];
    }
    p_wgpuSurfaceCapabilitiesFreeMembers(caps);

    RECT rc;
    GetClientRect(state->hwnd, &rc);
    uint32_t w = (uint32_t)(rc.right - rc.left);
    uint32_t h = (uint32_t)(rc.bottom - rc.top);
    if (w == 0) w = 1;
    if (h == 0) h = 1;
    state->lastWidth = w;
    state->lastHeight = h;

    WGPUSurfaceConfiguration config = {};
    config.device = state->device;
    config.format = state->surfaceFormat;
    config.usage = WGPUTextureUsage_RenderAttachment;
    config.width = w;
    config.height = h;
    config.presentMode = WGPUPresentMode_Fifo;
    config.alphaMode = state->alphaMode;
    p_wgpuSurfaceConfigure(state->surface, &config);
    wgpu_log("WGPU test: surface configured %ux%u", w, h);
}

static WGPURenderPipeline gpuTestCreatePipeline(GPUTestState* state, const char* shaderSrc) {
    if (!state->device) return nullptr;
    WGPUShaderSourceWGSL wgsl = {};
    wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgsl.code.data = shaderSrc;
    wgsl.code.length = WGPU_STRLEN;

    WGPUShaderModuleDescriptor shaderDesc = {};
    shaderDesc.nextInChain = reinterpret_cast<WGPUChainedStruct*>(&wgsl);

    WGPUShaderModule shader = p_wgpuDeviceCreateShaderModule(state->device, &shaderDesc);
    if (!shader) {
        wgpu_log("WGPU test: FAILED to create shader module");
        return nullptr;
    }
    wgpu_log("WGPU test: shader module created");

    WGPUStringView vsEntry = { "vs_main", WGPU_STRLEN };
    WGPUStringView fsEntry = { "fs_main", WGPU_STRLEN };

    WGPUVertexAttribute attrs[2] = {};
    attrs[0].format = WGPUVertexFormat_Float32x3;
    attrs[0].offset = 0;
    attrs[0].shaderLocation = 0;
    attrs[1].format = WGPUVertexFormat_Float32x4;
    attrs[1].offset = sizeof(float) * 3;
    attrs[1].shaderLocation = 1;

    WGPUVertexBufferLayout vbuf = {};
    vbuf.arrayStride = sizeof(float) * kGpuTestStrideFloats;
    vbuf.attributeCount = 2;
    vbuf.attributes = attrs;
    vbuf.stepMode = WGPUVertexStepMode_Vertex;

    WGPUVertexState vstate = {};
    vstate.module = shader;
    vstate.entryPoint = vsEntry;
    vstate.bufferCount = 1;
    vstate.buffers = &vbuf;

    WGPUColorTargetState colorTarget = {};
    colorTarget.format = state->surfaceFormat;
    colorTarget.writeMask = WGPUColorWriteMask_All;

    WGPUFragmentState fstate = {};
    fstate.module = shader;
    fstate.entryPoint = fsEntry;
    fstate.targetCount = 1;
    fstate.targets = &colorTarget;

    WGPUPrimitiveState prim = {};
    prim.topology = WGPUPrimitiveTopology_TriangleList;
    prim.stripIndexFormat = WGPUIndexFormat_Undefined;
    prim.frontFace = WGPUFrontFace_CCW;
    prim.cullMode = WGPUCullMode_None;
    prim.unclippedDepth = false;

    WGPUMultisampleState ms = {};
    ms.count = 1;
    ms.mask = 0xFFFFFFFF;
    ms.alphaToCoverageEnabled = false;

    WGPURenderPipelineDescriptor rpDesc = {};
    rpDesc.vertex = vstate;
    rpDesc.primitive = prim;
    rpDesc.multisample = ms;
    rpDesc.fragment = &fstate;

    WGPURenderPipeline pipeline = p_wgpuDeviceCreateRenderPipeline(state->device, &rpDesc);
    if (!pipeline) {
        wgpu_log("WGPU test: FAILED to create render pipeline");
        return nullptr;
    }
    wgpu_log("WGPU test: render pipeline created");
    return pipeline;
}

static void gpuTestSetupPipeline(GPUTestState* state) {
    if (!state->device) return;
    const char* shaderSrcA = R"WGSL(
struct VSOut {
  @builtin(position) position : vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VSOut {
  var out: VSOut;
  out.position = vec4<f32>(position, 1.0);
  return out;
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.1, 0.9, 0.4, 1.0);
}
)WGSL";

    const char* shaderSrcB = R"WGSL(
struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) local_pos : vec3<f32>,
  @location(1) mouse_state : vec4<f32>,
};

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) mouse_state: vec4<f32>
) -> VSOut {
  var out: VSOut;
  out.position = vec4<f32>(position, 1.0);
  out.local_pos = position;
  out.mouse_state = mouse_state;
  return out;
}

@fragment
fn fs_main(
  @location(0) local_pos: vec3<f32>,
  @location(1) mouse_state: vec4<f32>
) -> @location(0) vec4<f32> {
  let cursor = vec2<f32>(mouse_state.x * 2.0 - 1.0, (1.0 - mouse_state.y) * 2.0 - 1.0);
  let dist = distance(local_pos.xy, cursor);
  let wave = 0.5 + 0.5 * sin(mouse_state.w * 3.0 - dist * 14.0);
  let pulse = select(wave, 1.0 - wave, mouse_state.z > 0.5);
  let base = vec3<f32>(0.25 + cursor.x * 0.35, 0.35 + cursor.y * 0.25, 0.75);
  let highlight = vec3<f32>(1.0, 0.45, 0.15);
  let color = max(mix(base, highlight, pulse), vec3<f32>(0.05));
  let alpha = 0.7 + 0.3 * pulse;
  return vec4<f32>(color, alpha);
}
)WGSL";

    state->pipelineA = gpuTestCreatePipeline(state, shaderSrcA);
    state->pipelineB = gpuTestCreatePipeline(state, shaderSrcB);

    WGPUBufferDescriptor bufDesc = {};
    bufDesc.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
    bufDesc.size = kCubeVertexCount * kGpuTestStrideFloats * sizeof(float);
    bufDesc.mappedAtCreation = false;
    state->vertexBuffer = p_wgpuDeviceCreateBuffer(state->device, &bufDesc);
    if (!state->vertexBuffer) {
        wgpu_log("WGPU test: FAILED to create vertex buffer");
        return;
    }
    wgpu_log(
        "WGPU test: vertex buffer created (%zu bytes)",
        (size_t)(kCubeVertexCount * kGpuTestStrideFloats * sizeof(float))
    );

    float initialVerts[kCubeVertexCount * kGpuTestStrideFloats];
    buildInterleavedVertices(0.0f, 0.5f, 0.5f, 0.0f, 0.0f, initialVerts);
    p_wgpuQueueWriteBuffer(state->queue, state->vertexBuffer, 0, initialVerts, sizeof(initialVerts));
    wgpu_log("WGPU test: pipeline setup complete");
}

static void gpuTestRenderFrame(GPUTestState* state) {
    if (!state->device || !state->surface || !state->queue) return;
    if (!state->hwnd || !IsWindow(state->hwnd)) return;
    WGPURenderPipeline pipeline = state->useAlt && state->pipelineB ? state->pipelineB : state->pipelineA;
    if (!pipeline) return;

    RECT rc;
    GetClientRect(state->hwnd, &rc);
    uint32_t w = (uint32_t)(rc.right - rc.left);
    uint32_t h = (uint32_t)(rc.bottom - rc.top);
    if (w <= 1 || h <= 1) return;
    if (w != state->lastWidth || h != state->lastHeight) {
        wgpu_log("WGPU test: resize detected %ux%u -> %ux%u", state->lastWidth, state->lastHeight, w, h);
        gpuTestConfigureSurface(state);
    }

    state->angle += 0.02f;
    float mouseX = 0.5f;
    float mouseY = 0.5f;
    float mouseDown = 0.0f;
    gpuTestGetMouseState(state, &mouseX, &mouseY, &mouseDown);
    float verts[kCubeVertexCount * kGpuTestStrideFloats];
    buildInterleavedVertices(state->angle, mouseX, mouseY, mouseDown, state->angle * 1.5f, verts);
    p_wgpuQueueWriteBuffer(state->queue, state->vertexBuffer, 0, verts, sizeof(verts));

    WGPUSurfaceTexture surfaceTexture = {};
    p_wgpuSurfaceGetCurrentTexture(state->surface, &surfaceTexture);
    if (surfaceTexture.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
        surfaceTexture.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
        static int errorCount = 0;
        if (errorCount++ < 5) {
            wgpu_log("WGPU test: surface texture status = %d (not optimal/suboptimal)", (int)surfaceTexture.status);
        }
        return;
    }
    if (!surfaceTexture.texture) return;

    WGPUTextureView view = p_wgpuTextureCreateView(surfaceTexture.texture, nullptr);

    WGPURenderPassColorAttachment colorAtt = {};
    colorAtt.view = view;
    colorAtt.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    colorAtt.loadOp = WGPULoadOp_Clear;
    colorAtt.storeOp = WGPUStoreOp_Store;
    colorAtt.clearValue = {0.05, 0.05, 0.1, 1.0};

    WGPURenderPassDescriptor passDesc = {};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &colorAtt;

    WGPUCommandEncoder encoder = p_wgpuDeviceCreateCommandEncoder(state->device, nullptr);
    WGPURenderPassEncoder pass = p_wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
    p_wgpuRenderPassEncoderSetPipeline(pass, pipeline);
    p_wgpuRenderPassEncoderSetVertexBuffer(
        pass,
        0,
        state->vertexBuffer,
        0,
        kCubeVertexCount * kGpuTestStrideFloats * sizeof(float)
    );
    p_wgpuRenderPassEncoderDraw(pass, (uint32_t)kCubeVertexCount, 1, 0, 0);
    p_wgpuRenderPassEncoderEnd(pass);

    WGPUCommandBuffer cmd = p_wgpuCommandEncoderFinish(encoder, nullptr);
    p_wgpuQueueSubmit(state->queue, 1, &cmd);
    p_wgpuSurfacePresent(state->surface);

    p_wgpuTextureViewRelease(view);
    p_wgpuTextureRelease(surfaceTexture.texture);
    p_wgpuCommandBufferRelease(cmd);
    p_wgpuCommandEncoderRelease(encoder);

    static bool loggedFirstFrame = false;
    if (!loggedFirstFrame) {
        wgpu_log("WGPU test: first frame rendered successfully!");
        loggedFirstFrame = true;
    }
}

static void logWgpuStringView(const char* prefix, WGPUStringView sv) {
    if (!sv.data) {
        wgpu_log("%s (null)", prefix);
        return;
    }
    size_t len = sv.length == WGPU_STRLEN ? strlen(sv.data) : (size_t)sv.length;
    std::string msg(sv.data, sv.data + len);
    wgpu_log("%s %s", prefix, msg.c_str());
}

static void gpuTestUncapturedErrorCallback(WGPUDevice const* device, WGPUErrorType type, WGPUStringView message, void* userdata1, void* userdata2) {
    (void)device;
    (void)userdata1;
    (void)userdata2;
    char buf[128];
    snprintf(buf, sizeof(buf), "WGPU uncaptured error type=%d:", (int)type);
    logWgpuStringView(buf, message);
}

static void CALLBACK gpuTestTimerProc(HWND hwnd, UINT msg, UINT_PTR id, DWORD time) {
    (void)hwnd; (void)msg; (void)id; (void)time;
    gpuTestRenderFrame(&g_gpuTest);
}

static void gpuTestRequestDeviceCallback(WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView message, void* userdata1, void* userdata2);

static void gpuTestRequestAdapterCallback(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView message, void* userdata1, void* userdata2) {
    if (status != WGPURequestAdapterStatus_Success) {
        logWgpuStringView("WGPU test: adapter error:", message);
    }
    (void)userdata2;
    GPUTestState* state = (GPUTestState*)userdata1;
    if (!state || status != WGPURequestAdapterStatus_Success || !adapter) {
        wgpu_log("WGPU test: adapter request FAILED (status=%d)", (int)status);
        return;
    }
    wgpu_log("WGPU test: adapter acquired");
    state->adapter = adapter;

    WGPURequestDeviceCallbackInfo cbInfo = {};
    cbInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    cbInfo.callback = gpuTestRequestDeviceCallback;
    cbInfo.userdata1 = state;
    WGPUDeviceDescriptor deviceDesc = {};
    deviceDesc.uncapturedErrorCallbackInfo.callback = gpuTestUncapturedErrorCallback;
    deviceDesc.uncapturedErrorCallbackInfo.userdata1 = state;
    p_wgpuAdapterRequestDevice(adapter, &deviceDesc, cbInfo);
}

static void gpuTestRequestDeviceCallback(WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView message, void* userdata1, void* userdata2) {
    if (status != WGPURequestDeviceStatus_Success) {
        logWgpuStringView("WGPU test: device error:", message);
    }
    (void)userdata2;
    GPUTestState* state = (GPUTestState*)userdata1;
    if (!state || status != WGPURequestDeviceStatus_Success || !device) {
        wgpu_log("WGPU test: device request FAILED (status=%d)", (int)status);
        return;
    }
    wgpu_log("WGPU test: device acquired");
    state->device = device;

    if (p_wgpuDeviceSetLabel) {
        WGPUStringView label = { "Electrobun WGPU Device", WGPU_STRLEN };
        p_wgpuDeviceSetLabel(device, label);
    }
    state->queue = p_wgpuDeviceGetQueue(device);
    wgpu_log("WGPU test: queue acquired, configuring surface...");

    gpuTestConfigureSurface(state);
    gpuTestSetupPipeline(state);

    // Start render loop using Windows timer (16ms ~ 60fps)
    if (state->timerId) {
        KillTimer(NULL, state->timerId);
        state->timerId = 0;
    }
    state->timerId = SetTimer(NULL, 0, 16, gpuTestTimerProc);
    if (state->timerId) {
        state->running = true;
        wgpu_log("WGPU test: render timer started (id=%llu, 16ms interval)", (unsigned long long)state->timerId);
    } else {
        wgpu_log("WGPU test: FAILED to create render timer, error=%lu", GetLastError());
    }
}

static void* runOnMainThreadSyncPtr(std::function<void*()> fn) {
    return MainThreadDispatcher::dispatch_sync([&]() -> void* { return fn(); });
}

static void runOnMainThreadSyncVoid(std::function<void()> fn) {
    MainThreadDispatcher::dispatch_sync([&]() { fn(); });
}

ELECTROBUN_EXPORT void* wgpuInstanceCreateSurfaceMainThread(void* instance, void* descriptor) {
    if (!ensureWgpuSymbols()) return nullptr;
    return runOnMainThreadSyncPtr([&]() -> void* {
        return p_wgpuInstanceCreateSurface(instance, descriptor);
    });
}

// Surface-to-HWND mapping for DComp bridge initialization
static std::map<void*, HWND> g_surfaceToHwnd;
static std::mutex g_surfaceToHwndMutex;

ELECTROBUN_EXPORT void* wgpuCreateSurfaceForView(void* wgpuInstance, AbstractView* abstractView) {
    if (!wgpuInstance || !abstractView || !abstractView->hwnd) {
        printf("[WGPU] createSurfaceForView: null check failed (inst=%p view=%p hwnd=%p)\n",
               wgpuInstance, abstractView, abstractView ? abstractView->hwnd : nullptr);
        return nullptr;
    }
    if (!ensureWgpuSymbols()) return nullptr;

    HWND hwnd = abstractView->hwnd;
    printf("[WGPU] createSurfaceForView: creating surface for HWND=%p\n", hwnd);
    void* result = runOnMainThreadSyncPtr([&]() -> void* {
        WGPUSurfaceSourceWindowsHWND hwndSource = {};
        hwndSource.chain.sType = WGPUSType_SurfaceSourceWindowsHWND;
        hwndSource.hinstance = (void*)GetModuleHandle(NULL);
        hwndSource.hwnd = (void*)hwnd;

        WGPUSurfaceDescriptor surfaceDesc = {};
        surfaceDesc.nextInChain = reinterpret_cast<WGPUChainedStruct*>(&hwndSource);
        return p_wgpuInstanceCreateSurface(wgpuInstance, &surfaceDesc);
    });
    printf("[WGPU] createSurfaceForView: surface=%p\n", result);

    // Store surface → HWND mapping for DComp bridge initialization
    if (result) {
        std::lock_guard<std::mutex> lock(g_surfaceToHwndMutex);
        g_surfaceToHwnd[result] = hwnd;
    }

    return result;
}

// Helper: Initialize DComp zero-copy bridge for a surface.
// Returns true on success, false if DComp is unavailable or init fails.
static bool initDCompBridgeForSurface(void* surface, void* devicePtr, uint32_t width, uint32_t height) {
    if (!isDCompAvailable()) return false;
    if (!ensureDCompSymbols()) return false;

    WGPUDevice device = (WGPUDevice)devicePtr;

    // Look up the HWND this surface was created for
    HWND hwnd = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_surfaceToHwndMutex);
        auto it = g_surfaceToHwnd.find(surface);
        if (it != g_surfaceToHwnd.end()) hwnd = it->second;
    }
    if (!hwnd) {
        printf("[DComp] No HWND mapping for surface=%p, skipping DComp bridge\n", surface);
        return false;
    }

    // Use the view's own HWND for the DComp target — not the top-level window.
    // Each WGPU view is a child window positioned within its parent.
    // Targeting the child HWND ensures content renders at (0,0) of the view,
    // which the window manager already positions correctly.
    HWND targetHwnd = hwnd;

    // Require DXGI shared handle feature for cross-device sharing
    bool hasDXGISharedHandle = p_wgpuDeviceHasFeature(device, WGPUFeatureName_SharedTextureMemoryDXGISharedHandle);
    bool hasSharedFence = p_wgpuDeviceHasFeature(device, WGPUFeatureName_SharedFenceDXGISharedHandle);
    // Feature detection done

    if (!hasDXGISharedHandle || !hasSharedFence) {
        printf("[DComp] Zero-copy bridge requires DXGI shared texture and fence support\n");
        return false;
    }

    auto bridge = makeDCompBridge();
    bridge->wgpuDevice = device;
    bridge->width = width;
    bridge->height = height;

    // Step 1: Init DComp compositor (visual tree) on main thread
    bool compOk = false;
    MainThreadDispatcher::dispatch_sync([&]() {
        compOk = bridge->compositor.initMinimal(targetHwnd, width, height);
    });
    if (!compOk) {
        printf("[DComp] initMinimal failed for HWND=%p\n", targetHwnd);
        return false;
    }

    // Step 2: Get Dawn's DX12 device to find the DXGI adapter
    auto dx12Device = dawn::native::d3d12::GetD3D12Device(device);
    if (!dx12Device) {
        printf("[DComp] GetD3D12Device failed\n");
        return false;
    }

    // Step 3: Create dedicated presentation D3D11 device on Dawn's adapter
    LUID adapterLuid = dx12Device->GetAdapterLuid();
    ComPtr<IDXGIFactory4> dxgiFactory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&dxgiFactory));
    if (FAILED(hr)) {
        printf("[DComp] CreateDXGIFactory1 failed: 0x%08lx\n", hr);
        return false;
    }
    ComPtr<IDXGIAdapter> adapter;
    hr = dxgiFactory->EnumAdapterByLuid(adapterLuid, IID_PPV_ARGS(&adapter));
    if (FAILED(hr)) {
        printf("[DComp] EnumAdapterByLuid failed: 0x%08lx\n", hr);
        return false;
    }

    ComPtr<ID3D11Device> baseDevice;
    D3D_FEATURE_LEVEL featureLevel;
    hr = D3D11CreateDevice(
        adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        nullptr, 0, D3D11_SDK_VERSION,
        &baseDevice, &featureLevel, nullptr);
    if (FAILED(hr)) {
        printf("[DComp] Presentation D3D11CreateDevice failed: 0x%08lx\n", hr);
        return false;
    }

    hr = baseDevice.As(&bridge->presentDevice);
    if (FAILED(hr)) {
        printf("[DComp] Presentation device QI for ID3D11Device5 failed: 0x%08lx\n", hr);
        return false;
    }

    ComPtr<ID3D11DeviceContext> baseCtx;
    bridge->presentDevice->GetImmediateContext(&baseCtx);
    hr = baseCtx.As(&bridge->presentContext);
    if (FAILED(hr)) {
        printf("[DComp] Presentation context QI for ID3D11DeviceContext4 failed: 0x%08lx\n", hr);
        return false;
    }

    // Presentation device ready

    // Step 4: Create swap chain on the presentation device
    bool swapChainOk = false;
    MainThreadDispatcher::dispatch_sync([&]() {
        swapChainOk = bridge->compositor.initSwapChainFromDevice(baseDevice.Get(), width, height);
    });
    if (!swapChainOk) {
        printf("[DComp] initSwapChainFromDevice on presentation device failed\n");
        return false;
    }

    // Step 5: Create DX12 staging texture with shared access
    D3D12_RESOURCE_DESC texDesc = {};
    texDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    texDesc.Width = width;
    texDesc.Height = height;
    texDesc.DepthOrArraySize = 1;
    texDesc.MipLevels = 1;
    texDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    texDesc.SampleDesc.Count = 1;
    texDesc.Flags = D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS | D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET;

    D3D12_HEAP_PROPERTIES heapProps = {};
    heapProps.Type = D3D12_HEAP_TYPE_DEFAULT;

    hr = dx12Device->CreateCommittedResource(
        &heapProps, D3D12_HEAP_FLAG_SHARED,
        &texDesc, D3D12_RESOURCE_STATE_COMMON,
        nullptr, IID_PPV_ARGS(&bridge->stagingDx12));
    if (FAILED(hr)) {
        printf("[DComp] CreateCommittedResource (staging) failed: 0x%08lx\n", hr);
        return false;
    }

    // Step 6: Create DXGI shared handle
    hr = dx12Device->CreateSharedHandle(
        bridge->stagingDx12.Get(), nullptr,
        GENERIC_ALL, nullptr, &bridge->stagingSharedHandle);
    if (FAILED(hr)) {
        printf("[DComp] CreateSharedHandle failed: 0x%08lx\n", hr);
        return false;
    }

    // Step 7: Set up bidirectional cross-device synchronization. EndAccess
    // gives the presentation queue a Dawn fence to wait on. A separate shared
    // D3D11 fence is signaled after CopyResource and passed to the next
    // BeginAccess so Dawn cannot overwrite the texture while it is being read.
    hr = bridge->presentDevice->CreateFence(
        0, D3D11_FENCE_FLAG_SHARED, IID_PPV_ARGS(&bridge->presentationFence));

    HANDLE presentationFenceHandle = nullptr;
    if (SUCCEEDED(hr)) {
        hr = bridge->presentationFence->CreateSharedHandle(
            nullptr, GENERIC_ALL, nullptr, &presentationFenceHandle);
    }

    if (SUCCEEDED(hr) && presentationFenceHandle) {
        WGPUSharedFenceDXGISharedHandleDescriptor dxgiFenceDesc =
            WGPU_SHARED_FENCE_DXGI_SHARED_HANDLE_DESCRIPTOR_INIT;
        dxgiFenceDesc.handle = presentationFenceHandle;

        WGPUSharedFenceDescriptor fenceDesc = WGPU_SHARED_FENCE_DESCRIPTOR_INIT;
        fenceDesc.nextInChain =
            reinterpret_cast<WGPUChainedStruct*>(&dxgiFenceDesc);
        bridge->presentationSharedFence =
            p_wgpuDeviceImportSharedFence(device, &fenceDesc);
    }

    // Dawn duplicates imported DXGI handles, so this process retains no
    // ownership after the import call returns.
    if (presentationFenceHandle) CloseHandle(presentationFenceHandle);

    if (FAILED(hr) || !bridge->presentationSharedFence) {
        printf("[DComp] Shared presentation fence setup failed; using normal HWND surface\n");
        return false;
    }

    // Step 8: Open shared handle on presentation device for CopyResource
    {
        ComPtr<ID3D11Device1> dev1;
        bridge->presentDevice.As(&dev1);
        hr = dev1->OpenSharedResource1(
            bridge->stagingSharedHandle, IID_PPV_ARGS(&bridge->presentStagingTex));
    }
    if (FAILED(hr)) {
        printf("[DComp] OpenSharedResource1 on presentation device failed: 0x%08lx\n", hr);
        return false;
    }
    // Staging texture shared to presentation device

    // Step 9: Import into Dawn via SharedTextureMemory
    WGPUSharedTextureMemoryDXGISharedHandleDescriptor dxgiDesc =
        WGPU_SHARED_TEXTURE_MEMORY_DXGI_SHARED_HANDLE_DESCRIPTOR_INIT;
    dxgiDesc.handle = bridge->stagingSharedHandle;
    dxgiDesc.useKeyedMutex = false;

    WGPUSharedTextureMemoryDescriptor memDesc = WGPU_SHARED_TEXTURE_MEMORY_DESCRIPTOR_INIT;
    memDesc.nextInChain = reinterpret_cast<WGPUChainedStruct*>(&dxgiDesc);
    bridge->sharedTexMem = p_wgpuDeviceImportSharedTextureMemory(device, &memDesc);

    if (!bridge->sharedTexMem) {
        printf("[DComp] wgpuDeviceImportSharedTextureMemory returned null\n");
        return false;
    }

    // Verify properties
    WGPUSharedTextureMemoryProperties props = {};
    WGPUStatus propStatus = p_wgpuSharedTextureMemoryGetProperties(bridge->sharedTexMem, &props);
    if (propStatus != WGPUStatus_Success) {
        printf("[DComp] SharedTextureMemory properties failed (status=%d)\n", propStatus);
        return false;
    }
    // SharedTextureMemory imported successfully

    // Step 10: Create WGPUTexture from SharedTextureMemory
    WGPUTextureUsage requestedUsage = (WGPUTextureUsage)(
        WGPUTextureUsage_CopyDst | WGPUTextureUsage_RenderAttachment);
    requestedUsage = (WGPUTextureUsage)(requestedUsage & props.usage);

    WGPUTextureDescriptor wgpuTexDesc = {};
    wgpuTexDesc.usage = requestedUsage;
    wgpuTexDesc.dimension = WGPUTextureDimension_2D;
    wgpuTexDesc.size = { width, height, 1 };
    wgpuTexDesc.format = WGPUTextureFormat_BGRA8Unorm;
    wgpuTexDesc.mipLevelCount = 1;
    wgpuTexDesc.sampleCount = 1;

    bridge->zeroCopyTexture = p_wgpuSharedTextureMemoryCreateTexture(bridge->sharedTexMem, &wgpuTexDesc);
    if (!bridge->zeroCopyTexture) {
        printf("[DComp] wgpuSharedTextureMemoryCreateTexture returned null\n");
        return false;
    }

    // Install the HWND subclass only after every fallible initialization step
    // has succeeded. A partial bridge can then be destroyed without leaving a
    // callback/property that points at freed state.
    MainThreadDispatcher::dispatch_sync([&]() {
        bridge->compositor.enableNativeResize();
    });

    // Zero-copy bridge initialized

    // Store the bridge
    {
        std::lock_guard<std::mutex> lock(g_dcompBridgeMapMutex);
        g_dcompBridges[surface] = std::move(bridge);
    }

    return true;
}

ELECTROBUN_EXPORT void wgpuSurfaceConfigureMainThread(void* surface, void* config) {
    if (!ensureWgpuSymbols()) return;
    runOnMainThreadSyncVoid([&]() { p_wgpuSurfaceConfigure(surface, config); });

    // Initialize or resize DComp zero-copy bridge for this surface.
    // WGPUSurfaceConfiguration struct layout (64-bit):
    //   nextInChain(ptr,8) + device(ptr,8) + format(u32,4) + pad(4) + usage(u64,8) +
    //   width(u32,4) + height(u32,4) + viewFormatCount(size_t,8) + viewFormats(ptr,8) +
    //   alphaMode(u32,4) + presentMode(u32,4)
    // device at offset 8, width at offset 32, height at offset 36
    void* devicePtr = *((void**)((uint8_t*)config + 8));
    uint32_t width = *((uint32_t*)((uint8_t*)config + 32));
    uint32_t height = *((uint32_t*)((uint8_t*)config + 36));

    if (!devicePtr || width == 0 || height == 0) return;

    // The bridge owns fixed-size D3D11/D3D12 textures. Reuse it only when
    // both the dimensions and Dawn device are unchanged.
    std::shared_ptr<DCompBridgeState> staleBridge;
    {
        std::lock_guard<std::mutex> lock(g_dcompBridgeMapMutex);
        auto it = g_dcompBridges.find(surface);
        if (it != g_dcompBridges.end()) {
            if (it->second->wgpuDevice == devicePtr &&
                it->second->width == width && it->second->height == height) {
                return;
            }
            staleBridge = std::move(it->second);
            g_dcompBridges.erase(it);
        }
    }

    destroyDCompBridgeOnMainThread(std::move(staleBridge));

    // Try to initialize DComp bridge (graceful fallback on failure)
    initDCompBridgeForSurface(surface, devicePtr, width, height);
}

ELECTROBUN_EXPORT void wgpuReleaseSurfaceForView(void* surface) {
    if (!surface) return;

    std::shared_ptr<DCompBridgeState> bridge;
    {
        std::lock_guard<std::mutex> lock(g_dcompBridgeMapMutex);
        auto it = g_dcompBridges.find(surface);
        if (it != g_dcompBridges.end()) {
            bridge = std::move(it->second);
            g_dcompBridges.erase(it);
        }
    }
    {
        std::lock_guard<std::mutex> lock(g_surfaceToHwndMutex);
        g_surfaceToHwnd.erase(surface);
    }

    destroyDCompBridgeOnMainThread(std::move(bridge));
    if (ensureDCompSymbols() && p_wgpuSurfaceRelease) {
        p_wgpuSurfaceRelease((WGPUSurface)surface);
    }
}

ELECTROBUN_EXPORT void wgpuSurfaceGetCurrentTextureMainThread(void* surface, void* surfaceTexture) {
    if (!ensureWgpuSymbols()) return;

    // Check for DComp bridge
    std::shared_ptr<DCompBridgeState> bridge;
    {
        std::lock_guard<std::mutex> lock(g_dcompBridgeMapMutex);
        auto it = g_dcompBridges.find(surface);
        if (it != g_dcompBridges.end()) bridge = it->second;
    }

    if (bridge && bridge->zeroCopyTexture && !bridge->unusable.load()) {
        std::unique_lock<std::mutex> lock(bridge->frameMutex);
        auto retireBridge = [&]() {
            bridge->unusable.store(true);
            lock.unlock();
            retireDCompBridge(surface, bridge);
            bridge.reset();
        };

        // If access is still active from a previous frame (e.g. Present wasn't called),
        // end it first to avoid "already used to access" errors.
        if (bridge->accessActive) {
            WGPUSharedTextureMemoryEndAccessState endState =
                WGPU_SHARED_TEXTURE_MEMORY_END_ACCESS_STATE_INIT;
            const WGPUStatus abandonedStatus = p_wgpuSharedTextureMemoryEndAccess(
                bridge->sharedTexMem, bridge->zeroCopyTexture, &endState);
            p_wgpuSharedTextureMemoryEndAccessStateFreeMembers(endState);
            bridge->accessActive = false;
            if (abandonedStatus != WGPUStatus_Success) {
                printf(
                    "[DComp] Failed to abandon previous access (status=%d); retiring bridge\n",
                    abandonedStatus);
                retireBridge();
                runOnMainThreadSyncVoid(
                    [&]() { p_wgpuSurfaceGetCurrentTexture(surface, surfaceTexture); });
                return;
            }
        }

        // Begin access on the shared texture
        WGPUSharedTextureMemoryBeginAccessDescriptor beginDesc = {};
        beginDesc.concurrentRead = false;
        beginDesc.initialized = true;

        // Wait for the previous presentation-device copy before Dawn writes
        // this shared texture again. BeginAccess borrows these local values.
        WGPUSharedFence presentationFence = bridge->presentationSharedFence;
        uint64_t presentationFenceValue = bridge->presentationFenceValue;
        if (bridge->presentationFencePending) {
            beginDesc.fenceCount = 1;
            beginDesc.fences = &presentationFence;
            beginDesc.signaledValues = &presentationFenceValue;
        }

        WGPUStatus status = p_wgpuSharedTextureMemoryBeginAccess(
            bridge->sharedTexMem, bridge->zeroCopyTexture, &beginDesc);

        if (status == WGPUStatus_Success) {
            bridge->presentationFencePending = false;
            bridge->accessActive = true;
            // Add a reference — callers release the texture after each frame
            // (standard WGPU surface pattern), so we need an extra ref to keep it alive.
            p_wgpuTextureAddRef(bridge->zeroCopyTexture);

            // Fill the WGPUSurfaceTexture struct with our shared texture
            // WGPUSurfaceTexture layout: nextInChain(ptr,8) + texture(ptr,8) + status(u32,4)
            *((void**)surfaceTexture) = nullptr;                          // nextInChain = NULL
            *((void**)((uint8_t*)surfaceTexture + 8)) = bridge->zeroCopyTexture;  // texture
            *((uint32_t*)((uint8_t*)surfaceTexture + 16)) = WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal;  // status
            return;
        }
        printf("[DComp] BeginAccess failed (status=%d); retiring bridge\n", status);
        retireBridge();
    }

    // Normal HWND path
    runOnMainThreadSyncVoid([&]() { p_wgpuSurfaceGetCurrentTexture(surface, surfaceTexture); });
}

ELECTROBUN_EXPORT int32_t wgpuSurfacePresentMainThread(void* surface) {
    if (!ensureWgpuSymbols()) return 0;

    // Check for DComp bridge
    std::shared_ptr<DCompBridgeState> bridge;
    {
        std::lock_guard<std::mutex> lock(g_dcompBridgeMapMutex);
        auto it = g_dcompBridges.find(surface);
        if (it != g_dcompBridges.end()) bridge = it->second;
    }

    if (bridge && bridge->zeroCopyTexture && bridge->accessActive &&
        !bridge->unusable.load()) {
        std::unique_lock<std::mutex> lock(bridge->frameMutex);
        auto retireBridge = [&]() {
            bridge->unusable.store(true);
            lock.unlock();
            retireDCompBridge(surface, bridge);
            bridge.reset();
        };

        auto* swapChain = bridge->compositor.getSwapChain();
        if (!swapChain) {
            retireBridge();
            return 0;
        }

        // End Dawn's access — returns shared fences for cross-device sync
        bridge->accessActive = false;
        WGPUSharedTextureMemoryEndAccessState endState =
            WGPU_SHARED_TEXTURE_MEMORY_END_ACCESS_STATE_INIT;
        WGPUStatus status = p_wgpuSharedTextureMemoryEndAccess(
            bridge->sharedTexMem, bridge->zeroCopyTexture, &endState);
        if (status != WGPUStatus_Success) {
            p_wgpuSharedTextureMemoryEndAccessStateFreeMembers(endState);
            printf("[DComp] EndAccess failed: status=%d; retiring bridge\n", status);
            retireBridge();
            return 0;
        }

        // Cross-device sync: wait for Dawn's GPU work to finish on the presentation device
        bool dawnFenceWaitQueued = endState.fenceCount > 0;
        for (size_t i = 0; i < endState.fenceCount; i++) {
            WGPUSharedFenceDXGISharedHandleExportInfo dxgiExport =
                WGPU_SHARED_FENCE_DXGI_SHARED_HANDLE_EXPORT_INFO_INIT;
            WGPUSharedFenceExportInfo exportInfo = WGPU_SHARED_FENCE_EXPORT_INFO_INIT;
            exportInfo.nextInChain = reinterpret_cast<WGPUChainedStruct*>(&dxgiExport);
            p_wgpuSharedFenceExportInfo(endState.fences[i], &exportInfo);

            if (exportInfo.type != WGPUSharedFenceType_DXGISharedHandle ||
                !dxgiExport.handle) {
                dawnFenceWaitQueued = false;
                break;
            }

            ComPtr<ID3D11Fence> d3d11Fence;
            HRESULT fhr = bridge->presentDevice->OpenSharedFence(
                dxgiExport.handle, IID_PPV_ARGS(&d3d11Fence));
            if (FAILED(fhr) || !d3d11Fence ||
                FAILED(bridge->presentContext->Wait(
                    d3d11Fence.Get(), endState.signaledValues[i]))) {
                dawnFenceWaitQueued = false;
                break;
            }
        }

        if (!dawnFenceWaitQueued) {
            p_wgpuSharedTextureMemoryEndAccessStateFreeMembers(endState);
            printf("[DComp] Failed to queue Dawn fence wait; retiring bridge\n");
            retireBridge();
            return 0;
        }

        p_wgpuSharedTextureMemoryEndAccessStateFreeMembers(endState);

        // Copy staging -> back buffer and present
        ComPtr<ID3D11Texture2D> backBuffer;
        HRESULT hr = swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
        if (FAILED(hr)) {
            retireBridge();
            return 0;
        }

        bridge->presentContext->CopyResource(backBuffer.Get(), bridge->presentStagingTex.Get());

        const uint64_t nextFenceValue = bridge->presentationFenceValue + 1;
        hr = bridge->presentContext->Signal(
            bridge->presentationFence.Get(), nextFenceValue);
        if (FAILED(hr)) {
            const bool drained = drainD3D11Context(
                bridge->presentDevice.Get(), bridge->presentContext.Get());
            printf(
                "[DComp] Failed to signal presentation fence: 0x%08lx; "
                "retiring bridge (drained=%d)\n",
                hr,
                drained ? 1 : 0);
            retireBridge();
            return 0;
        }
        bridge->presentationFenceValue = nextFenceValue;
        bridge->presentationFencePending = true;
        bridge->presentContext->Flush();

        hr = swapChain->Present(0, 0);
        if (FAILED(hr)) {
            drainD3D11Context(
                bridge->presentDevice.Get(), bridge->presentContext.Get());
            retireBridge();
            return 0;
        }

        auto* dcompDevice = bridge->compositor.getDCompDevice();
        if (!dcompDevice || FAILED(dcompDevice->Commit())) {
            drainD3D11Context(
                bridge->presentDevice.Get(), bridge->presentContext.Get());
            retireBridge();
            return 0;
        }
        return 1;  // success
    }

    // Normal HWND path
    return (int32_t)(intptr_t)runOnMainThreadSyncPtr([&]() -> void* {
        return (void*)(intptr_t)p_wgpuSurfacePresent(surface);
    });
}

ELECTROBUN_EXPORT uint64_t wgpuQueueOnSubmittedWorkDoneShim(void* queue, void* callbackInfo) {
    if (!ensureWgpuSymbols()) return 0;
    if (!callbackInfo) return 0;
    WGPUQueueWorkDoneCallbackInfo info = *(WGPUQueueWorkDoneCallbackInfo*)callbackInfo;
    WGPUFuture future = p_wgpuQueueOnSubmittedWorkDone((WGPUQueue)queue, info);
    return future.id;
}

ELECTROBUN_EXPORT uint64_t wgpuBufferMapAsyncShim(void* buffer, uint64_t mode, uint64_t offset, uint64_t size, void* callbackInfo) {
    if (!ensureWgpuSymbols()) return 0;
    if (!callbackInfo) return 0;
    WGPUBufferMapCallbackInfo info = *(WGPUBufferMapCallbackInfo*)callbackInfo;
    WGPUFuture future = p_wgpuBufferMapAsync((WGPUBuffer)buffer, (WGPUMapMode)mode, (size_t)offset, (size_t)size, info);
    return future.id;
}

ELECTROBUN_EXPORT int32_t wgpuInstanceWaitAnyShim(void* instance, uint64_t futureId, uint64_t timeoutNS) {
    if (!ensureWgpuSymbols()) return 0;
    if (!instance || !futureId) return 0;
    WGPUFutureWaitInfo info;
    info.future.id = futureId;
    info.completed = WGPU_FALSE;
    WGPUWaitStatus status = p_wgpuInstanceWaitAny((WGPUInstance)instance, 1, &info, timeoutNS);
    if (status == WGPUWaitStatus_Success && info.completed) return 1;
    return 0;
}

ELECTROBUN_EXPORT uint8_t* wgpuBufferReadSyncShim(
    void* instance,
    void* buffer,
    uint64_t offset,
    uint64_t size,
    uint64_t timeoutNS,
    uint64_t* outSize
) {
    if (!ensureWgpuSymbols()) return nullptr;
    if (!instance || !buffer || size == 0) return nullptr;

    WGPUBufferMapCallbackInfo mapInfo = {};
    mapInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    mapInfo.callback = nullptr;
    mapInfo.userdata1 = nullptr;
    mapInfo.userdata2 = nullptr;

    WGPUFuture mapFuture = p_wgpuBufferMapAsync(
        (WGPUBuffer)buffer,
        WGPUMapMode_Read,
        (size_t)offset,
        (size_t)size,
        mapInfo
    );

    WGPUFutureWaitInfo waitInfo;
    waitInfo.future = mapFuture;
    waitInfo.completed = WGPU_FALSE;
    WGPUWaitStatus status = p_wgpuInstanceWaitAny(
        (WGPUInstance)instance,
        1,
        &waitInfo,
        timeoutNS
    );

    if (status != WGPUWaitStatus_Success || !waitInfo.completed) {
        return nullptr;
    }

    void* mapped = nullptr;
    if (p_wgpuBufferGetConstMappedRange) {
        mapped = p_wgpuBufferGetConstMappedRange((WGPUBuffer)buffer, (size_t)offset, (size_t)size);
    }
    if (!mapped) {
        mapped = p_wgpuBufferGetMappedRange((WGPUBuffer)buffer, (size_t)offset, (size_t)size);
    }
    if (!mapped) return nullptr;

    uint8_t* out = (uint8_t*)malloc((size_t)size);
    if (!out) return nullptr;
    memcpy(out, mapped, (size_t)size);
    p_wgpuBufferUnmap((WGPUBuffer)buffer);

    if (outSize) *outSize = size;
    return out;
}

ELECTROBUN_EXPORT int32_t wgpuBufferReadSyncIntoShim(
    void* instance,
    void* buffer,
    uint64_t offset,
    uint64_t size,
    uint64_t timeoutNS,
    void* dst
) {
    if (!ensureWgpuSymbols()) return 0;
    if (!instance || !buffer || !dst || size == 0) return 0;

    WGPUBufferMapCallbackInfo mapInfo = {};
    mapInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    mapInfo.callback = nullptr;
    mapInfo.userdata1 = nullptr;
    mapInfo.userdata2 = nullptr;

    WGPUFuture mapFuture = p_wgpuBufferMapAsync(
        (WGPUBuffer)buffer,
        WGPUMapMode_Read,
        (size_t)offset,
        (size_t)size,
        mapInfo
    );

    WGPUFutureWaitInfo waitInfo;
    waitInfo.future = mapFuture;
    waitInfo.completed = WGPU_FALSE;
    WGPUWaitStatus status = p_wgpuInstanceWaitAny(
        (WGPUInstance)instance,
        1,
        &waitInfo,
        timeoutNS
    );

    if (status != WGPUWaitStatus_Success || !waitInfo.completed) {
        return 0;
    }

    void* mapped = nullptr;
    if (p_wgpuBufferGetConstMappedRange) {
        mapped = p_wgpuBufferGetConstMappedRange((WGPUBuffer)buffer, (size_t)offset, (size_t)size);
    }
    if (!mapped) {
        mapped = p_wgpuBufferGetMappedRange((WGPUBuffer)buffer, (size_t)offset, (size_t)size);
    }
    if (!mapped) return 0;
    memcpy(dst, mapped, (size_t)size);
    p_wgpuBufferUnmap((WGPUBuffer)buffer);
    return 1;
}

struct WGPUReadbackJob {
    std::atomic<int> done;
    std::atomic<int> ok;
    std::atomic<int> status;
    uint8_t* dst;
    size_t size;
    WGPUBuffer buffer;
    size_t offset;
};

static void wgpuReadbackCallback(
    WGPUMapAsyncStatus status,
    WGPUStringView /*message*/,
    void* userdata1,
    void* /*userdata2*/
) {
    WGPUReadbackJob* job = (WGPUReadbackJob*)userdata1;
    if (!job) return;
    if (status != WGPUMapAsyncStatus_Success) {
        job->ok.store(0);
        job->status.store(2);
        job->done.store(1);
        return;
    }
    void* mapped = nullptr;
    if (p_wgpuBufferGetConstMappedRange) {
        mapped = p_wgpuBufferGetConstMappedRange(job->buffer, job->offset, job->size);
    }
    if (!mapped) {
        mapped = p_wgpuBufferGetMappedRange(job->buffer, job->offset, job->size);
    }
    if (mapped && job->dst) {
        memcpy(job->dst, mapped, job->size);
        job->ok.store(1);
        job->status.store(1);
    } else {
        job->ok.store(0);
        job->status.store(3);
    }
    p_wgpuBufferUnmap(job->buffer);
    job->done.store(1);
}

ELECTROBUN_EXPORT void* wgpuBufferReadbackBeginShim(
    void* buffer,
    uint64_t offset,
    uint64_t size,
    void* dst
) {
    if (!ensureWgpuSymbols()) return nullptr;
    if (!buffer || !dst || size == 0) return nullptr;

    WGPUReadbackJob* job = (WGPUReadbackJob*)malloc(sizeof(WGPUReadbackJob));
    if (!job) return nullptr;
    job->done.store(0);
    job->ok.store(0);
    job->status.store(0);
    job->dst = (uint8_t*)dst;
    job->size = (size_t)size;
    job->buffer = (WGPUBuffer)buffer;
    job->offset = (size_t)offset;

    WGPUBufferMapCallbackInfo mapInfo = {};
    mapInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    mapInfo.callback = wgpuReadbackCallback;
    mapInfo.userdata1 = job;
    mapInfo.userdata2 = nullptr;

    p_wgpuBufferMapAsync(
        (WGPUBuffer)buffer,
        WGPUMapMode_Read,
        (size_t)offset,
        (size_t)size,
        mapInfo
    );

    return job;
}

ELECTROBUN_EXPORT int32_t wgpuBufferReadbackStatusShim(void* jobPtr) {
    if (!jobPtr) return 2;
    WGPUReadbackJob* job = (WGPUReadbackJob*)jobPtr;
    if (job->done.load() == 0) return 0;
    return job->status.load();
}

ELECTROBUN_EXPORT void wgpuBufferReadbackFreeShim(void* jobPtr) {
    if (!jobPtr) return;
    WGPUReadbackJob* job = (WGPUReadbackJob*)jobPtr;
    free(job);
}

ELECTROBUN_EXPORT void wgpuRunGPUTest(void* abstractView) {
    wgpu_log("WGPU test: wgpuRunGPUTest called, abstractView=%p", abstractView);
    if (!abstractView) {
        wgpu_log("WGPU test: abstractView is null, aborting");
        return;
    }
    if (!ensureWgpuTestSymbols()) {
        wgpu_log("WGPU test: failed to load test symbols, aborting");
        return;
    }

    // Use dispatch_async like macOS - the adapter/device callbacks are async anyway
    MainThreadDispatcher::dispatch_async([abstractView]() {
        AbstractView* view = (AbstractView*)abstractView;
        HWND hwnd = view->hwnd;
        if (!hwnd || !IsWindow(hwnd)) {
            wgpu_log("WGPU test: no valid HWND found on view (hwnd=%p)", hwnd);
            return;
        }
        wgpu_log("WGPU test: got HWND=%p from WGPUView", hwnd);

        RECT rc;
        GetClientRect(hwnd, &rc);
        wgpu_log("WGPU test: HWND client rect = %ldx%ld", rc.right - rc.left, rc.bottom - rc.top);

        g_gpuTest.hwnd = hwnd;
        g_gpuTest.useAlt = false;

        // Create WGPU instance
        if (!g_gpuTest.instance) {
            g_gpuTest.instance = p_wgpuCreateInstance(nullptr);
        }
        if (!g_gpuTest.instance) {
            wgpu_log("WGPU test: FAILED to create WGPU instance");
            return;
        }
        wgpu_log("WGPU test: WGPU instance created = %p", g_gpuTest.instance);

        // Create surface from Windows HWND
        WGPUSurfaceSourceWindowsHWND hwndSource = {};
        hwndSource.chain.sType = WGPUSType_SurfaceSourceWindowsHWND;
        hwndSource.hinstance = (void*)GetModuleHandle(NULL);
        hwndSource.hwnd = (void*)hwnd;
        wgpu_log("WGPU test: creating surface with hinstance=%p hwnd=%p sType=0x%x",
              hwndSource.hinstance, hwndSource.hwnd, (unsigned)hwndSource.chain.sType);

        WGPUSurfaceDescriptor surfaceDesc = {};
        surfaceDesc.nextInChain = reinterpret_cast<WGPUChainedStruct*>(&hwndSource);
        g_gpuTest.surface = (WGPUSurface)p_wgpuInstanceCreateSurface(g_gpuTest.instance, &surfaceDesc);
        if (!g_gpuTest.surface) {
            wgpu_log("WGPU test: FAILED to create surface");
            return;
        }
        wgpu_log("WGPU test: surface created = %p", g_gpuTest.surface);

        // Request adapter
        WGPURequestAdapterOptions opts = {};
        opts.compatibleSurface = g_gpuTest.surface;
        WGPURequestAdapterCallbackInfo cbInfo = {};
        cbInfo.mode = WGPUCallbackMode_AllowSpontaneous;
        cbInfo.callback = gpuTestRequestAdapterCallback;
        cbInfo.userdata1 = &g_gpuTest;
        wgpu_log("WGPU test: requesting adapter...");
        p_wgpuInstanceRequestAdapter(g_gpuTest.instance, &opts, cbInfo);
    });
}

ELECTROBUN_EXPORT void wgpuToggleGPUTestShader(void* abstractView) {
    if (!abstractView) return;
    if (!ensureWgpuTestSymbols()) return;

    MainThreadDispatcher::dispatch_async([abstractView]() {
        AbstractView* view = (AbstractView*)abstractView;
        if (!view || !view->hwnd || !IsWindow(view->hwnd)) return;
        if (g_gpuTest.hwnd == view->hwnd) {
            g_gpuTest.useAlt = !g_gpuTest.useAlt;
        }
    });
}

ELECTROBUN_EXPORT void wgpuCreateAdapterDeviceMainThread(void* instancePtr, void* surfacePtr, void* outAdapterDevice) {
    printf("[WGPU] createAdapterDeviceMainThread: instance=%p surface=%p\n", instancePtr, surfacePtr);
    if (!ensureWgpuTestSymbols()) { printf("[WGPU] createAdapterDeviceMainThread: ensureWgpuTestSymbols FAILED\n"); return; }
    MainThreadDispatcher::dispatch_sync([instancePtr, surfacePtr, outAdapterDevice]() {
        WGPUInstance instance = (WGPUInstance)instancePtr;
        WGPUSurface surface = (WGPUSurface)surfacePtr;

        WGPUAdapter adapter = nullptr;
        WGPUDevice device = nullptr;
        HANDLE adapterEvent = CreateEventW(NULL, FALSE, FALSE, NULL);
        HANDLE deviceEvent = CreateEventW(NULL, FALSE, FALSE, NULL);

        // Request adapter
        struct AdapterCtx { WGPUAdapter* adapter; HANDLE event; };
        AdapterCtx adapterCtx = { &adapter, adapterEvent };

        WGPURequestAdapterOptions opts = {};
        // The Windows presentation path uses Dawn's D3D12 interop APIs below.
        // Leaving this undefined can select D3D11, which then cannot supply the
        // device expected by the D3D12 DirectComposition bridge.
        opts.backendType = WGPUBackendType_D3D12;
        opts.compatibleSurface = surface;
        WGPURequestAdapterCallbackInfo adapterInfo = {};
        adapterInfo.mode = WGPUCallbackMode_AllowSpontaneous;
        adapterInfo.callback = [](WGPURequestAdapterStatus status, WGPUAdapter cbAdapter, WGPUStringView message, void* userdata1, void* userdata2) {
            (void)userdata2;
            AdapterCtx* ctx = (AdapterCtx*)userdata1;
            if (status == WGPURequestAdapterStatus_Success) {
                *(ctx->adapter) = cbAdapter;
            } else {
                logWgpuStringView("WGPU adapter request failed:", message);
            }
            SetEvent(ctx->event);
        };
        adapterInfo.userdata1 = &adapterCtx;
        p_wgpuInstanceRequestAdapter(instance, &opts, adapterInfo);
        WaitForSingleObject(adapterEvent, INFINITE);
        CloseHandle(adapterEvent);

        if (!adapter) {
            wgpu_log("WGPU: adapter request failed in wgpuCreateAdapterDeviceMainThread");
            if (outAdapterDevice) {
                uint64_t* out = (uint64_t*)outAdapterDevice;
                out[0] = 0;
                out[1] = 0;
            }
            CloseHandle(deviceEvent);
            return;
        }

        // Request device
        struct DeviceCtx { WGPUDevice* device; HANDLE event; };
        DeviceCtx deviceCtx = { &device, deviceEvent };

        WGPURequestDeviceCallbackInfo deviceInfo = {};
        deviceInfo.mode = WGPUCallbackMode_AllowSpontaneous;
        deviceInfo.callback = [](WGPURequestDeviceStatus status, WGPUDevice cbDevice, WGPUStringView message, void* userdata1, void* userdata2) {
            (void)userdata2;
            DeviceCtx* ctx = (DeviceCtx*)userdata1;
            if (status == WGPURequestDeviceStatus_Success) {
                *(ctx->device) = cbDevice;
            } else {
                logWgpuStringView("WGPU device request failed:", message);
            }
            SetEvent(ctx->event);
        };
        deviceInfo.userdata1 = &deviceCtx;
        // Request shared texture memory features for zero-copy DComp bridge
        WGPUFeatureName zeroCopyFeatures[2];
        size_t zeroCopyFeatureCount = 0;

        if (p_wgpuAdapterHasFeature) {
            if (p_wgpuAdapterHasFeature(adapter, WGPUFeatureName_SharedTextureMemoryDXGISharedHandle)) {
                zeroCopyFeatures[zeroCopyFeatureCount++] = WGPUFeatureName_SharedTextureMemoryDXGISharedHandle;
                printf("[WGPU] Adapter supports SharedTextureMemoryDXGISharedHandle\n");
            }
            if (p_wgpuAdapterHasFeature(adapter, WGPUFeatureName_SharedFenceDXGISharedHandle)) {
                zeroCopyFeatures[zeroCopyFeatureCount++] = WGPUFeatureName_SharedFenceDXGISharedHandle;
                printf("[WGPU] Adapter supports SharedFenceDXGISharedHandle\n");
            }
        }
        if (zeroCopyFeatureCount == 0) {
            printf("[WGPU] Adapter does not support any SharedTextureMemory features\n");
        }

        WGPUDeviceDescriptor deviceDesc = {};
        deviceDesc.uncapturedErrorCallbackInfo.callback = gpuTestUncapturedErrorCallback;
        deviceDesc.requiredFeatureCount = zeroCopyFeatureCount;
        deviceDesc.requiredFeatures = zeroCopyFeatures;

        p_wgpuAdapterRequestDevice(adapter, &deviceDesc, deviceInfo);
        WaitForSingleObject(deviceEvent, INFINITE);
        CloseHandle(deviceEvent);

        printf("[WGPU] createAdapterDeviceMainThread: adapter=%p device=%p\n", adapter, device);
        if (outAdapterDevice) {
            uint64_t* out = (uint64_t*)outAdapterDevice;
            out[0] = (uint64_t)adapter;
            out[1] = (uint64_t)device;
        }
    });
}

ELECTROBUN_EXPORT void loadHTMLInWebView(AbstractView *abstractView, const char *htmlString) {
    if (!abstractView || !htmlString) {
        ::log("ERROR: Invalid parameters passed to loadHTMLInWebView");
        return;
    }

    const std::string html(htmlString);
    MainThreadDispatcher::dispatch_sync([abstractView, html]() {
        abstractView->loadHTML(html.c_str());
    });
}

ELECTROBUN_EXPORT void webviewGoBack(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewGoBack");
        return;
    }
    
    MainThreadDispatcher::dispatch_sync([abstractView]() {
        abstractView->goBack();
    });
}

ELECTROBUN_EXPORT void webviewGoForward(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewGoForward");
        return;
    }
    
    MainThreadDispatcher::dispatch_sync([abstractView]() {
        abstractView->goForward();
    });
}

ELECTROBUN_EXPORT void webviewReload(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewReload");
        return;
    }
    
    MainThreadDispatcher::dispatch_sync([abstractView]() {
        abstractView->reload();
    });
}

ELECTROBUN_EXPORT void webviewRemove(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView in webviewRemove");
        return;
    }

    g_pendingResizeQueue.remove(abstractView);
    // CEF browser creation and lifecycle callbacks run on the native UI
    // thread. Serialize removal with OnAfterCreated so a pending async browser
    // cannot attach itself to a view while the runtime is releasing it.
    MainThreadDispatcher::dispatch_sync([abstractView]() {
        abstractView->remove();
    });
    untrackAbstractView(abstractView);
    releaseRetainedAbstractView(abstractView);
}

ELECTROBUN_EXPORT BOOL webviewCanGoBack(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewCanGoBack");
        return FALSE;
    }
    
    return MainThreadDispatcher::dispatch_sync([abstractView]() -> BOOL {
        return abstractView->canGoBack() ? TRUE : FALSE;
    });
}

ELECTROBUN_EXPORT BOOL webviewCanGoForward(AbstractView *abstractView) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView or webview in webviewCanGoForward");
        return FALSE;
    }
    
    return MainThreadDispatcher::dispatch_sync([abstractView]() -> BOOL {
        return abstractView->canGoForward() ? TRUE : FALSE;
    });
}

ELECTROBUN_EXPORT void evaluateJavaScriptWithNoCompletion(AbstractView *abstractView, const char *script) {
    if (!abstractView || !script) {
        ::log("ERROR: Invalid parameters passed to evaluateJavaScriptWithNoCompletion");
        return;
    }

    const std::string scriptCopy(script);
    MainThreadDispatcher::dispatch_sync([abstractView, scriptCopy]() {
        if (abstractView->hasCreationFailed()) {
            ::log("ERROR: Cannot evaluate JavaScript on a webview that failed creation");
            return;
        }
        abstractView->evaluateJavaScriptWithNoCompletion(scriptCopy.c_str());
    });
    
}

ELECTROBUN_EXPORT void testFFI(void *ptr) {
    // Stub implementation
}

ELECTROBUN_EXPORT void callAsyncJavaScript(const char *messageId,
                        AbstractView *abstractView,
                        const char *jsString,
                        uint32_t webviewId,
                        uint32_t hostWebviewId,
                        callAsyncJavascriptCompletionHandler completionHandler) {
    // Stub implementation
    if (completionHandler) {
        completionHandler(messageId, webviewId, hostWebviewId, "\"\"");
    }
}

ELECTROBUN_EXPORT void addPreloadScriptToWebView(AbstractView *abstractView, const char *scriptContent, BOOL forMainFrameOnly) {
    if (abstractView && scriptContent) {
        MainThreadDispatcher::dispatch_sync([abstractView, scriptContent]() {
            abstractView->addPreloadScriptToWebView(scriptContent);
        });
    }
}

ELECTROBUN_EXPORT void updatePreloadScriptToWebView(AbstractView *abstractView,
                                 const char *scriptIdentifier,
                                 const char *scriptContent,
                                 BOOL forMainFrameOnly) {
    if (abstractView && scriptContent) {
        MainThreadDispatcher::dispatch_sync([abstractView, scriptContent]() {
            abstractView->updateCustomPreloadScript(scriptContent);
        });
    }
}

ELECTROBUN_EXPORT void invokeDecisionHandler(void (*decisionHandler)(int), int policy) {
    // Stub implementation
    if (decisionHandler) {
        decisionHandler(policy);
    }
}

ELECTROBUN_EXPORT const char* getUrlFromNavigationAction(void *navigationAction) {
    // Stub implementation
    static const char* defaultUrl = "about:blank";
    return defaultUrl;
}

ELECTROBUN_EXPORT const char* getBodyFromScriptMessage(void *message) {
    // Stub implementation
    static const char* emptyString = "";
    return emptyString;
}

ELECTROBUN_EXPORT void webviewSetTransparent(AbstractView *abstractView, BOOL transparent) {
    if (abstractView) {
        // UI operations must be performed on the main thread
        MainThreadDispatcher::dispatch_sync([abstractView, transparent]() {
            abstractView->setTransparent(transparent);
        });
    }
}

ELECTROBUN_EXPORT void webviewSetPassthrough(AbstractView *abstractView, BOOL enablePassthrough) {
    if (abstractView) {
        // UI operations must be performed on the main thread
        MainThreadDispatcher::dispatch_sync([abstractView, enablePassthrough]() {
            abstractView->setPassthrough(enablePassthrough);
        });
    }
}

ELECTROBUN_EXPORT void webviewSetHidden(AbstractView *abstractView, BOOL hidden) {
    if (abstractView) {
        // UI operations must be performed on the main thread
        MainThreadDispatcher::dispatch_sync([abstractView, hidden]() {
            abstractView->setTransparent(hidden);
        });
    }
}

ELECTROBUN_EXPORT bool webviewSetSpellCheck(AbstractView* abstractView, bool enabled) {
    (void)abstractView;
    (void)enabled;
    // This option intentionally targets macOS WKWebView, not WebView2 or CEF.
    return false;
}

ELECTROBUN_EXPORT void setWebviewNavigationRules(AbstractView *abstractView, const char *rulesJson) {
    if (abstractView) {
        // UI operations must be performed on the main thread
        MainThreadDispatcher::dispatch_sync([abstractView, rulesJson]() {
            abstractView->setNavigationRulesFromJSON(rulesJson);
        });
    }
}

ELECTROBUN_EXPORT void webviewFindInPage(AbstractView *abstractView, const char *searchText, bool forward, bool matchCase) {
    if (abstractView) {
        MainThreadDispatcher::dispatch_sync([abstractView, searchText, forward, matchCase]() {
            abstractView->findInPage(searchText, forward, matchCase);
        });
    }
}

// Remote DevTools helper functions for CEF on Windows
void openRemoteDevTools(uint32_t webviewId) {
    // TODO: Implement remote debugger approach for Windows CEF
    // This should trigger the remote debugger system when it's ported from macOS
    // For now, this is a placeholder that can be implemented once the 
    // remote debugger approach is fully ported to Windows
}

void closeRemoteDevTools(uint32_t webviewId) {
    // TODO: Close remote debugger window for Windows CEF
}

void toggleRemoteDevTools(uint32_t webviewId) {
    // TODO: Toggle remote debugger window for Windows CEF  
    // For now, just try to open
    openRemoteDevTools(webviewId);
}

ELECTROBUN_EXPORT void webviewStopFind(AbstractView *abstractView) {
    if (abstractView) {
        MainThreadDispatcher::dispatch_sync([abstractView]() {
            abstractView->stopFindInPage();
        });
    }
}

ELECTROBUN_EXPORT void webviewOpenDevTools(AbstractView *abstractView) {
    if (abstractView) {
        MainThreadDispatcher::dispatch_sync([abstractView]() {
            abstractView->openDevTools();
        });
    }
}

ELECTROBUN_EXPORT void webviewCloseDevTools(AbstractView *abstractView) {
    if (abstractView) {
        MainThreadDispatcher::dispatch_sync([abstractView]() {
            abstractView->closeDevTools();
        });
    }
}

ELECTROBUN_EXPORT void webviewToggleDevTools(AbstractView *abstractView) {
    if (abstractView) {
        MainThreadDispatcher::dispatch_sync([abstractView]() {
            abstractView->toggleDevTools();
        });
    }
}

ELECTROBUN_EXPORT void webviewSetPageZoom(AbstractView *abstractView, double zoomLevel) {
    if (!abstractView) return;

    MainThreadDispatcher::dispatch_sync([abstractView, zoomLevel]() {
        if (auto webview2 = dynamic_cast<WebView2View*>(abstractView)) {
            webview2->setPageZoom(zoomLevel);
            return;
        }

        if (auto cefView = dynamic_cast<CEFView*>(abstractView)) {
            if (auto browser = cefView->getBrowser()) {
                double cefZoomLevel = std::log(zoomLevel) / std::log(1.2);
                browser->GetHost()->SetZoomLevel(cefZoomLevel);
            }
        }
    });
}

ELECTROBUN_EXPORT double webviewGetPageZoom(AbstractView *abstractView) {
    if (!abstractView) return 1.0;

    return MainThreadDispatcher::dispatch_sync([abstractView]() -> double {
        if (auto webview2 = dynamic_cast<WebView2View*>(abstractView)) {
            return webview2->getPageZoom();
        }

        if (auto cefView = dynamic_cast<CEFView*>(abstractView)) {
            if (auto browser = cefView->getBrowser()) {
                double cefZoomLevel = browser->GetHost()->GetZoomLevel();
                return std::pow(1.2, cefZoomLevel);
            }
        }

        return 1.0;
    });
}

ELECTROBUN_EXPORT NSRect createNSRectWrapper(double x, double y, double width, double height) {
    // Stub implementation
    NSRect rect = {x, y, width, height};
    return rect;
}

ELECTROBUN_EXPORT NSWindow* createNSWindowWithFrameAndStyle(uint32_t windowId,
                                         createNSWindowWithFrameAndStyleParams config,
                                         WindowCloseHandler zigCloseHandler,
                                         WindowMoveHandler zigMoveHandler,
                                         WindowResizeHandler zigResizeHandler,
                                         WindowFocusHandler zigFocusHandler,
                                         WindowBlurHandler zigBlurHandler,
                                         WindowKeyHandler zigKeyHandler,
                                         WindowShouldCloseHandler zigShouldCloseHandler) {
    // Stub implementation
    return new NSWindow();
}

ELECTROBUN_EXPORT void testFFI2(void (*completionHandler)()) {
    // Stub implementation
    if (completionHandler) {
        completionHandler();
    }
}

ELECTROBUN_EXPORT HWND createWindowWithFrameAndStyleFromWorker(
    uint32_t windowId,
    double x, double y,
    double width, double height,
    uint32_t styleMask,
    const char* titleBarStyle,
    bool transparent,
    double trafficLightOffsetX,
    double trafficLightOffsetY,
    WindowCloseHandler zigCloseHandler,
    WindowMoveHandler zigMoveHandler,
    WindowResizeHandler zigResizeHandler,
    WindowFocusHandler zigFocusHandler,
    WindowBlurHandler zigBlurHandler,
    WindowKeyHandler zigKeyHandler,
    WindowShouldCloseHandler zigShouldCloseHandler) {

    (void)trafficLightOffsetX;
    (void)trafficLightOffsetY;

    // Everything GUI-related needs to be dispatched to main thread
    HWND hwnd = MainThreadDispatcher::dispatch_sync([=]() -> HWND {

        // Register window class with our custom procedure
        static bool classRegistered = false;
        if (!classRegistered) {
            WNDCLASSW wc = {0};
            wc.lpfnWndProc = WindowProc;
            wc.hInstance = g_hInstanceDll;
            wc.lpszClassName = L"BasicWindowClass";
            if (!RegisterClassW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
                ::log("ERROR: Failed to register BasicWindowClass");
                return NULL;
            }
            classRegistered = true;
        }

        // Create window data structure to store callbacks
        WindowData* data = (WindowData*)malloc(sizeof(WindowData));
        if (!data) return NULL;

        data->windowId = windowId;
        data->closeHandler = zigCloseHandler;
        data->shouldCloseHandler = zigShouldCloseHandler;
        data->moveHandler = zigMoveHandler;
        data->resizeHandler = zigResizeHandler;
        data->focusHandler = zigFocusHandler;
        data->blurHandler = zigBlurHandler;
        data->keyHandler = zigKeyHandler;
        data->bypassShouldClose = false;
        data->pendingHighSurrogate = 0;

        // Map style mask to Windows style
        DWORD windowStyle = WS_OVERLAPPEDWINDOW; // Default
        DWORD windowExStyle = WS_EX_APPWINDOW;

        // Handle titleBarStyle options
        data->chromeStyle = ChromeStyle::Default;
        if (titleBarStyle && strcmp(titleBarStyle, "hidden") == 0) {
            // "hidden" = borderless window (no titlebar, no native controls)
            // This is for completely custom chrome
            windowStyle = WS_POPUP;
        } else if (titleBarStyle && strcmp(titleBarStyle, "hiddenInset") == 0) {
            // "hiddenInset" = frameless window with resize borders and DWM shadow.
            // We use WS_CAPTION | WS_THICKFRAME so the system treats it as a
            // standard framed window (giving us shadow and border resizing),
            // then remove the caption bar area in WM_NCCALCSIZE.
            windowStyle = WS_CAPTION | WS_THICKFRAME | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
            data->chromeStyle = ChromeStyle::HiddenInset;
        }
        // else: default titleBarStyle = WS_OVERLAPPEDWINDOW (standard window)

        // Handle transparent windows
        if (transparent) {
            // For transparent windows, we need WS_EX_LAYERED to support per-pixel alpha
            windowExStyle |= WS_EX_LAYERED;
        }

        // Electrobun's cross-platform window geometry is expressed in DIPs.
        // PMv2 Win32 APIs consume physical pixels, so select the destination
        // monitor in logical space and scale both rectangle edges once.
        const auto targetMonitor =
            electrobun::windowsMonitorForLogicalPoint(x, y);
        const RECT physicalFrame = electrobun::logicalToPhysicalScreenRect(
            x, y, width, height, targetMonitor);

        // Create the window
        HWND hwnd = CreateWindowExW(
            windowExStyle,
            L"BasicWindowClass",
            L"",
            windowStyle,
            physicalFrame.left, physicalFrame.top,
            physicalFrame.right - physicalFrame.left,
            physicalFrame.bottom - physicalFrame.top,
            NULL, NULL, g_hInstanceDll, NULL
        );

        if (hwnd) {
            // Store our data with the window
            SetWindowLongPtr(hwnd, GWLP_USERDATA, (LONG_PTR)data);
            updateWindowTheme(hwnd);

            // Apply transparent window background if requested
            if (transparent) {
                // For transparent windows using OSR, UpdateLayeredWindow will handle
                // the rendering with per-pixel alpha. We don't use SetLayeredWindowAttributes.
                // The OSRWindow will call UpdateLayeredWindow with the CEF-rendered content.
            }

            // Don't apply application menu to transparent or custom chrome windows
            // Only apply to windows with default titleBarStyle
            bool isCustomChrome = transparent ||
                                 (titleBarStyle && strcmp(titleBarStyle, "hidden") == 0) ||
                                 (titleBarStyle && strcmp(titleBarStyle, "hiddenInset") == 0);

            if (!isCustomChrome && g_applicationMenu) {
                if (SetMenu(hwnd, g_applicationMenu)) {
                    DrawMenuBar(hwnd);
                    // char logMsg[256];
                    // sprintf_s(logMsg, "Applied application menu to new window: HWND=%p", hwnd);
                    // ::log(logMsg);
                } else {
                    ::log("Failed to apply application menu to new window");
                }
            }


            // Force the window frame to recalculate so WM_NCCALCSIZE
            // is sent again with chromeStyle already set.
            if (data->chromeStyle == ChromeStyle::HiddenInset) {
                SetWindowPos(hwnd, NULL, 0, 0, 0, 0,
                    SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            }

            // The Zig core shows the window after creation unless hidden=true.
            // Creating it visible here makes the hidden option impossible to honor.
            UpdateWindow(hwnd);
        } else {
            // Clean up if window creation failed
            free(data);
        }

        return hwnd;
    });

    return hwnd;
}

static void activateVisibleWindow(HWND hwnd) {
    if (!IsWindowVisible(hwnd)) {
        return;
    }

    // Bring window to foreground - this is more complex on Windows
    // due to foreground window restrictions
    if (SetForegroundWindow(hwnd)) {
    } else {
        DWORD currentThreadId = GetCurrentThreadId();
        DWORD foregroundThreadId = GetWindowThreadProcessId(GetForegroundWindow(), NULL);

        if (currentThreadId != foregroundThreadId) {
            if (AttachThreadInput(currentThreadId, foregroundThreadId, TRUE)) {
                SetForegroundWindow(hwnd);
                SetFocus(hwnd);
                AttachThreadInput(currentThreadId, foregroundThreadId, FALSE);
            } else {
                FLASHWINFO fwi = {0};
                fwi.cbSize = sizeof(FLASHWINFO);
                fwi.hwnd = hwnd;
                fwi.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
                fwi.uCount = 3;
                fwi.dwTimeout = 0;
                FlashWindowEx(&fwi);
            }
        }
    }

    SetActiveWindow(hwnd);
    SetFocus(hwnd);
    SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);

    // Top-level HWND activation alone does not return keyboard focus to an
    // embedded WebView2 controller after an OLE drag/drop deactivates it.
    auto containerIt = g_containerViews.find(hwnd);
    if (containerIt != g_containerViews.end()) {
        containerIt->second->FocusActiveView();
    }
}

ELECTROBUN_EXPORT void showWindow(void *window, bool activate) {
    // On Windows, window ptr is actually HWND
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in showWindow");
        return;
    }
    
    // Dispatch to main thread to ensure thread safety
    MainThreadDispatcher::dispatch_sync([=]() {
        if (!IsWindowVisible(hwnd)) {
            ShowWindow(hwnd, activate ? SW_SHOW : SW_SHOWNOACTIVATE);
        } else if (!activate) {
            ShowWindow(hwnd, SW_SHOWNA);
        }

        if (activate) {
            activateVisibleWindow(hwnd);
        } else {
            SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE);
        }
    });
}

ELECTROBUN_EXPORT void activateWindow(void *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in activateWindow");
        return;
    }

    MainThreadDispatcher::dispatch_sync([=]() {
        activateVisibleWindow(hwnd);
    });
}

ELECTROBUN_EXPORT void hideWindow(void *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in hideWindow");
        return;
    }

    MainThreadDispatcher::dispatch_sync([=]() {
        ShowWindow(hwnd, SW_HIDE);
    });
}

ELECTROBUN_EXPORT bool isWindowVisible(void *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in isWindowVisible");
        return false;
    }

    return MainThreadDispatcher::dispatch_sync([=]() -> bool {
        return IsWindowVisible(hwnd) != FALSE;
    });
}

ELECTROBUN_EXPORT void setWindowTitle(NSWindow *window, const char *title) {
    // On Windows, NSWindow* is actually HWND
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in setWindowTitle");
        return;
    }
    
    // Dispatch to main thread to ensure thread safety
    MainThreadDispatcher::dispatch_sync([=]() {
        const std::string_view utf8Title = title ? std::string_view(title) : std::string_view();
        if (!electrobun::setWindowTextUtf8(hwnd, utf8Title)) {
            DWORD error = GetLastError();
            char errorMsg[256];
            sprintf_s(errorMsg, "Failed to set UTF-8 window title, error: %lu", error);
            ::log(errorMsg);
        }
    });
}

ELECTROBUN_EXPORT void closeWindow(NSWindow *window) {
    // On Windows, NSWindow* is actually HWND
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in closeWindow");
        return;
    }

    // Dispatch to main thread to ensure thread safety
    MainThreadDispatcher::dispatch_sync([=]() {

        WindowData* data = (WindowData*)GetWindowLongPtr(hwnd, GWLP_USERDATA);
        if (data) {
            data->bypassShouldClose = true;
        }


        // Send WM_CLOSE message to the window
        // This triggers the core close trampoline, which unregisters child
        // webviews before WM_DESTROY releases the owning ContainerView. Erasing
        // the container here would destroy those views first and leave stale
        // pointers in the core registry during the close callback.
        if (PostMessage(hwnd, WM_CLOSE, 0, 0)) {
        } else {
            DWORD error = GetLastError();
            char errorMsg[256];
            sprintf_s(errorMsg, "Failed to send WM_CLOSE message, error: %lu", error);
            ::log(errorMsg);

            // If PostMessage fails, try DestroyWindow as a fallback
            ::log("Attempting DestroyWindow as fallback");
            if (DestroyWindow(hwnd)) {
            } else {
                DWORD destroyError = GetLastError();
                char destroyErrorMsg[256];
                sprintf_s(destroyErrorMsg, "DestroyWindow also failed, error: %lu", destroyError);
                ::log(destroyErrorMsg);
            }
        }
    });
}

ELECTROBUN_EXPORT void requestWindowClose(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) return;
    PostMessage(hwnd, WM_CLOSE, 0, 0);
}

ELECTROBUN_EXPORT void minimizeWindow(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in minimizeWindow");
        return;
    }

    MainThreadDispatcher::dispatch_sync([=]() {
        ShowWindow(hwnd, SW_MINIMIZE);
    });
}

ELECTROBUN_EXPORT void restoreWindow(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in restoreWindow");
        return;
    }

    MainThreadDispatcher::dispatch_sync([=]() {
        ShowWindow(hwnd, SW_RESTORE);
    });
}

ELECTROBUN_EXPORT bool isWindowMinimized(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        return false;
    }

    return IsIconic(hwnd) != 0;
}

ELECTROBUN_EXPORT void maximizeWindow(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in maximizeWindow");
        return;
    }

    MainThreadDispatcher::dispatch_sync([=]() {
        ShowWindow(hwnd, SW_MAXIMIZE);
    });
}

ELECTROBUN_EXPORT void unmaximizeWindow(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in unmaximizeWindow");
        return;
    }

    MainThreadDispatcher::dispatch_sync([=]() {
        ShowWindow(hwnd, SW_RESTORE);
    });
}

ELECTROBUN_EXPORT bool isWindowMaximized(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        return false;
    }

    return IsZoomed(hwnd) != 0;
}

ELECTROBUN_EXPORT void setWindowFullScreen(NSWindow *window, bool fullScreen) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in setWindowFullScreen");
        return;
    }

    MainThreadDispatcher::dispatch_sync([=]() {
        static std::map<HWND, WINDOWPLACEMENT> savedPlacements;
        static std::map<HWND, LONG> savedStyles;

        LONG style = GetWindowLong(hwnd, GWL_STYLE);
        bool isCurrentlyFullScreen = (style & WS_POPUP) && !(style & WS_OVERLAPPEDWINDOW);

        if (fullScreen && !isCurrentlyFullScreen) {
            // Save current state
            WINDOWPLACEMENT wp = { sizeof(WINDOWPLACEMENT) };
            GetWindowPlacement(hwnd, &wp);
            savedPlacements[hwnd] = wp;
            savedStyles[hwnd] = style;

            // Get the monitor info for the window
            HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            MONITORINFO mi = { sizeof(MONITORINFO) };
            GetMonitorInfo(monitor, &mi);

            // Remove window decorations and set to fullscreen
            SetWindowLong(hwnd, GWL_STYLE, style & ~WS_OVERLAPPEDWINDOW | WS_POPUP);
            SetWindowPos(hwnd, HWND_TOP,
                mi.rcMonitor.left, mi.rcMonitor.top,
                mi.rcMonitor.right - mi.rcMonitor.left,
                mi.rcMonitor.bottom - mi.rcMonitor.top,
                SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
        } else if (!fullScreen && isCurrentlyFullScreen) {
            // Restore saved state
            auto styleIt = savedStyles.find(hwnd);
            if (styleIt != savedStyles.end()) {
                SetWindowLong(hwnd, GWL_STYLE, styleIt->second);
                savedStyles.erase(styleIt);
            }

            auto placementIt = savedPlacements.find(hwnd);
            if (placementIt != savedPlacements.end()) {
                SetWindowPlacement(hwnd, &placementIt->second);
                savedPlacements.erase(placementIt);
            }

            SetWindowPos(hwnd, NULL, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
        }
    });
}

ELECTROBUN_EXPORT bool isWindowFullScreen(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        return false;
    }

    LONG style = GetWindowLong(hwnd, GWL_STYLE);
    return (style & WS_POPUP) && !(style & WS_OVERLAPPEDWINDOW);
}

ELECTROBUN_EXPORT void setWindowAlwaysOnTop(NSWindow *window, bool alwaysOnTop) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in setWindowAlwaysOnTop");
        return;
    }

    MainThreadDispatcher::dispatch_sync([=]() {
        SetWindowPos(hwnd,
            alwaysOnTop ? HWND_TOPMOST : HWND_NOTOPMOST,
            0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE);
    });
}

ELECTROBUN_EXPORT bool isWindowAlwaysOnTop(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);

    if (!IsWindow(hwnd)) {
        return false;
    }

    LONG exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
    return (exStyle & WS_EX_TOPMOST) != 0;
}

ELECTROBUN_EXPORT void setWindowVisibleOnAllWorkspaces(NSWindow *window, bool visible) {
    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in setWindowVisibleOnAllWorkspaces");
        return;
    }

    std::lock_guard<std::mutex> lock(g_visibleOnAllWorkspacesMutex);
    g_visibleOnAllWorkspaces[hwnd] = visible;
}

ELECTROBUN_EXPORT bool isWindowVisibleOnAllWorkspaces(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) {
        return false;
    }

    std::lock_guard<std::mutex> lock(g_visibleOnAllWorkspacesMutex);
    auto it = g_visibleOnAllWorkspaces.find(hwnd);
    return it != g_visibleOnAllWorkspaces.end() && it->second;
}

ELECTROBUN_EXPORT void setWindowPosition(NSWindow *window, double x, double y) {
    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) return;

    const auto targetMonitor = electrobun::windowsMonitorForLogicalPoint(
        x,
        y,
        MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST));
    const POINT physicalOrigin = electrobun::logicalScreenPointToPhysical(
        x, y, targetMonitor);
    SetWindowPos(
        hwnd,
        NULL,
        physicalOrigin.x,
        physicalOrigin.y,
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

ELECTROBUN_EXPORT void centerWindow(NSWindow *window) {
    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) return;

    RECT windowRect{};
    RECT workArea{};
    if (!GetWindowRect(hwnd, &windowRect) ||
        !SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0)) {
        return;
    }

    const int width = windowRect.right - windowRect.left;
    const int height = windowRect.bottom - windowRect.top;
    const int x = workArea.left + std::max<LONG>(0, ((workArea.right - workArea.left) - width) / 2);
    const int y = workArea.top + std::max<LONG>(0, ((workArea.bottom - workArea.top) - height) / 2);
    SetWindowPos(hwnd, NULL, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

ELECTROBUN_EXPORT void setWindowButtonPosition(NSWindow *window, double x, double y) {
    (void)window;
    (void)x;
    (void)y;
    // Not applicable on Windows - no-op
}

ELECTROBUN_EXPORT void getWindowButtonPosition(NSWindow *window, double* x, double* y) {
    (void)window;
    if (x) *x = 0;
    if (y) *y = 0;
}

ELECTROBUN_EXPORT void setWindowSize(NSWindow *window, double width, double height) {
    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) return;

    const UINT dpi = electrobun::windowsDpiForWindow(hwnd);
    const RECT physicalSize = electrobun::logicalToPhysicalRect(
        0, 0, width, height, dpi);
    SetWindowPos(
        hwnd,
        NULL,
        0,
        0,
        physicalSize.right,
        physicalSize.bottom,
        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}

ELECTROBUN_EXPORT void setWindowFrame(NSWindow *window, double x, double y, double width, double height) {
    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) return;

    const auto targetMonitor = electrobun::windowsMonitorForLogicalPoint(
        x,
        y,
        MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST));
    const RECT physicalFrame = electrobun::logicalToPhysicalScreenRect(
        x, y, width, height, targetMonitor);
    SetWindowPos(
        hwnd,
        NULL,
        physicalFrame.left,
        physicalFrame.top,
        physicalFrame.right - physicalFrame.left,
        physicalFrame.bottom - physicalFrame.top,
        SWP_NOZORDER | SWP_NOACTIVATE);
}

ELECTROBUN_EXPORT void getWindowFrame(NSWindow *window, double *outX, double *outY, double *outWidth, double *outHeight) {
    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) {
        *outX = 0;
        *outY = 0;
        *outWidth = 0;
        *outHeight = 0;
        return;
    }

    RECT rect = {};
    if (!GetWindowRect(hwnd, &rect)) {
        *outX = 0;
        *outY = 0;
        *outWidth = 0;
        *outHeight = 0;
        return;
    }
    const auto monitor = electrobun::windowsMonitorForHandle(
        MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST));
    const POINT logicalOrigin = electrobun::physicalScreenPointToLogical(
        rect.left, rect.top, monitor);
    *outX = logicalOrigin.x;
    *outY = logicalOrigin.y;
    *outWidth = electrobun::physicalToLogicalCoordinate(
        rect.right - rect.left, monitor.dpi);
    *outHeight = electrobun::physicalToLogicalCoordinate(
        rect.bottom - rect.top, monitor.dpi);
}

// Return the drawable client area's screen-space origin. Public window frames
// include the non-client border/title bar, while WGPU views are positioned in
// client coordinates. UI hit testing must therefore translate the cursor from
// this origin rather than GetWindowRect's outer origin.
ELECTROBUN_EXPORT void getWindowContentOrigin(NSWindow *window, double *outX, double *outY) {
    if (!outX || !outY) return;

    *outX = 0;
    *outY = 0;
    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) return;

    POINT clientOrigin = {0, 0};
    if (!ClientToScreen(hwnd, &clientOrigin)) return;

    const auto monitor = electrobun::windowsMonitorForHandle(
        MonitorFromPoint(clientOrigin, MONITOR_DEFAULTTONEAREST));
    const POINT logicalOrigin = electrobun::physicalScreenPointToLogical(
        clientOrigin.x, clientOrigin.y, monitor);
    *outX = logicalOrigin.x;
    *outY = logicalOrigin.y;
}

ELECTROBUN_EXPORT void getWindowContentSize(NSWindow *window, double *outWidth, double *outHeight) {
    if (!outWidth || !outHeight) return;

    *outWidth = 0;
    *outHeight = 0;
    HWND hwnd = reinterpret_cast<HWND>(window);
    if (!IsWindow(hwnd)) return;

    RECT clientRect = {};
    if (!GetClientRect(hwnd, &clientRect)) return;
    const UINT dpi = electrobun::windowsDpiForWindow(hwnd);
    *outWidth = electrobun::physicalToLogicalCoordinate(
        clientRect.right - clientRect.left, dpi);
    *outHeight = electrobun::physicalToLogicalCoordinate(
        clientRect.bottom - clientRect.top, dpi);
}

ELECTROBUN_EXPORT void resizeWebview(AbstractView *abstractView, double x, double y, double width, double height, const char *masksJson) {
    if (!abstractView) {
        ::log("ERROR: Invalid AbstractView in resizeWebview");
        return;
    }
    abstractView->setLogicalFrame(x, y, width, height);
    const RECT bounds = electrobun::logicalToPhysicalRect(
        x, y, width, height, abstractView->parentDpi());
    abstractView->storePendingResize(bounds, masksJson);
    g_pendingResizeQueue.enqueue(abstractView);
    schedulePendingResizeDrain();
}

// Internal function to stop window movement (without export linkage)



ELECTROBUN_EXPORT void stopWindowMove() {
    if (g_isMovingWindow) {
        // Unregister raw input device
        RAWINPUTDEVICE rid;
        rid.usUsagePage = 0x01;
        rid.usUsage = 0x02;
        rid.dwFlags = RIDEV_REMOVE;
        rid.hwndTarget = NULL;
        
        RegisterRawInputDevices(&rid, 1, sizeof(RAWINPUTDEVICE));
        g_isMovingWindow = FALSE;
        g_targetWindow = NULL;
    }
}

ELECTROBUN_EXPORT void startWindowMove(NSWindow *window) {
    // On Windows, NSWindow* is actually HWND
    HWND hwnd = reinterpret_cast<HWND>(window);
    
    if (!IsWindow(hwnd)) {
        ::log("ERROR: Invalid window handle in startWindowMove");
        return;
    }
    
    // Set up window dragging state
    g_targetWindow = hwnd;
    g_isMovingWindow = TRUE;
    
    // Get initial cursor and window positions
    GetCursorPos(&g_initialCursorPos);
    RECT windowRect;
    GetWindowRect(hwnd, &windowRect);
    g_initialWindowPos.x = windowRect.left;
    g_initialWindowPos.y = windowRect.top;
    
    // Register for raw mouse input to bypass WebView2 event consumption
    RAWINPUTDEVICE rid;
    rid.usUsagePage = 0x01;  // HID_USAGE_PAGE_GENERIC
    rid.usUsage = 0x02;      // HID_USAGE_GENERIC_MOUSE
    rid.dwFlags = RIDEV_INPUTSINK; // Receive input even when not in foreground
    rid.hwndTarget = hwnd;   // Send messages to our window
    
    if (!RegisterRawInputDevices(&rid, 1, sizeof(RAWINPUTDEVICE))) {
        ::log("ERROR: Failed to register raw input device - error: " + std::to_string(GetLastError()));
        g_isMovingWindow = FALSE;
        g_targetWindow = NULL;
    }
}

ELECTROBUN_EXPORT BOOL moveToTrash(char *pathString) {
    if (!pathString) {
        ::log("ERROR: NULL path string passed to moveToTrash");
        return FALSE;
    }
    
    std::wstring widePathValue;
    if (!electrobun::utf8ToWide(pathString, widePathValue)) {
        ::log("ERROR: Failed to convert path to wide string");
        return FALSE;
    }

    std::vector<wchar_t> widePath(
        widePathValue.begin(), widePathValue.end());
    widePath.push_back(L'\0');
    widePath.push_back(L'\0');
    
    // Use SHFileOperation to move to recycle bin
    SHFILEOPSTRUCTW fileOp = {};
    fileOp.hwnd = NULL;
    fileOp.wFunc = FO_DELETE;
    fileOp.pFrom = widePath.data();
    fileOp.pTo = NULL;
    fileOp.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT;
    fileOp.fAnyOperationsAborted = FALSE;
    fileOp.hNameMappings = NULL;
    fileOp.lpszProgressTitle = NULL;
    
    int result = SHFileOperationW(&fileOp);
    
    if (result == 0 && !fileOp.fAnyOperationsAborted) {
        ::log("Successfully moved to trash: " + std::string(pathString));
        return TRUE;
    } else {
        ::log("ERROR: Failed to move to trash: " + std::string(pathString) + " (error code: " + std::to_string(result) + ")");
        return FALSE;
    }
}

ELECTROBUN_EXPORT void showItemInFolder(char *path) {
    if (!path) {
        ::log("ERROR: NULL path passed to showItemInFolder");
        return;
    }
    
    std::string pathString(path);
    if (pathString.empty()) {
        ::log("ERROR: Empty path passed to showItemInFolder");
        return;
    }
    
    std::wstring widePath;
    if (!electrobun::utf8ToWide(pathString, widePath)) {
        ::log("ERROR: Failed to convert path to wide string in showItemInFolder");
        return;
    }

    // Use ShellExecute to open Explorer and select the file
    std::wstring selectParam = L"/select,\"" + widePath + L"\"";
    
    HINSTANCE result = ShellExecuteW(
        NULL,                    // parent window
        L"open",                 // operation
        L"explorer.exe",         // executable
        selectParam.c_str(),     // parameters
        NULL,                    // working directory
        SW_SHOWNORMAL           // show command
    );
    
    // Check if the operation was successful
    if (reinterpret_cast<INT_PTR>(result) <= 32) {
        ::log("ERROR: Failed to show item in folder: " + pathString + " (error code: " + std::to_string(reinterpret_cast<INT_PTR>(result)) + ")");
    } else {
        ::log("Successfully opened folder for: " + pathString);
    }
}

// Open a URL in the default browser or appropriate application
ELECTROBUN_EXPORT BOOL openExternal(const char *urlString) {
    if (!urlString) {
        ::log("ERROR: NULL URL passed to openExternal");
        return FALSE;
    }

    std::string url(urlString);
    if (url.empty()) {
        ::log("ERROR: Empty URL passed to openExternal");
        return FALSE;
    }

    std::wstring wideUrl;
    if (!electrobun::utf8ToWide(url, wideUrl)) {
        ::log("ERROR: Failed to convert URL to wide string");
        return FALSE;
    }

    // Use ShellExecuteW to open the URL
    HINSTANCE result = ShellExecuteW(
        NULL,           // parent window
        L"open",        // operation
        wideUrl.c_str(), // URL to open
        NULL,           // parameters
        NULL,           // working directory
        SW_SHOWNORMAL   // show command
    );

    if (reinterpret_cast<INT_PTR>(result) <= 32) {
        ::log("ERROR: Failed to open external URL: " + url + " (error code: " + std::to_string(reinterpret_cast<INT_PTR>(result)) + ")");
        return FALSE;
    }

    ::log("Successfully opened external URL: " + url);
    return TRUE;
}

// Open a file or folder with the default application
ELECTROBUN_EXPORT BOOL openPath(const char *pathString) {
    if (!pathString) {
        ::log("ERROR: NULL path passed to openPath");
        return FALSE;
    }

    std::string path(pathString);
    if (path.empty()) {
        ::log("ERROR: Empty path passed to openPath");
        return FALSE;
    }

    std::wstring widePath;
    if (!electrobun::utf8ToWide(path, widePath)) {
        ::log("ERROR: Failed to convert path to wide string");
        return FALSE;
    }

    // Use ShellExecuteW to open the file/folder with default application
    HINSTANCE result = ShellExecuteW(
        NULL,            // parent window
        L"open",         // operation
        widePath.c_str(), // file/folder to open
        NULL,            // parameters
        NULL,            // working directory
        SW_SHOWNORMAL    // show command
    );

    if (reinterpret_cast<INT_PTR>(result) <= 32) {
        ::log("ERROR: Failed to open path: " + path + " (error code: " + std::to_string(reinterpret_cast<INT_PTR>(result)) + ")");
        return FALSE;
    }

    ::log("Successfully opened path: " + path);
    return TRUE;
}

// Show a native desktop notification using Shell_NotifyIcon balloon
ELECTROBUN_EXPORT void showNotification(const char *title, const char *body, const char *subtitle, BOOL silent) {
    if (!title) {
        ::log("ERROR: NULL title passed to showNotification");
        return;
    }

    const std::string titleCopy(title);
    const std::string bodyCopy(body ? body : "");
    const std::string subtitleCopy(subtitle ? subtitle : "");
    const bool isSilent = silent != FALSE;

    MainThreadDispatcher::dispatch_async(
        [titleCopy, bodyCopy, subtitleCopy, isSilent]() {
            HWND owner = MainThreadDispatcher::message_window();
            if (!owner) {
                ::log("ERROR: Cannot show notification before the Windows event loop starts");
                return;
            }

            std::wstring wideTitle;
            std::wstring wideBody;
            std::wstring wideSubtitle;
            if (!electrobun::utf8ToWide(titleCopy, wideTitle) ||
                !electrobun::utf8ToWide(bodyCopy, wideBody) ||
                !electrobun::utf8ToWide(subtitleCopy, wideSubtitle)) {
                ::log("ERROR: Notification text is not valid UTF-8");
                return;
            }

            if (!wideSubtitle.empty()) {
                wideBody = wideBody.empty()
                    ? wideSubtitle
                    : wideSubtitle + L"\n" + wideBody;
            }
            // An empty szInfo removes a balloon instead of showing one.
            if (wideBody.empty()) {
                wideBody = wideTitle;
            }

            NOTIFYICONDATAW nid = {};
            nid.cbSize = sizeof(nid);
            nid.hWnd = owner;
            nid.uID = (g_nextNotificationId.fetch_add(1) % 0xfffeu) + 1u;
            nid.uCallbackMessage = WM_ELECTROBUN_NOTIFICATION;
            nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            nid.hIcon = LoadIconW(NULL, MAKEINTRESOURCEW(32512));
            nid.dwInfoFlags = NIIF_INFO | (isSilent ? NIIF_NOSOUND : 0);

            electrobun::copyUtf8ToWideBuffer(titleCopy, nid.szTip);
            electrobun::copyWideToBuffer(wideTitle, nid.szInfoTitle);
            electrobun::copyWideToBuffer(wideBody, nid.szInfo);

            if (!Shell_NotifyIconW(NIM_ADD, &nid)) {
                ::log("ERROR: Shell_NotifyIconW(NIM_ADD) failed");
                return;
            }

            nid.uVersion = NOTIFYICON_VERSION_4;
            Shell_NotifyIconW(NIM_SETVERSION, &nid);
            nid.uFlags |= NIF_INFO;
            if (!Shell_NotifyIconW(NIM_MODIFY, &nid)) {
                ::log("ERROR: Shell_NotifyIconW(NIM_MODIFY) failed");
                removeTransientNotificationIcon(owner, nid.uID);
                return;
            }

            // The shell normally reports balloon completion through the
            // callback above. This timer prevents a stale tray icon if it does
            // not (for example while Explorer is restarting).
            SetTimer(
                owner,
                nid.uID,
                30000,
                transientNotificationTimerProc);
            ::log("Notification shown: " + titleCopy);
        });
}

ELECTROBUN_EXPORT const char* openFileDialog(const char *startingFolder,
                          const char *allowedFileTypes,
                          BOOL canChooseFiles,
                          BOOL canChooseDirectories,
                          BOOL allowsMultipleSelection) {
    if (!canChooseFiles && !canChooseDirectories) {
        ::log("ERROR: Both canChooseFiles and canChooseDirectories are false");
        return nullptr;
    }
    
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    if (FAILED(hr)) {
        ::log("ERROR: Failed to initialize COM");
        return nullptr;
    }
    
    IFileOpenDialog *pFileDialog = nullptr;
    hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_ALL, IID_IFileOpenDialog, (void**)&pFileDialog);
    if (FAILED(hr)) {
        ::log("ERROR: Failed to create file dialog");
        CoUninitialize();
        return nullptr;
    }
    
    // Set dialog options
    DWORD dwFlags = 0;
    pFileDialog->GetOptions(&dwFlags);
    
    if (canChooseDirectories) {
        dwFlags |= FOS_PICKFOLDERS;
    }
    if (allowsMultipleSelection) {
        dwFlags |= FOS_ALLOWMULTISELECT;
    }
    if (!canChooseFiles) {
        dwFlags |= FOS_PICKFOLDERS;
    }
    
    pFileDialog->SetOptions(dwFlags);
    
    // Set starting folder
    if (startingFolder && strlen(startingFolder) > 0) {
        std::wstring wideStartingFolder;
        if (electrobun::utf8ToWide(startingFolder, wideStartingFolder)) {
            IShellItem *pStartingFolder = nullptr;
            hr = SHCreateItemFromParsingName(
                wideStartingFolder.c_str(),
                nullptr,
                IID_IShellItem,
                (void**)&pStartingFolder);
            if (SUCCEEDED(hr)) {
                pFileDialog->SetFolder(pStartingFolder);
                pStartingFolder->Release();
            }
        }
    }
    
    // Set file type filters
    if (allowedFileTypes && strlen(allowedFileTypes) > 0 && strcmp(allowedFileTypes, "*") != 0) {
        std::string typesStr(allowedFileTypes);
        std::vector<std::string> extensions;
        std::stringstream ss(typesStr);
        std::string extension;
        
        while (std::getline(ss, extension, ',')) {
            // Trim whitespace
            extension.erase(0, extension.find_first_not_of(" \t"));
            extension.erase(extension.find_last_not_of(" \t") + 1);
            if (!extension.empty()) {
                extensions.push_back(extension);
            }
        }
        
        if (!extensions.empty()) {
            // Create filter specification
            std::vector<COMDLG_FILTERSPEC> filterSpecs;
            std::vector<std::wstring> filterNames;
            std::vector<std::wstring> filterPatterns;
            filterNames.reserve(extensions.size());
            filterPatterns.reserve(extensions.size());
            
            for (const auto& ext : extensions) {
                std::wstring wExt;
                if (!electrobun::utf8ToWide(ext, wExt)) {
                    ::log("ERROR: File dialog extension is not valid UTF-8");
                    continue;
                }
                if (wExt.find(L".") != 0) {
                    wExt = L"." + wExt;
                }
                std::wstring pattern = L"*" + wExt;
                std::wstring name = wExt.substr(1) + L" files";
                
                filterNames.push_back(name);
                filterPatterns.push_back(pattern);
            }

            filterSpecs.reserve(filterNames.size());
            for (size_t index = 0; index < filterNames.size(); ++index) {
                COMDLG_FILTERSPEC spec;
                spec.pszName = filterNames[index].c_str();
                spec.pszSpec = filterPatterns[index].c_str();
                filterSpecs.push_back(spec);
            }
            
            if (!filterSpecs.empty()) {
                pFileDialog->SetFileTypes(static_cast<UINT>(filterSpecs.size()), filterSpecs.data());
            }
        }
    }
    
    // Show the dialog
    hr = pFileDialog->Show(nullptr);
    std::vector<std::string> paths;
    
    if (SUCCEEDED(hr)) {
        if (allowsMultipleSelection) {
            IShellItemArray *pShellItemArray = nullptr;
            hr = pFileDialog->GetResults(&pShellItemArray);
            if (SUCCEEDED(hr)) {
                DWORD itemCount = 0;
                pShellItemArray->GetCount(&itemCount);
                
                for (DWORD i = 0; i < itemCount; i++) {
                    IShellItem *pShellItem = nullptr;
                    hr = pShellItemArray->GetItemAt(i, &pShellItem);
                    if (SUCCEEDED(hr)) {
                        PWSTR pszPath = nullptr;
                        hr = pShellItem->GetDisplayName(SIGDN_FILESYSPATH, &pszPath);
                        if (SUCCEEDED(hr)) {
                            std::string utf8Path;
                            if (pszPath && electrobun::wideToUtf8(pszPath, utf8Path)) {
                                paths.push_back(std::move(utf8Path));
                            }
                            CoTaskMemFree(pszPath);
                        }
                        pShellItem->Release();
                    }
                }
                pShellItemArray->Release();
            }
        } else {
            IShellItem *pShellItem = nullptr;
            hr = pFileDialog->GetResult(&pShellItem);
            if (SUCCEEDED(hr)) {
                PWSTR pszPath = nullptr;
                hr = pShellItem->GetDisplayName(SIGDN_FILESYSPATH, &pszPath);
                if (SUCCEEDED(hr)) {
                    std::string utf8Path;
                    if (pszPath && electrobun::wideToUtf8(pszPath, utf8Path)) {
                        paths.push_back(std::move(utf8Path));
                    }
                    CoTaskMemFree(pszPath);
                }
                pShellItem->Release();
            }
        }
    }
    
    pFileDialog->Release();
    CoUninitialize();
    
    if (paths.empty()) {
        ::log("File dialog cancelled or no selection made");
    }

    return strdup(serializeDialogPaths(paths).c_str());
}

using TaskDialogIndirectFn = HRESULT (WINAPI*)(
    const TASKDIALOGCONFIG*, int*, int*, BOOL*);

static HRESULT showTaskDialogWithDllActivationContext(
    const TASKDIALOGCONFIG& config,
    int& pressedButton
) {
    ACTCTXW activationConfig = {};
    activationConfig.cbSize = sizeof(activationConfig);
    activationConfig.dwFlags =
        ACTCTX_FLAG_HMODULE_VALID | ACTCTX_FLAG_RESOURCE_NAME_VALID;
    activationConfig.hModule = g_hInstanceDll;
    // DLL manifests use resource ID 2 by convention.
    activationConfig.lpResourceName = MAKEINTRESOURCEW(2);

    HANDLE activationContext = CreateActCtxW(&activationConfig);
    ULONG_PTR activationCookie = 0;
    const bool activated = activationContext != INVALID_HANDLE_VALUE &&
        ActivateActCtx(activationContext, &activationCookie) != FALSE;

    HMODULE commonControls = LoadLibraryW(L"comctl32.dll");
    auto taskDialogIndirect = commonControls
        ? reinterpret_cast<TaskDialogIndirectFn>(
              GetProcAddress(commonControls, "TaskDialogIndirect"))
        : nullptr;
    const HRESULT result = taskDialogIndirect
        ? taskDialogIndirect(&config, &pressedButton, nullptr, nullptr)
        : HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);

    if (commonControls) {
        FreeLibrary(commonControls);
    }
    if (activated) {
        DeactivateActCtx(0, activationCookie);
    }
    if (activationContext != INVALID_HANDLE_VALUE) {
        ReleaseActCtx(activationContext);
    }
    return result;
}

ELECTROBUN_EXPORT int showMessageBox(const char *type,
                                     const char *title,
                                     const char *message,
                                     const char *detail,
                                     const char *buttons,
                                     int defaultId,
                                     int cancelId) {
    return MainThreadDispatcher::dispatch_sync([=]() -> int {
        std::wstring wideTitle;
        std::wstring wideMessage;
        std::wstring wideDetail;
        if (!electrobun::utf8ToWide(title ? title : "", wideTitle) ||
            !electrobun::utf8ToWide(message ? message : "", wideMessage) ||
            !electrobun::utf8ToWide(detail ? detail : "", wideDetail)) {
            ::log("ERROR: Message box text is not valid UTF-8");
            return -1;
        }

        std::vector<std::wstring> buttonLabels;
        if (!electrobun::parseWindowsDialogButtonLabels(
                buttons ? buttons : "", buttonLabels)) {
            ::log("ERROR: Message box button text is not valid UTF-8");
            return -1;
        }
        if (buttonLabels.size() > 4096) {
            ::log("ERROR: Message box has too many buttons");
            return -1;
        }

        std::vector<TASKDIALOG_BUTTON> taskButtons;
        taskButtons.reserve(buttonLabels.size());
        for (size_t index = 0; index < buttonLabels.size(); ++index) {
            taskButtons.push_back({
                electrobun::windowsTaskDialogButtonId(index),
                buttonLabels[index].c_str(),
            });
        }

        PCWSTR icon = TD_INFORMATION_ICON;
        const std::string typeString(type ? type : "info");
        if (typeString == "warning") {
            icon = TD_WARNING_ICON;
        } else if (typeString == "error" || typeString == "critical") {
            icon = TD_ERROR_ICON;
        }

        HWND owner = GetActiveWindow();
        TASKDIALOGCONFIG config = {};
        config.cbSize = sizeof(config);
        config.hwndParent = owner;
        config.hInstance = g_hInstanceDll;
        config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT;
        if (owner) {
            config.dwFlags |= TDF_POSITION_RELATIVE_TO_WINDOW;
        }
        config.pszWindowTitle = wideTitle.c_str();
        config.pszMainInstruction = wideMessage.empty()
            ? nullptr
            : wideMessage.c_str();
        config.pszContent = wideDetail.empty() ? nullptr : wideDetail.c_str();
        config.pszMainIcon = icon;
        config.cButtons = static_cast<UINT>(taskButtons.size());
        config.pButtons = taskButtons.data();
        config.nDefaultButton = electrobun::windowsTaskDialogButtonId(
            static_cast<size_t>(electrobun::normalizeWindowsDialogDefaultId(
                defaultId, buttonLabels.size())));

        int pressedButton = 0;
        const HRESULT result = showTaskDialogWithDllActivationContext(
            config, pressedButton);
        if (FAILED(result)) {
            ::log(
                "ERROR: TaskDialogIndirect failed with HRESULT " +
                std::to_string(static_cast<long>(result)));
            std::wstring fallbackText = wideMessage;
            if (!wideDetail.empty()) {
                if (!fallbackText.empty()) fallbackText += L"\n\n";
                fallbackText += wideDetail;
            }
            MessageBoxW(
                owner,
                fallbackText.c_str(),
                wideTitle.c_str(),
                MB_OK | MB_ICONERROR);
            return 0;
        }

        return electrobun::windowsTaskDialogButtonIndex(
            pressedButton, buttonLabels.size(), cancelId);
    });
}

// ============================================================================
// Clipboard API
// ============================================================================

static bool openClipboardWithRetry(HWND owner = nullptr) {
    for (int attempt = 0; attempt < 50; attempt++) {
        if (OpenClipboard(owner)) {
            return true;
        }
        Sleep(10);
    }
    return false;
}

// clipboardReadText - Read text from the system clipboard
// Returns: UTF-8 string (caller must free) or NULL if no text available
ELECTROBUN_EXPORT const char* clipboardReadText() {
    return MainThreadDispatcher::dispatch_sync([=]() -> const char* {
        if (!openClipboardWithRetry()) {
            return nullptr;
        }

        const char* result = nullptr;
        HANDLE hData = GetClipboardData(CF_UNICODETEXT);
        if (hData) {
            wchar_t* wText = static_cast<wchar_t*>(GlobalLock(hData));
            if (wText) {
                std::string utf8TextValue;
                if (electrobun::wideToUtf8(wText, utf8TextValue)) {
                    char* utf8Text = static_cast<char*>(
                        malloc(utf8TextValue.size() + 1));
                    if (utf8Text) {
                        memcpy(
                            utf8Text,
                            utf8TextValue.c_str(),
                            utf8TextValue.size() + 1);
                    }
                    result = utf8Text;
                }
                GlobalUnlock(hData);
            }
        }

        CloseClipboard();
        return result;
    });
}

// clipboardWriteText - Write text to the system clipboard
ELECTROBUN_EXPORT void clipboardWriteText(const char* text) {
    if (!text) return;

    MainThreadDispatcher::dispatch_sync([=]() {
        if (!openClipboardWithRetry()) {
            return;
        }

        EmptyClipboard();

        std::wstring wideText;
        if (electrobun::utf8ToWide(text, wideText)) {
            const size_t wideBytes =
                (wideText.size() + 1) * sizeof(wchar_t);
            HGLOBAL hMem = GlobalAlloc(GMEM_MOVEABLE, wideBytes);
            if (hMem) {
                wchar_t* wText = static_cast<wchar_t*>(GlobalLock(hMem));
                if (wText) {
                    memcpy(wText, wideText.c_str(), wideBytes);
                    GlobalUnlock(hMem);
                    if (!SetClipboardData(CF_UNICODETEXT, hMem)) {
                        GlobalFree(hMem);
                    }
                } else {
                    GlobalFree(hMem);
                }
            }
        }

        CloseClipboard();
    });
}

// clipboardReadImage - Read image from clipboard as PNG data
// Returns: PNG data (caller must free) and sets outSize, or NULL if no image
ELECTROBUN_EXPORT const uint8_t* clipboardReadImage(size_t* outSize) {
    return MainThreadDispatcher::dispatch_sync([=]() -> const uint8_t* {
        if (outSize) *outSize = 0;

        if (!openClipboardWithRetry()) {
            return nullptr;
        }

        const uint8_t* result = nullptr;

        // Try CF_DIB format (Device Independent Bitmap)
        HANDLE hData = GetClipboardData(CF_DIB);
        if (hData) {
            BITMAPINFO* bmi = static_cast<BITMAPINFO*>(GlobalLock(hData));
            if (bmi) {
                // For now, return raw DIB data - full PNG conversion would require
                // additional libraries like libpng or GDI+
                // TODO: Implement proper PNG conversion using GDI+ or similar
                size_t dataSize = GlobalSize(hData);
                uint8_t* buffer = static_cast<uint8_t*>(malloc(dataSize));
                memcpy(buffer, bmi, dataSize);
                if (outSize) *outSize = dataSize;
                result = buffer;
                GlobalUnlock(hData);
            }
        }

        CloseClipboard();
        return result;
    });
}

// clipboardWriteImage - Write PNG image data to clipboard
ELECTROBUN_EXPORT void clipboardWriteImage(const uint8_t* pngData, size_t size) {
    if (!pngData || size == 0) return;

    MainThreadDispatcher::dispatch_sync([=]() {
        if (!openClipboardWithRetry()) {
            return;
        }

        EmptyClipboard();

        // For now, store as raw data - proper PNG to DIB conversion would require
        // additional libraries
        // TODO: Implement proper PNG to DIB conversion
        HGLOBAL hMem = GlobalAlloc(GMEM_MOVEABLE, size);
        if (hMem) {
            void* data = GlobalLock(hMem);
            memcpy(data, pngData, size);
            GlobalUnlock(hMem);
            // Register a custom format for PNG data
            UINT pngFormat = RegisterClipboardFormatA("PNG");
            SetClipboardData(pngFormat, hMem);
        }

        CloseClipboard();
    });
}

// clipboardClear - Clear the clipboard
ELECTROBUN_EXPORT void clipboardClear() {
    MainThreadDispatcher::dispatch_sync([=]() {
        if (openClipboardWithRetry()) {
            EmptyClipboard();
            CloseClipboard();
        }
    });
}

// clipboardAvailableFormats - Get available formats in clipboard
// Returns: comma-separated list of formats (caller must free)
ELECTROBUN_EXPORT const char* clipboardAvailableFormats() {
    return MainThreadDispatcher::dispatch_sync([=]() -> const char* {
        if (!openClipboardWithRetry()) {
            return strdup("");
        }

        bool hasText = false;
        bool hasImage = false;
        bool hasFiles = false;
        bool hasHtml = false;
        UINT htmlFormat = RegisterClipboardFormatA("HTML Format");

        UINT format = 0;
        while ((format = EnumClipboardFormats(format)) != 0) {
            switch (format) {
                case CF_UNICODETEXT:
                case CF_TEXT:
                case CF_OEMTEXT:
                    hasText = true;
                    break;
                case CF_DIB:
                case CF_DIBV5:
                case CF_BITMAP:
                    hasImage = true;
                    break;
                case CF_HDROP:
                    hasFiles = true;
                    break;
                default:
                    if (format == htmlFormat) {
                        hasHtml = true;
                    }
                    break;
            }
        }

        if (!hasText && (GetClipboardData(CF_UNICODETEXT) || GetClipboardData(CF_TEXT))) {
            hasText = true;
        }

        CloseClipboard();

        std::vector<std::string> formats;
        if (hasText) formats.push_back("text");
        if (hasImage) formats.push_back("image");
        if (hasFiles) formats.push_back("files");
        if (hasHtml) formats.push_back("html");

        // Join formats with comma
        std::string result;
        for (size_t i = 0; i < formats.size(); i++) {
            if (i > 0) result += ",";
            result += formats[i];
        }

        return strdup(result.c_str());
    });
}

// Window procedure for handling tray messages
LRESULT CALLBACK TrayWindowProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CLOSE:
        case WM_DESTROY:
            // Don't allow the tray window to be closed/destroyed by default handlers
            ::log("Preventing tray window close/destroy");
            return 0;
            
        case WM_COMMAND:
        // Handle menu item clicks
        {
            auto it = g_trayItems.find(hwnd);
            if (it != g_trayItems.end()) {
                NSStatusItem* trayItem = it->second;
                UINT menuItemId = LOWORD(wParam);
                
                // Use your existing function to handle the menu selection
                handleMenuItemSelection(menuItemId, trayItem);
            }
            return 0;
        }
            
        default:
            // Check if this is our tray message
            if (msg == g_trayMessageId) {
                // Find the tray item
                auto it = g_trayItems.find(hwnd);
                if (it != g_trayItems.end()) {
                    NSStatusItem* trayItem = it->second;
                    
                    switch (LOWORD(lParam)) {
                        case WM_LBUTTONUP:
                           
                            
                        case WM_RBUTTONUP:
                            // Right click - show context menu if it exists, otherwise call handler
                            if (trayItem->contextMenu) {
                                
                                
                                POINT pt;
                                GetCursorPos(&pt);
                                
                                // This is required for the menu to work properly
                                SetForegroundWindow(hwnd);
                                
                                // Show the menu
                                BOOL menuResult = TrackPopupMenu(
                                    trayItem->contextMenu, 
                                    TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_LEFTALIGN,
                                    pt.x, pt.y, 
                                    0, 
                                    hwnd, 
                                    NULL
                                );
                                
                                // This message helps ensure the menu closes properly
                                PostMessage(hwnd, WM_NULL, 0, 0);
                                
                                if (!menuResult) {
                                    ::log("TrackPopupMenu failed");
                                }
                            } else {
                                // No menu exists yet, call handler (this will trigger menu creation)
                                
                                
                                if (trayItem->handler) {
                                    // Use a separate thread or async call to prevent blocking
                                    std::thread([trayItem]() {
                                        try {
                                            trayItem->handler(trayItem->trayId, "");
                                        } catch (...) {
                                            ::log("Exception in tray handler");
                                        }
                                    }).detach();
                                }
                            }
                            return 0;
                            
                        default:
                            break;
                    }
                }
                return 0;
            }
            break;
    }
    
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

ELECTROBUN_EXPORT NSStatusItem* createTray(uint32_t trayId, const char *title, const char *pathToImage, bool isTemplate,
                        uint32_t width, uint32_t height, ZigStatusItemHandler zigTrayItemHandler) {
    
    return MainThreadDispatcher::dispatch_sync([=]() -> NSStatusItem* {
        // ::log("Creating system tray icon");
        
        NSStatusItem* statusItem = new NSStatusItem();
        statusItem->trayId = trayId;
        statusItem->handler = zigTrayItemHandler;
        
        if (title) {
            statusItem->title = std::string(title);
        }
        if (pathToImage) {
            statusItem->imagePath = std::string(pathToImage);
        }
        
        // Create a hidden window to receive tray messages
        static bool classRegistered = false;
        if (!classRegistered) {
            WNDCLASSW wc = {0};
            wc.lpfnWndProc = TrayWindowProc;
            wc.hInstance = g_hInstanceDll;
            wc.lpszClassName = L"TrayWindowClass";
            wc.hbrBackground = NULL;
            wc.hCursor = LoadCursorW(NULL, MAKEINTRESOURCEW(32512));
            wc.style = 0; // No special styles
            
            if (!RegisterClassW(&wc)) {
                DWORD error = GetLastError();
                if (error != ERROR_CLASS_ALREADY_EXISTS) {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "Failed to register TrayWindowClass: %lu", error);
                    ::log(errorMsg);
                    delete statusItem;
                    return nullptr;
                }
            }
            classRegistered = true;
        }
        
        // Create message-only window (safer for tray operations)
        statusItem->hwnd = CreateWindowW(
            L"TrayWindowClass",
            L"TrayWindow",
            0,                    // No visible style
            0, 0, 0, 0,          // Position and size (ignored for message-only)
            HWND_MESSAGE,        // Message-only window
            NULL, 
            g_hInstanceDll,
            NULL
        );
        
        if (!statusItem->hwnd) {
            DWORD error = GetLastError();
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Failed to create tray window: %lu", error);
            ::log(errorMsg);
            delete statusItem;
            return nullptr;
        }
        
        
        
        // Store in global map before setting up the tray icon
        g_trayItems[statusItem->hwnd] = statusItem;
        
        // Set up NOTIFYICONDATA
        statusItem->nid.cbSize = sizeof(NOTIFYICONDATAW);
        statusItem->nid.hWnd = statusItem->hwnd;
        statusItem->nid.uID = trayId;
        statusItem->nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        statusItem->nid.uCallbackMessage = g_trayMessageId;
        
        // Set title/tooltip
        if (!statusItem->title.empty()) {
            if (!electrobun::copyUtf8ToWideBuffer(
                    statusItem->title, statusItem->nid.szTip)) {
                ::log("ERROR: Tray title is not valid UTF-8");
            }
        }
        
        // Load icon
        if (!statusItem->imagePath.empty()) {
            std::wstring wImagePath;
            if (electrobun::utf8ToWide(statusItem->imagePath, wImagePath)) {
                statusItem->nid.hIcon = (HICON)LoadImageW(NULL, wImagePath.c_str(), IMAGE_ICON,
                                                         width, height, LR_LOADFROMFILE);
                
                if (!statusItem->nid.hIcon) {
                    char errorMsg[256];
                    sprintf_s(errorMsg, "Failed to load icon from: %s", statusItem->imagePath.c_str());
                    ::log(errorMsg);
                }
            }
        }
        
        // Use default icon if loading failed
        if (!statusItem->nid.hIcon) {
            statusItem->nid.hIcon = LoadIcon(NULL, IDI_APPLICATION);
            ::log("Using default application icon");
        }
        
        // Add to system tray
        if (Shell_NotifyIconW(NIM_ADD, &statusItem->nid)) {
            // char successMsg[256];
            // sprintf_s(successMsg, "System tray icon created successfully: ID=%u, HWND=%p", trayId, statusItem->hwnd);
            // ::log(successMsg);
        } else {
            DWORD error = GetLastError();
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Failed to add icon to system tray: %lu", error);
            ::log(errorMsg);
            
            DestroyWindow(statusItem->hwnd);
            g_trayItems.erase(statusItem->hwnd);
            delete statusItem;
            return nullptr;
        }
        
        return statusItem;
    });
}

ELECTROBUN_EXPORT void setTrayTitle(NSStatusItem *statusItem, const char *title) {
    if (!statusItem) return;
    
    MainThreadDispatcher::dispatch_sync([=]() {
        
        if (title) {
            statusItem->title = std::string(title);
            if (!electrobun::copyUtf8ToWideBuffer(
                    statusItem->title, statusItem->nid.szTip)) {
                ::log("ERROR: Tray title is not valid UTF-8");
            }
        } else {
            statusItem->title.clear();
            statusItem->nid.szTip[0] = L'\0';
        }
        
        // Update the tray icon
        Shell_NotifyIconW(NIM_MODIFY, &statusItem->nid);
    });
}

ELECTROBUN_EXPORT void setTrayImage(NSStatusItem *statusItem, const char *image, bool /*isTemplate*/,
                                    uint32_t width, uint32_t height) {
    if (!statusItem) return;
    
    MainThreadDispatcher::dispatch_sync([=]() {
        
        HICON oldIcon = statusItem->nid.hIcon;
        
        if (image && strlen(image) > 0) {
            statusItem->imagePath = std::string(image);
            
            std::wstring wImagePath;
            if (electrobun::utf8ToWide(image, wImagePath)) {
                statusItem->nid.hIcon = (HICON)LoadImageW(NULL, wImagePath.c_str(), IMAGE_ICON,
                                                         width, height, LR_LOADFROMFILE);
            }
        }
        
        // Use default icon if loading failed
        if (!statusItem->nid.hIcon) {
            statusItem->nid.hIcon = LoadIcon(NULL, IDI_APPLICATION);
        }
        
        // Update the tray icon
        if (Shell_NotifyIconW(NIM_MODIFY, &statusItem->nid)) {
            // Clean up old icon if it's not the default
            if (oldIcon && oldIcon != LoadIcon(NULL, IDI_APPLICATION)) {
                DestroyIcon(oldIcon);
            }
        } else {
            ::log("ERROR: Failed to update tray image");
            // Restore old icon on failure
            statusItem->nid.hIcon = oldIcon;
        }
    });
}

// Updated setTrayMenuFromJSON function
ELECTROBUN_EXPORT void setTrayMenuFromJSON(NSStatusItem *statusItem, const char *jsonString) {
    if (!statusItem || !jsonString) return;
        
    MainThreadDispatcher::dispatch_sync([=]() {
        
        if (!statusItem->handler) {
            ::log("ERROR: No handler found for status item");
            return;
        }
        
        try {
            // Parse JSON using our simple parser
            SimpleJsonValue menuConfig = parseJson(std::string(jsonString));
            
            if (menuConfig.type != SimpleJsonValue::ARRAY) {
                ::log("ERROR: JSON menu configuration is not an array");
                return;
            }
            
            // Clean up existing menu
            if (statusItem->contextMenu) {
                DestroyMenu(statusItem->contextMenu);
                statusItem->contextMenu = NULL;
            }
            
            // Create new menu from JSON config
            statusItem->contextMenu = createMenuFromConfig(menuConfig, statusItem);
            
            if (statusItem->contextMenu) {
            } else {
                ::log("ERROR: Failed to create context menu from JSON configuration");
            }
            
        } catch (const std::exception& e) {
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Exception parsing JSON: %s", e.what());
            ::log(errorMsg);
        } catch (...) {
            ::log("ERROR: Unknown exception parsing JSON");
        }
    });
}

// You'll also need to update your tray click handler to process menu selections
// This should be called from your window procedure when handling tray icon messages
void handleTrayIconMessage(HWND hwnd, WPARAM wParam, LPARAM lParam) {
    NSStatusItem* statusItem = nullptr;
    
    // Find the status item from the global map
    auto it = g_trayItems.find(hwnd);
    if (it != g_trayItems.end()) {
        statusItem = it->second;
    }
    
    switch (lParam) {
        case WM_RBUTTONUP:
        case WM_CONTEXTMENU:
            if (statusItem && statusItem->contextMenu) {
                POINT pt;
                GetCursorPos(&pt);
                
                // Required for popup menus to work correctly
                SetForegroundWindow(hwnd);
                
                UINT cmd = TrackPopupMenu(
                    statusItem->contextMenu,
                    TPM_RETURNCMD | TPM_RIGHTBUTTON,
                    pt.x, pt.y,
                    0, hwnd, NULL
                );
                
                if (cmd != 0) {
                    handleMenuItemSelection(cmd, statusItem);
                }
                
                // Required cleanup
                PostMessage(hwnd, WM_NULL, 0, 0);
            }
            break;
            
        case WM_LBUTTONUP:
            // Handle left click on tray icon
            if (statusItem && statusItem->handler) {
                statusItem->handler(statusItem->trayId, "");
            }
            break;
    }
}

ELECTROBUN_EXPORT void setTrayMenu(NSStatusItem *statusItem, const char *menuConfig) {
    // Delegate to JSON version for now
    setTrayMenuFromJSON(statusItem, menuConfig);
}

ELECTROBUN_EXPORT void removeTray(NSStatusItem *statusItem) {
    if (!statusItem) return;
    
    MainThreadDispatcher::dispatch_sync([=]() {
        // Remove from global map first
        g_trayItems.erase(statusItem->hwnd);
        
        // Clean up the tray item
        delete statusItem;
    });
}

ELECTROBUN_EXPORT const char* getTrayBounds(NSStatusItem *statusItem) {
    (void)statusItem;
    return _strdup("{\"x\":0,\"y\":0,\"width\":0,\"height\":0}");
}

ELECTROBUN_EXPORT void setApplicationMenu(const char *jsonString, ZigStatusItemHandler zigTrayItemHandler) {
    if (!jsonString) {
        ::log("ERROR: NULL JSON string passed to setApplicationMenu");
        return;
    }
    
    
    MainThreadDispatcher::dispatch_sync([=]() {
        try {
            // Parse JSON using our simple parser
            SimpleJsonValue menuConfig = parseJson(std::string(jsonString));
            
            if (menuConfig.type != SimpleJsonValue::ARRAY) {
                ::log("ERROR: Application menu JSON configuration is not an array");
                return;
            }
            
            // Create target for handling menu actions
            g_appMenuTarget = std::make_unique<StatusItemTarget>();
            g_appMenuTarget->zigHandler = zigTrayItemHandler;
            g_appMenuTarget->trayId = 0;
            
            // Clean up existing application menu and accelerators
            if (g_applicationMenu) {
                DestroyMenu(g_applicationMenu);
                g_applicationMenu = NULL;
            }
            clearMenuAccelerators();

            // Create new application menu from JSON config
            g_applicationMenu = createApplicationMenuFromConfig(menuConfig, g_appMenuTarget.get());

            // Rebuild the accelerator table after menu creation
            rebuildAcceleratorTable();
            
            if (g_applicationMenu) {
                
                // Find the main application window to set the menu
                HWND mainWindow = GetActiveWindow();
                if (!mainWindow) {
                    mainWindow = FindWindowW(L"BasicWindowClass", NULL);
                }
                
                if (mainWindow) {
                    if (SetMenu(mainWindow, g_applicationMenu)) {
                        DrawMenuBar(mainWindow);
                        
                       
                    } else {
                        DWORD error = GetLastError();
                        char errorMsg[256];
                        sprintf_s(errorMsg, "Failed to set application menu on window: %lu", error);
                        ::log(errorMsg);
                    }
                } else {
                    ::log("Warning: No main window found to attach application menu");
                }
            } else {
                ::log("ERROR: Failed to create application menu from JSON configuration");
            }
            
        } catch (const std::exception& e) {
            char errorMsg[256];
            sprintf_s(errorMsg, "ERROR: Exception in setApplicationMenu: %s", e.what());
            ::log(errorMsg);
        } catch (...) {
            ::log("ERROR: Unknown exception in setApplicationMenu");
        }
    });
}


ELECTROBUN_EXPORT void showContextMenu(const char *jsonString, ZigStatusItemHandler contextMenuHandler) {
    if (!jsonString) {
        ::log("ERROR: NULL JSON string passed to showContextMenu");
        return;
    }
    
    if (!contextMenuHandler) {
        ::log("ERROR: NULL context menu handler passed to showContextMenu");
        return;
    }
    
    MainThreadDispatcher::dispatch_sync([=]() {
        try {
            SimpleJsonValue menuConfig = parseJson(std::string(jsonString));

            std::unique_ptr<NSStatusItem> target = std::make_unique<NSStatusItem>();
            target->handler = contextMenuHandler;
            target->trayId = 0;

            HMENU menu = createMenuFromConfig(menuConfig, target.get());
            if (!menu) {
                ::log("ERROR: Failed to create context menu");
                return;
            }
            
            // Get cursor position for menu display
            POINT pt;
            GetCursorPos(&pt);
            
            // Get the foreground window or use desktop
            HWND hwnd = GetForegroundWindow();
            if (!hwnd) {
                hwnd = GetDesktopWindow();
            }
            
            // Required for proper menu operation
            SetForegroundWindow(hwnd);
                        
            // Show the context menu
            UINT cmd = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_RIGHTBUTTON,
                pt.x, pt.y,
                0, hwnd, NULL
            );
            
            // Handle menu selection
            if (cmd != 0) {
                handleMenuItemSelection(cmd, target.get());
            }
            
            // Required for proper cleanup
            PostMessage(hwnd, WM_NULL, 0, 0);
            
            // Cleanup menu
            DestroyMenu(menu);
            
        } catch (const std::exception& e) {
            ::log("ERROR: Exception in showContextMenu: " + std::string(e.what()));
        }
    });
}

ELECTROBUN_EXPORT void getWebviewSnapshot(uint32_t hostId, uint32_t webviewId,
                       WKWebView *webView,
                       zigSnapshotCallback callback) {
    // Stub implementation
    if (callback) {
        static const char* emptyDataUrl = "data:image/png;base64,";
        callback(hostId, webviewId, emptyDataUrl);
    }
}

ELECTROBUN_EXPORT void setJSUtils(GetMimeType getMimeType, GetHTMLForWebviewSync getHTMLForWebviewSync) {
    ::log("setJSUtils called but using map-based approach instead of callbacks");
}

// MARK: - Webview HTML Content Management (replaces JSCallback approach)

extern "C" ELECTROBUN_EXPORT void setWebviewHTMLContent(uint32_t webviewId, const char* htmlContent) {
    std::lock_guard<std::mutex> lock(webviewHTMLMutex);
    if (htmlContent) {
        webviewHTMLContent[webviewId] = std::string(htmlContent);
        char logMsg[256];
        sprintf_s(logMsg, "setWebviewHTMLContent: Set HTML for webview %u", webviewId);
        ::log(logMsg);
    } else {
        webviewHTMLContent.erase(webviewId);
        char logMsg[256];
        sprintf_s(logMsg, "setWebviewHTMLContent: Cleared HTML for webview %u", webviewId);
        ::log(logMsg);
    }
}

extern "C" ELECTROBUN_EXPORT const char* getWebviewHTMLContent(uint32_t webviewId) {
    std::lock_guard<std::mutex> lock(webviewHTMLMutex);
    auto it = webviewHTMLContent.find(webviewId);
    if (it != webviewHTMLContent.end()) {
        char* result = _strdup(it->second.c_str());
        char logMsg[256];
        sprintf_s(logMsg, "getWebviewHTMLContent: Retrieved HTML for webview %u", webviewId);
        ::log(logMsg);
        return result;
    } else {
        char logMsg[256];
        sprintf_s(logMsg, "getWebviewHTMLContent: No HTML found for webview %u", webviewId);
        ::log(logMsg);
        return nullptr;
    }
}

// Adding a few Windows-specific functions for interop if needed
ELECTROBUN_EXPORT uint32_t getWindowStyle(
    bool Borderless,
    bool Titled,
    bool Closable,
    bool Miniaturizable,
    bool Resizable,
    bool UnifiedTitleAndToolbar,
    bool FullScreen,
    bool FullSizeContentView,
    bool UtilityWindow,
    bool DocModalWindow,
    bool NonactivatingPanel,
    bool HUDWindow) {
    // Stub implementation that returns a composite style mask
    uint32_t mask = 0;
    if (Borderless) mask |= 1;
    if (Titled) mask |= 2;
    if (Closable) mask |= 4;
    if (Resizable) mask |= 8;
    return mask;
}

} // extern "C"

// New function for handling views:// scheme requests
void setupViewsSchemeHandler(ICoreWebView2* webview, uint32_t webviewId) {
    
    // Add web resource request filter for views:// scheme
    EventRegistrationToken resourceToken;
    HRESULT hr = webview->add_WebResourceRequested(
        Callback<ICoreWebView2WebResourceRequestedEventHandler>(
            [webviewId](ICoreWebView2* sender, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                ComPtr<ICoreWebView2WebResourceRequest> request;
                args->get_Request(&request);
                
                LPWSTR uri;
                request->get_Uri(&uri);
                
                std::wstring wUri(uri ? uri : L"");
                
                
                
                // Check if this is a views:// URL
                if (wUri.find(L"views://") == 0) {
                    handleViewsSchemeRequest(args, wUri, webviewId);
                }
                
                CoTaskMemFree(uri);
                return S_OK;
            }).Get(), 
        &resourceToken);
    
    if (FAILED(hr)) {
        char errorMsg[256];
        sprintf_s(errorMsg, "Failed to add WebResourceRequested handler: 0x%lx", hr);
        ::log(errorMsg);
        return;
    }
    
    // Add filter for views:// scheme
    hr = webview->AddWebResourceRequestedFilter(L"views://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    if (FAILED(hr)) {
        char errorMsg[256];
        sprintf_s(errorMsg, "Failed to add resource filter for views://: 0x%lx", hr);
        ::log(errorMsg);
    } else {
    }
}

// Updated function to handle views:// scheme requests
void handleViewsSchemeRequest(ICoreWebView2WebResourceRequestedEventArgs* args, 
                             const std::wstring& uri, 
                             uint32_t webviewId) {
    
    
    std::string uriStr;
    if (!electrobun::wideToUtf8(uri, uriStr)) {
        ::log("ERROR: views:// URI is not valid UTF-16");
        return;
    }

    
    // Extract the path after "views://"
    std::string path;
    if (uriStr.length() > 8) {
        path = normalizeViewsRelativePath(uriStr);
    } else {
        path = "index.html"; // Default
    }
    
    std::string responseData;
    std::string mimeType = "text/html";
    
    if (path == "internal/index.html") {
        // Handle internal HTML content using stored content
        ::log("DEBUG Windows: Handling views://internal/index.html");
        const char* htmlContent = getWebviewHTMLContent(webviewId);
        if (htmlContent && strlen(htmlContent) > 0) {
            responseData = std::string(htmlContent);
            free((void*)htmlContent); // Free the strdup'd memory
            ::log("DEBUG Windows: Retrieved HTML content from storage");
        } else {
            responseData = "<html><body><h1>No content set</h1></body></html>";
            ::log("DEBUG Windows: No HTML content found, using fallback");
        }
        mimeType = "text/html";
    } else {
        // Handle other file requests
        responseData = loadViewsFile(path);
        mimeType = getMimeTypeForFile(path);
        
        if (responseData.empty()) {
            responseData = "<html><body><h1>404 - Views file not found</h1><p>Path: " + path + "</p></body></html>";
            mimeType = "text/html";
            ::log("Views file not found, returning 404");
        }
    }
    
    // sprintf_s(logMsg, "Response data length: %zu bytes, MIME type: %s", responseData.length(), mimeType.c_str());
    // log(logMsg);
    
    // Create the response using the global environment
    if (!g_environment) {
        ::log("ERROR: No global environment available for creating response");
        return;
    }
    
    try {
        // Create memory stream first
        ComPtr<IStream> stream;
        HGLOBAL hGlobal = GlobalAlloc(GMEM_MOVEABLE, responseData.length());
        if (!hGlobal) {
            ::log("ERROR: Failed to allocate global memory");
            return;
        }
        
        void* pData = GlobalLock(hGlobal);
        if (!pData) {
            GlobalFree(hGlobal);
            ::log("ERROR: Failed to lock global memory");
            return;
        }
        
        memcpy(pData, responseData.c_str(), responseData.length());
        GlobalUnlock(hGlobal);
        
        HRESULT streamResult = CreateStreamOnHGlobal(hGlobal, TRUE, &stream);
        if (FAILED(streamResult)) {
            GlobalFree(hGlobal);
            ::log("ERROR: Failed to create stream on global");
            return;
        }
        
        // Create the response
        ComPtr<ICoreWebView2WebResourceResponse> response;
        std::wstring mimeTypeW;
        if (!electrobun::utf8ToWide(mimeType, mimeTypeW)) {
            mimeTypeW = L"application/octet-stream";
        }
        std::wstring headers = L"Content-Type: " + mimeTypeW + L"\r\nAccess-Control-Allow-Origin: *";
        
        HRESULT responseResult = g_environment->CreateWebResourceResponse(
            stream.Get(),               // content stream
            200,                       // status code
            L"OK",                     // reason phrase
            headers.c_str(),           // headers
            &response);
        
        if (FAILED(responseResult)) {
            ::log("ERROR: Failed to create web resource response");
            return;
        }
        
        // Set the response
        HRESULT setResult = args->put_Response(response.Get());
        if (FAILED(setResult)) {
            ::log("ERROR: Failed to set response");
            return;
        }
        
        
    } catch (...) {
        ::log("ERROR: Exception occurred while creating response");
    }
}

// Helper functions
std::string loadViewsFile(const std::string& path) {
    const std::filesystem::path resourcesDir =
        electrobun::windowsResourcesDirectory();
    if (resourcesDir.empty()) {
        ::log("ERROR loadViewsFile: Failed to resolve Resources directory");
        return "";
    }

    const std::filesystem::path asarPath = resourcesDir / L"app.asar";
    const std::string asarPathLog = electrobun::windowsPathForLog(asarPath);

    // Check if ASAR archive exists
    if (electrobun::windowsRegularFileExists(asarPath)) {
        // Thread-safe lazy-load ASAR archive on first use
        std::call_once(g_asarArchiveInitFlag, [asarPath, asarPathLog]() {
            g_asarArchive = AsarArchive::open(asarPath);
            if (g_asarArchive) {
                ::log("DEBUG loadViewsFile: Opened ASAR archive at " + asarPathLog);
            } else {
                ::log("ERROR loadViewsFile: Failed to open ASAR archive at " + asarPathLog);
            }
        });

        // If ASAR archive is loaded, try to read from it
        if (g_asarArchive) {
            // The ASAR contains the entire app directory, so prepend "views/" to the path
            std::string asarFilePath = "views/" + path;

            // Protect ASAR read operations with mutex to prevent race conditions
            // when multiple assets are requested concurrently
            std::vector<uint8_t> fileData;
            {
                std::lock_guard<std::mutex> lock(g_asarReadMutex);
                fileData = g_asarArchive->readFile(asarFilePath);
            }

            if (!fileData.empty()) {
                ::log("DEBUG loadViewsFile: Read " + std::to_string(fileData.size()) + " bytes from ASAR for " + path);
                return std::string(fileData.begin(), fileData.end());
            } else {
                ::log("DEBUG loadViewsFile: File not found in ASAR: " + path);
                // Fall through to flat file reading
            }
        }
    }

    // Fallback: Read from flat file system (for non-ASAR builds or missing files)
    std::wstring wideRelativePath;
    if (!electrobun::utf8ToWide(path, wideRelativePath)) {
        ::log("ERROR loadViewsFile: Relative path is not valid UTF-8");
        return "";
    }
    const std::filesystem::path fullPath =
        resourcesDir / L"app" / L"views" /
        std::filesystem::path(wideRelativePath);
    const std::string fullPathLog = electrobun::windowsPathForLog(fullPath);

    ::log("DEBUG loadViewsFile: Attempting flat file read: " + fullPathLog);

    std::string content;
    if (!electrobun::readWindowsBinaryFile(fullPath, content)) {
        ::log("ERROR: Could not open views file: " + fullPathLog);
        return "";
    }
    return content;
}

// Shared MIME type detection function
// Based on Bun-compatible runtime file types and web development standards
std::string getMimeTypeForFile(const std::string& path) {
    // Web/Code Files (Bun native support)
    if (path.find(".html") != std::string::npos || path.find(".htm") != std::string::npos) {
        return "text/html";
    } else if (path.find(".js") != std::string::npos || path.find(".mjs") != std::string::npos || path.find(".cjs") != std::string::npos) {
        return "text/javascript";
    } else if (path.find(".ts") != std::string::npos || path.find(".mts") != std::string::npos || path.find(".cts") != std::string::npos) {
        return "text/typescript";
    } else if (path.find(".jsx") != std::string::npos) {
        return "text/jsx";
    } else if (path.find(".tsx") != std::string::npos) {
        return "text/tsx";
    } else if (path.find(".css") != std::string::npos) {
        return "text/css";
    } else if (path.find(".json") != std::string::npos) {
        return "application/json";
    } else if (path.find(".xml") != std::string::npos) {
        return "application/xml";
    } else if (path.find(".md") != std::string::npos) {
        return "text/markdown";
    } else if (path.find(".txt") != std::string::npos) {
        return "text/plain";
    } else if (path.find(".toml") != std::string::npos) {
        return "application/toml";
    } else if (path.find(".yaml") != std::string::npos || path.find(".yml") != std::string::npos) {
        return "application/x-yaml";
    
    // Image Files
    } else if (path.find(".png") != std::string::npos) {
        return "image/png";
    } else if (path.find(".jpg") != std::string::npos || path.find(".jpeg") != std::string::npos) {
        return "image/jpeg";
    } else if (path.find(".gif") != std::string::npos) {
        return "image/gif";
    } else if (path.find(".webp") != std::string::npos) {
        return "image/webp";
    } else if (path.find(".svg") != std::string::npos) {
        return "image/svg+xml";
    } else if (path.find(".ico") != std::string::npos) {
        return "image/x-icon";
    } else if (path.find(".avif") != std::string::npos) {
        return "image/avif";
    
    // Font Files
    } else if (path.find(".woff") != std::string::npos) {
        return "font/woff";
    } else if (path.find(".woff2") != std::string::npos) {
        return "font/woff2";
    } else if (path.find(".ttf") != std::string::npos) {
        return "font/ttf";
    } else if (path.find(".otf") != std::string::npos) {
        return "font/otf";
    
    // Media Files
    } else if (path.find(".mp3") != std::string::npos) {
        return "audio/mpeg";
    } else if (path.find(".mp4") != std::string::npos) {
        return "video/mp4";
    } else if (path.find(".webm") != std::string::npos) {
        return "video/webm";
    } else if (path.find(".ogg") != std::string::npos) {
        return "audio/ogg";
    } else if (path.find(".wav") != std::string::npos) {
        return "audio/wav";
    
    // Document Files
    } else if (path.find(".pdf") != std::string::npos) {
        return "application/pdf";
    
    // WebAssembly (Bun support)
    } else if (path.find(".wasm") != std::string::npos) {
        return "application/wasm";
    
    // Compressed Files
    } else if (path.find(".zip") != std::string::npos) {
        return "application/zip";
    } else if (path.find(".gz") != std::string::npos) {
        return "application/gzip";
    }

    return "application/octet-stream"; // default
}

/*
 * =============================================================================
 * GLOBAL KEYBOARD SHORTCUTS
 * =============================================================================
 */

// Callback type for global shortcut triggers
typedef void (*GlobalShortcutCallback)(const char* accelerator);
static GlobalShortcutCallback g_globalShortcutCallback = nullptr;

// Custom Windows messages for hotkey thread communication
#define WM_REGISTER_HOTKEY (WM_USER + 100)
#define WM_UNREGISTER_HOTKEY (WM_USER + 101)
#define WM_UNREGISTER_ALL_HOTKEYS (WM_USER + 102)

// Structure to pass hotkey registration data between threads
struct HotkeyRegisterData {
    int hotkeyId;
    UINT modifiers;
    UINT vkCode;
    std::string accelerator;
    BOOL* result;  // Output: success/failure
    HANDLE completionEvent;  // Signal when operation is complete
};

// Storage for registered shortcuts: accelerator string -> hotkey ID
static std::map<std::string, int> g_globalShortcuts;
static std::map<int, std::string> g_hotkeyIdToAccelerator;
static int g_nextHotkeyId = 1;
static HWND g_hotkeyWindow = NULL;
static std::thread g_hotkeyThread;
static bool g_hotkeyThreadRunning = false;
static std::mutex g_hotkeyMutex;  // Protect access to g_globalShortcuts and g_hotkeyIdToAccelerator
static std::mutex g_hotkeyThreadMutex;

// Helper to parse virtual key code from key string
static UINT getVirtualKeyCode(const std::string& key) {
    std::string lowerKey = key;
    std::transform(lowerKey.begin(), lowerKey.end(), lowerKey.begin(), ::tolower);

    // Letters
    if (lowerKey.length() == 1 && lowerKey[0] >= 'a' && lowerKey[0] <= 'z') {
        return 'A' + (lowerKey[0] - 'a');
    }
    // Numbers
    if (lowerKey.length() == 1 && lowerKey[0] >= '0' && lowerKey[0] <= '9') {
        return '0' + (lowerKey[0] - '0');
    }
    // Function keys
    if (lowerKey[0] == 'f' && lowerKey.length() >= 2) {
        int fNum = std::stoi(lowerKey.substr(1));
        if (fNum >= 1 && fNum <= 24) return VK_F1 + (fNum - 1);
    }
    // Special keys
    if (lowerKey == "space" || lowerKey == " ") return VK_SPACE;
    if (lowerKey == "return" || lowerKey == "enter") return VK_RETURN;
    if (lowerKey == "tab") return VK_TAB;
    if (lowerKey == "escape" || lowerKey == "esc") return VK_ESCAPE;
    if (lowerKey == "backspace") return VK_BACK;
    if (lowerKey == "delete") return VK_DELETE;
    if (lowerKey == "up") return VK_UP;
    if (lowerKey == "down") return VK_DOWN;
    if (lowerKey == "left") return VK_LEFT;
    if (lowerKey == "right") return VK_RIGHT;
    if (lowerKey == "home") return VK_HOME;
    if (lowerKey == "end") return VK_END;
    if (lowerKey == "pageup") return VK_PRIOR;
    if (lowerKey == "pagedown") return VK_NEXT;
    // Symbols
    if (lowerKey == "-") return VK_OEM_MINUS;
    if (lowerKey == "=") return VK_OEM_PLUS;
    if (lowerKey == "[") return VK_OEM_4;
    if (lowerKey == "]") return VK_OEM_6;
    if (lowerKey == "\\") return VK_OEM_5;
    if (lowerKey == ";") return VK_OEM_1;
    if (lowerKey == "'") return VK_OEM_7;
    if (lowerKey == ",") return VK_OEM_COMMA;
    if (lowerKey == ".") return VK_OEM_PERIOD;
    if (lowerKey == "/") return VK_OEM_2;
    if (lowerKey == "`") return VK_OEM_3;

    return 0;
}

// Parse modifiers from accelerator string for global shortcuts using the
// shared cross-platform parser. Returns MOD_CONTROL, MOD_ALT, MOD_SHIFT flags.
static UINT parseModifiers(const std::string& accelerator, std::string& outKey) {
    auto parts = electrobun::parseAccelerator(accelerator);
    outKey = parts.key;

    UINT modifiers = 0;
    if (parts.commandOrControl || parts.command || parts.control) modifiers |= MOD_CONTROL;
    if (parts.alt)                                                modifiers |= MOD_ALT;
    if (parts.shift)                                              modifiers |= MOD_SHIFT;
    if (parts.super)                                              modifiers |= MOD_WIN;
    return modifiers;
}

// Window procedure for hotkey window
static LRESULT CALLBACK HotkeyWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == WM_HOTKEY) {
        int hotkeyId = (int)wParam;
        std::lock_guard<std::mutex> lock(g_hotkeyMutex);
        auto it = g_hotkeyIdToAccelerator.find(hotkeyId);
        if (it != g_hotkeyIdToAccelerator.end() && g_globalShortcutCallback) {
            g_globalShortcutCallback(it->second.c_str());
        }
        return 0;
    }
    else if (msg == WM_REGISTER_HOTKEY) {
        HotkeyRegisterData* data = reinterpret_cast<HotkeyRegisterData*>(lParam);
        BOOL success = RegisterHotKey(hwnd, data->hotkeyId, data->modifiers, data->vkCode);
        if (success) {
            std::lock_guard<std::mutex> lock(g_hotkeyMutex);
            g_globalShortcuts[data->accelerator] = data->hotkeyId;
            g_hotkeyIdToAccelerator[data->hotkeyId] = data->accelerator;
            ::log("GlobalShortcut registered successfully: '" + data->accelerator + "' (id=" + std::to_string(data->hotkeyId) + ", total=" + std::to_string(g_globalShortcuts.size()) + ")");
        } else {
            DWORD error = GetLastError();
            ::log("ERROR: Failed to register hotkey '" + data->accelerator + "' - Win32 error: " + std::to_string(error));
        }
        *data->result = success;
        SetEvent(data->completionEvent);
        return 0;
    }
    else if (msg == WM_UNREGISTER_HOTKEY) {
        int hotkeyId = (int)wParam;
        UnregisterHotKey(hwnd, hotkeyId);
        return 0;
    }
    else if (msg == WM_UNREGISTER_ALL_HOTKEYS) {
        std::lock_guard<std::mutex> lock(g_hotkeyMutex);
        for (const auto& pair : g_globalShortcuts) {
            UnregisterHotKey(hwnd, pair.second);
        }
        g_globalShortcuts.clear();
        g_hotkeyIdToAccelerator.clear();
        ::log("GlobalShortcut: Unregistered all shortcuts");
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

// Message loop thread for hotkey window
static void hotkeyMessageLoop() {
    // Create a message-only window
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(WNDCLASSEXW);
    wc.lpfnWndProc = HotkeyWndProc;
    wc.hInstance = GetModuleHandle(NULL);
    wc.lpszClassName = L"ElectrobunHotkeyWindow";

    RegisterClassExW(&wc);

    g_hotkeyWindow = CreateWindowExW(0, L"ElectrobunHotkeyWindow", L"",
        0, 0, 0, 0, 0, HWND_MESSAGE, NULL, GetModuleHandle(NULL), NULL);

    if (!g_hotkeyWindow) {
        ::log("ERROR: Failed to create hotkey window");
        return;
    }

    MSG msg;
    while (g_hotkeyThreadRunning && GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    DestroyWindow(g_hotkeyWindow);
    g_hotkeyWindow = NULL;
}

static void ensureHotkeyThreadRunning() {
    std::lock_guard<std::mutex> lock(g_hotkeyThreadMutex);
    if (g_hotkeyThreadRunning) {
        return;
    }

    g_hotkeyThreadRunning = true;
    g_hotkeyThread = std::thread(hotkeyMessageLoop);
    g_hotkeyThread.detach();
}

// Set the callback for global shortcut events
extern "C" ELECTROBUN_EXPORT void setGlobalShortcutCallback(GlobalShortcutCallback callback) {
    g_globalShortcutCallback = callback;

    // Start the hotkey message loop thread if not running
    if (callback) {
        ensureHotkeyThreadRunning();
        // Wait for window to be created
        while (!g_hotkeyWindow && g_hotkeyThreadRunning) {
            Sleep(10);
        }
    }
}

// Register a global keyboard shortcut
extern "C" ELECTROBUN_EXPORT BOOL registerGlobalShortcut(const char* accelerator) {
    if (!accelerator) {
        ::log("ERROR: Cannot register shortcut - invalid accelerator");
        return FALSE;
    }

    ensureHotkeyThreadRunning();

    // Wait for hotkey window to be ready (with timeout)
    int waitCount = 0;
    const int maxWaitMs = 5000; // 5 second timeout

    while (!g_hotkeyWindow && waitCount < maxWaitMs) {
        Sleep(10);
        waitCount += 10;
    }

    if (!g_hotkeyWindow) {
        ::log("ERROR: Cannot register shortcut - hotkey window not ready after " + std::to_string(waitCount) + "ms");
        return FALSE;
    }

    std::string accelStr(accelerator);

    // Check if already registered (with mutex protection)
    {
        std::lock_guard<std::mutex> lock(g_hotkeyMutex);
        if (g_globalShortcuts.find(accelStr) != g_globalShortcuts.end()) {
            ::log("GlobalShortcut already registered: " + accelStr);
            return FALSE;
        }
    }

    // Parse the accelerator
    std::string key;
    UINT modifiers = parseModifiers(accelStr, key);
    UINT vkCode = getVirtualKeyCode(key);

    if (vkCode == 0) {
        ::log("ERROR: Unknown key: " + key);
        return FALSE;
    }

    // Prepare registration data
    int hotkeyId = g_nextHotkeyId++;
    BOOL result = FALSE;
    HANDLE completionEvent = CreateEvent(NULL, FALSE, FALSE, NULL);

    HotkeyRegisterData data;
    data.hotkeyId = hotkeyId;
    data.modifiers = modifiers | MOD_NOREPEAT;
    data.vkCode = vkCode;
    data.accelerator = accelStr;
    data.result = &result;
    data.completionEvent = completionEvent;

    ::log("GlobalShortcut: Posting registration request for '" + accelStr + "' with modifiers=" + std::to_string(modifiers) + " vkCode=" + std::to_string(vkCode));

    // Post message to hotkey thread to register the hotkey
    PostMessage(g_hotkeyWindow, WM_REGISTER_HOTKEY, 0, reinterpret_cast<LPARAM>(&data));

    // Wait for registration to complete (with timeout)
    DWORD waitResult = WaitForSingleObject(completionEvent, 5000);
    CloseHandle(completionEvent);

    if (waitResult != WAIT_OBJECT_0) {
        ::log("ERROR: Registration timeout for '" + accelStr + "'");
        return FALSE;
    }

    return result;
}

// Unregister a global keyboard shortcut
extern "C" ELECTROBUN_EXPORT BOOL unregisterGlobalShortcut(const char* accelerator) {
    if (!accelerator) return FALSE;

    std::string accelStr(accelerator);
    int hotkeyId = -1;

    {
        std::lock_guard<std::mutex> lock(g_hotkeyMutex);
        auto it = g_globalShortcuts.find(accelStr);
        if (it != g_globalShortcuts.end()) {
            hotkeyId = it->second;
            g_hotkeyIdToAccelerator.erase(hotkeyId);
            g_globalShortcuts.erase(it);
        }
    }

    if (hotkeyId != -1 && g_hotkeyWindow) {
        PostMessage(g_hotkeyWindow, WM_UNREGISTER_HOTKEY, hotkeyId, 0);
        ::log("GlobalShortcut unregistered: " + accelStr);
        return TRUE;
    }

    return FALSE;
}

// Unregister all global keyboard shortcuts
extern "C" ELECTROBUN_EXPORT void unregisterAllGlobalShortcuts() {
    std::vector<int> hotkeyIds;
    {
        std::lock_guard<std::mutex> lock(g_hotkeyMutex);
        for (const auto& pair : g_globalShortcuts) {
            hotkeyIds.push_back(pair.second);
        }
        g_globalShortcuts.clear();
        g_hotkeyIdToAccelerator.clear();
    }

    if (g_hotkeyWindow) {
        for (int hotkeyId : hotkeyIds) {
            PostMessage(g_hotkeyWindow, WM_UNREGISTER_HOTKEY, hotkeyId, 0);
        }
    }
    ::log("GlobalShortcut: Unregistered all shortcuts");
}

// Check if a shortcut is registered
extern "C" ELECTROBUN_EXPORT BOOL isGlobalShortcutRegistered(const char* accelerator) {
    if (!accelerator) return FALSE;

    std::string accelStr(accelerator);
    std::lock_guard<std::mutex> lock(g_hotkeyMutex);
    bool found = g_globalShortcuts.find(accelStr) != g_globalShortcuts.end();
    ::log("GlobalShortcut.isRegistered: Checking '" + accelStr + "' - " + (found ? "FOUND" : "NOT FOUND") + " (total shortcuts=" + std::to_string(g_globalShortcuts.size()) + ")");
    return found;
}

/*
 * =============================================================================
 * SCREEN API
 * =============================================================================
 */

static std::string serializeWindowsDisplay(
    const electrobun::WindowsLogicalMonitor& monitor
) {
    const double scaleFactor = static_cast<double>(monitor.dpi) /
        electrobun::kWindowsDefaultDpi;
    const RECT& bounds = monitor.logicalBounds;
    const RECT& workArea = monitor.logicalWorkArea;
    std::ostringstream json;
    json << "{";
    json << "\"id\":" << reinterpret_cast<uintptr_t>(monitor.handle) << ",";
    json << "\"bounds\":{";
    json << "\"x\":" << bounds.left << ",";
    json << "\"y\":" << bounds.top << ",";
    json << "\"width\":" << (bounds.right - bounds.left) << ",";
    json << "\"height\":" << (bounds.bottom - bounds.top);
    json << "},";
    json << "\"workArea\":{";
    json << "\"x\":" << workArea.left << ",";
    json << "\"y\":" << workArea.top << ",";
    json << "\"width\":" << (workArea.right - workArea.left) << ",";
    json << "\"height\":" << (workArea.bottom - workArea.top);
    json << "},";
    json << "\"scaleFactor\":" << scaleFactor << ",";
    json << "\"isPrimary\":" << (monitor.primary ? "true" : "false");
    json << "}";
    return json.str();
}

// Get all displays as JSON array
extern "C" ELECTROBUN_EXPORT const char* getAllDisplays() {
    const auto monitors = electrobun::windowsLogicalMonitors();
    std::ostringstream result;
    result << "[";
    for (size_t i = 0; i < monitors.size(); ++i) {
        if (i > 0) result << ",";
        result << serializeWindowsDisplay(monitors[i]);
    }
    result << "]";
    return _strdup(result.str().c_str());
}

// Get primary display as JSON
extern "C" ELECTROBUN_EXPORT const char* getPrimaryDisplay() {
    const auto monitors = electrobun::windowsLogicalMonitors();
    for (const auto& monitor : monitors) {
        if (monitor.primary) {
            return _strdup(serializeWindowsDisplay(monitor).c_str());
        }
    }
    return _strdup("{}");
}

// Get current cursor position as JSON: {"x": 123, "y": 456}
extern "C" ELECTROBUN_EXPORT const char* getCursorScreenPoint() {
    static thread_local std::string resultStorage;

    POINT cursorPos;
    if (GetCursorPos(&cursorPos)) {
        const HMONITOR monitor = MonitorFromPoint(
            cursorPos, MONITOR_DEFAULTTONEAREST);
        const auto logicalMonitor =
            electrobun::windowsMonitorForHandle(monitor);
        const POINT logicalCursor =
            electrobun::physicalScreenPointToLogical(
                cursorPos.x, cursorPos.y, logicalMonitor);
        std::ostringstream json;
        json << "{\"x\":" << logicalCursor.x
             << ",\"y\":" << logicalCursor.y << "}";
        resultStorage = json.str();
    } else {
        resultStorage = "{\"x\":0,\"y\":0}";
    }

    return resultStorage.c_str();
}

extern "C" ELECTROBUN_EXPORT bool captureScreenRegion(
    double x,
    double y,
    uint32_t width,
    uint32_t height,
    uint8_t* out_rgba,
    uint64_t out_len
) {
    if (!out_rgba || width == 0 || height == 0 ||
        !std::isfinite(x) || !std::isfinite(y)) {
        return false;
    }

    const uint64_t pixelCount =
        static_cast<uint64_t>(width) * static_cast<uint64_t>(height);
    if (pixelCount > std::numeric_limits<uint64_t>::max() / 4) {
        return false;
    }
    const uint64_t requiredLength = pixelCount * 4;
    if (out_len != requiredLength) return false;

    const auto monitors = electrobun::windowsLogicalMonitors();
    if (monitors.empty()) return false;

    const auto monitorForLogicalPoint = [&monitors](
        double logicalX,
        double logicalY
    ) -> const electrobun::WindowsLogicalMonitor* {
        if (!std::isfinite(logicalX) || !std::isfinite(logicalY) ||
            logicalX < std::numeric_limits<LONG>::min() ||
            logicalX > std::numeric_limits<LONG>::max() ||
            logicalY < std::numeric_limits<LONG>::min() ||
            logicalY > std::numeric_limits<LONG>::max()) {
            return nullptr;
        }

        const LONG roundedX = static_cast<LONG>(std::lround(logicalX));
        const LONG roundedY = static_cast<LONG>(std::lround(logicalY));
        const electrobun::WindowsLogicalMonitor* firstMatch = nullptr;
        for (const auto& monitor : monitors) {
            if (!electrobun::pointInRectInclusive(
                    monitor.logicalBounds, roundedX, roundedY)) {
                continue;
            }
            if (monitor.primary) return &monitor;
            if (!firstMatch) firstMatch = &monitor;
        }
        return firstMatch;
    };

    HDC screen = GetDC(nullptr);
    if (!screen) return false;

    bool succeeded = true;
    for (uint32_t row = 0; row < height && succeeded; ++row) {
        for (uint32_t column = 0; column < width; ++column) {
            const double logicalX = x + static_cast<double>(column);
            const double logicalY = y + static_cast<double>(row);
            const auto* monitor =
                monitorForLogicalPoint(logicalX, logicalY);
            if (!monitor) {
                succeeded = false;
                break;
            }

            const POINT physical =
                electrobun::logicalScreenPointToPhysical(
                    logicalX, logicalY, *monitor);
            const COLORREF color = GetPixel(screen, physical.x, physical.y);
            if (color == CLR_INVALID) {
                succeeded = false;
                break;
            }

            const uint64_t outputIndex =
                (static_cast<uint64_t>(row) * width + column) * 4;
            out_rgba[outputIndex] = GetRValue(color);
            out_rgba[outputIndex + 1] = GetGValue(color);
            out_rgba[outputIndex + 2] = GetBValue(color);
            out_rgba[outputIndex + 3] = 255;
        }
    }

    ReleaseDC(nullptr, screen);
    return succeeded;
}

extern "C" ELECTROBUN_EXPORT uint64_t getMouseButtons() {
    uint64_t buttons = 0;
    if (GetAsyncKeyState(VK_LBUTTON) & 0x8000) buttons |= 1ull << 0;
    if (GetAsyncKeyState(VK_RBUTTON) & 0x8000) buttons |= 1ull << 1;
    if (GetAsyncKeyState(VK_MBUTTON) & 0x8000) buttons |= 1ull << 2;
    return buttons;
}

/*
 * =============================================================================
 * COOKIE MANAGEMENT API
 * =============================================================================
 */

// Helper to find a WebView2View by webview ID
static WebView2View* findWebView2ById(uint32_t webviewId) {
    for (auto& pair : g_webview2Views) {
        WebView2View* view = static_cast<WebView2View*>(pair.second);
        if (view && view->webviewId == webviewId) {
            return view;
        }
    }
    return nullptr;
}

// Get cookies for a webview (WebView2)
// Note: WebView2 requires a live webview to access cookies. Pass webviewId of an existing webview.
// filterJson: {"url": "https://example.com"} or {} for all
extern "C" ELECTROBUN_EXPORT const char* sessionGetCookies(const char* partitionIdentifier, const char* filterJson) {
    // For WebView2, we need a webview to access cookies
    // We'll try to find any webview with the matching partition
    // For now, return empty array - full implementation requires webview access

    std::string result = "[]";

    // Parse filter to get URL
    std::string filterStr = filterJson ? filterJson : "{}";
    std::string filterUrl;

    // Simple JSON parsing for url field
    size_t urlPos = filterStr.find("\"url\"");
    if (urlPos != std::string::npos) {
        size_t colonPos = filterStr.find(':', urlPos);
        size_t quoteStart = filterStr.find('"', colonPos);
        size_t quoteEnd = filterStr.find('"', quoteStart + 1);
        if (quoteStart != std::string::npos && quoteEnd != std::string::npos) {
            filterUrl = filterStr.substr(quoteStart + 1, quoteEnd - quoteStart - 1);
        }
    }

    // Find a WebView2 instance (ideally matching partition)
    WebView2View* view = nullptr;
    for (auto& pair : g_webview2Views) {
        if (pair.second) {
            view = static_cast<WebView2View*>(pair.second);
            break; // Use first available view
        }
    }

    if (!view || !view->getWebView()) {
        return _strdup("[]");
    }

    // Get cookie manager
    ComPtr<ICoreWebView2_2> webview2;
    if (FAILED(view->getWebView()->QueryInterface(IID_PPV_ARGS(&webview2)))) {
        return _strdup("[]");
    }

    ComPtr<ICoreWebView2CookieManager> cookieManager;
    if (FAILED(webview2->get_CookieManager(&cookieManager)) || !cookieManager) {
        return _strdup("[]");
    }

    std::wstring wFilterUrl;
    if (!filterUrl.empty() &&
        !electrobun::utf8ToWide(filterUrl, wFilterUrl)) {
        return _strdup("[]");
    }

    // Get cookies synchronously using event
    std::string cookiesJson = "[]";
    HANDLE event = CreateEvent(NULL, FALSE, FALSE, NULL);

    LPCWSTR uri = filterUrl.empty() ? nullptr : wFilterUrl.c_str();

    cookieManager->GetCookies(uri,
        Callback<ICoreWebView2GetCookiesCompletedHandler>(
            [&cookiesJson, event](HRESULT result, ICoreWebView2CookieList* cookieList) -> HRESULT {
                if (SUCCEEDED(result) && cookieList) {
                    UINT count;
                    cookieList->get_Count(&count);

                    std::ostringstream json;
                    json << "[";
                    for (UINT i = 0; i < count; i++) {
                        ComPtr<ICoreWebView2Cookie> cookie;
                        if (SUCCEEDED(cookieList->GetValueAtIndex(i, &cookie))) {
                            LPWSTR name, value, domain, path;
                            BOOL secure, httpOnly;
                            double expires;

                            cookie->get_Name(&name);
                            cookie->get_Value(&value);
                            cookie->get_Domain(&domain);
                            cookie->get_Path(&path);
                            cookie->get_IsSecure(&secure);
                            cookie->get_IsHttpOnly(&httpOnly);
                            cookie->get_Expires(&expires);

                            // Convert to UTF-8
                            auto toUtf8 = [](LPWSTR wstr) -> std::string {
                                if (!wstr) return "";
                                std::string str;
                                electrobun::wideToUtf8(wstr, str);
                                return str;
                            };

                            if (i > 0) json << ",";
                            json << "{";
                            json << "\"name\":\"" << toUtf8(name) << "\",";
                            json << "\"value\":\"" << toUtf8(value) << "\",";
                            json << "\"domain\":\"" << toUtf8(domain) << "\",";
                            json << "\"path\":\"" << toUtf8(path) << "\",";
                            json << "\"secure\":" << (secure ? "true" : "false") << ",";
                            json << "\"httpOnly\":" << (httpOnly ? "true" : "false");
                            if (expires > 0) {
                                json << ",\"expirationDate\":" << expires;
                            }
                            json << "}";

                            CoTaskMemFree(name);
                            CoTaskMemFree(value);
                            CoTaskMemFree(domain);
                            CoTaskMemFree(path);
                        }
                    }
                    json << "]";
                    cookiesJson = json.str();
                }
                SetEvent(event);
                return S_OK;
            }).Get());

    WaitForSingleObject(event, 5000);
    CloseHandle(event);

    return _strdup(cookiesJson.c_str());
}

// Set a cookie (WebView2)
extern "C" ELECTROBUN_EXPORT bool sessionSetCookie(const char* partitionIdentifier, const char* cookieJson) {
    if (!cookieJson) return false;

    // Find a WebView2 instance
    WebView2View* view = nullptr;
    for (auto& pair : g_webview2Views) {
        if (pair.second) {
            view = static_cast<WebView2View*>(pair.second);
            break;
        }
    }

    if (!view || !view->getWebView()) {
        return false;
    }

    // Get cookie manager
    ComPtr<ICoreWebView2_2> webview2;
    if (FAILED(view->getWebView()->QueryInterface(IID_PPV_ARGS(&webview2)))) {
        return false;
    }

    ComPtr<ICoreWebView2CookieManager> cookieManager;
    if (FAILED(webview2->get_CookieManager(&cookieManager)) || !cookieManager) {
        return false;
    }

    // Parse JSON
    std::string jsonStr = cookieJson;
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
        return jsonStr.find("true", pos) < jsonStr.find(',', pos);
    };

    auto extractDouble = [&jsonStr](const std::string& key) -> double {
        std::string searchKey = "\"" + key + "\"";
        size_t pos = jsonStr.find(searchKey);
        if (pos == std::string::npos) return 0;
        size_t colonPos = jsonStr.find(':', pos);
        size_t numStart = colonPos + 1;
        while (numStart < jsonStr.size() && (jsonStr[numStart] == ' ' || jsonStr[numStart] == '\t')) numStart++;
        return std::stod(jsonStr.substr(numStart));
    };

    std::string name = extractString("name");
    std::string value = extractString("value");
    std::string domain = extractString("domain");
    std::string path = extractString("path");
    std::string url = extractString("url");
    bool secure = extractBool("secure");
    bool httpOnly = extractBool("httpOnly");
    double expirationDate = extractDouble("expirationDate");

    if (name.empty() || (domain.empty() && url.empty())) {
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

    if (path.empty()) path = "/";

    std::wstring wideName;
    std::wstring wideValue;
    std::wstring wideDomain;
    std::wstring widePath;
    if (!electrobun::utf8ToWide(name, wideName) ||
        !electrobun::utf8ToWide(value, wideValue) ||
        !electrobun::utf8ToWide(domain, wideDomain) ||
        !electrobun::utf8ToWide(path, widePath)) {
        return false;
    }

    ComPtr<ICoreWebView2Cookie> cookie;
    if (FAILED(cookieManager->CreateCookie(
            wideName.c_str(),
            wideValue.c_str(),
            wideDomain.c_str(),
            widePath.c_str(),
            &cookie))) {
        return false;
    }

    cookie->put_IsSecure(secure);
    cookie->put_IsHttpOnly(httpOnly);
    if (expirationDate > 0) {
        cookie->put_Expires(expirationDate);
    }

    bool success = false;
    HANDLE event = CreateEvent(NULL, FALSE, FALSE, NULL);

    cookieManager->AddOrUpdateCookie(cookie.Get());
    success = true; // AddOrUpdateCookie doesn't have a callback

    return success;
}

// Remove a specific cookie (WebView2)
extern "C" ELECTROBUN_EXPORT bool sessionRemoveCookie(const char* partitionIdentifier, const char* urlStr, const char* cookieName) {
    if (!urlStr || !cookieName) return false;

    // Find a WebView2 instance
    WebView2View* view = nullptr;
    for (auto& pair : g_webview2Views) {
        if (pair.second) {
            view = static_cast<WebView2View*>(pair.second);
            break;
        }
    }

    if (!view || !view->getWebView()) {
        return false;
    }

    // Get cookie manager
    ComPtr<ICoreWebView2_2> webview2;
    if (FAILED(view->getWebView()->QueryInterface(IID_PPV_ARGS(&webview2)))) {
        return false;
    }

    ComPtr<ICoreWebView2CookieManager> cookieManager;
    if (FAILED(webview2->get_CookieManager(&cookieManager)) || !cookieManager) {
        return false;
    }

    std::wstring wUrl;
    std::wstring wName;
    if (!electrobun::utf8ToWide(urlStr, wUrl) ||
        !electrobun::utf8ToWide(cookieName, wName)) {
        return false;
    }

    // Get cookies matching URL, then delete the one with matching name
    bool found = false;
    HANDLE event = CreateEvent(NULL, FALSE, FALSE, NULL);

    cookieManager->GetCookies(wUrl.c_str(),
        Callback<ICoreWebView2GetCookiesCompletedHandler>(
            [&found, &wName, &cookieManager, event](HRESULT result, ICoreWebView2CookieList* cookieList) -> HRESULT {
                if (SUCCEEDED(result) && cookieList) {
                    UINT count;
                    cookieList->get_Count(&count);

                    for (UINT i = 0; i < count; i++) {
                        ComPtr<ICoreWebView2Cookie> cookie;
                        if (SUCCEEDED(cookieList->GetValueAtIndex(i, &cookie))) {
                            LPWSTR cookieName;
                            cookie->get_Name(&cookieName);
                            if (wcscmp(cookieName, wName.c_str()) == 0) {
                                cookieManager->DeleteCookie(cookie.Get());
                                found = true;
                            }
                            CoTaskMemFree(cookieName);
                        }
                    }
                }
                SetEvent(event);
                return S_OK;
            }).Get());

    WaitForSingleObject(event, 5000);
    CloseHandle(event);

    return found;
}

// Clear all cookies (WebView2)
extern "C" ELECTROBUN_EXPORT void sessionClearCookies(const char* partitionIdentifier) {
    // Find a WebView2 instance
    WebView2View* view = nullptr;
    for (auto& pair : g_webview2Views) {
        if (pair.second) {
            view = static_cast<WebView2View*>(pair.second);
            break;
        }
    }

    if (!view || !view->getWebView()) {
        return;
    }

    // Get cookie manager
    ComPtr<ICoreWebView2_2> webview2;
    if (FAILED(view->getWebView()->QueryInterface(IID_PPV_ARGS(&webview2)))) {
        return;
    }

    ComPtr<ICoreWebView2CookieManager> cookieManager;
    if (FAILED(webview2->get_CookieManager(&cookieManager)) || !cookieManager) {
        return;
    }

    // DeleteAllCookies deletes all cookies
    cookieManager->DeleteAllCookies();
}

// Clear storage data (WebView2) - uses Profile API
extern "C" ELECTROBUN_EXPORT void sessionClearStorageData(const char* partitionIdentifier, const char* storageTypesJson) {
    // Find a WebView2 instance
    WebView2View* view = nullptr;
    for (auto& pair : g_webview2Views) {
        if (pair.second) {
            view = static_cast<WebView2View*>(pair.second);
            break;
        }
    }

    if (!view || !view->getWebView()) {
        return;
    }

    // Try to get Profile interface for clearing browsing data
    ComPtr<ICoreWebView2_13> webview13;
    if (SUCCEEDED(view->getWebView()->QueryInterface(IID_PPV_ARGS(&webview13)))) {
        ComPtr<ICoreWebView2Profile> profile;
        if (SUCCEEDED(webview13->get_Profile(&profile))) {
            ComPtr<ICoreWebView2Profile2> profile2;
            if (SUCCEEDED(profile->QueryInterface(IID_PPV_ARGS(&profile2)))) {
                // Determine what to clear
                COREWEBVIEW2_BROWSING_DATA_KINDS dataKinds = COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_SITE;

                if (storageTypesJson && strlen(storageTypesJson) > 2) {
                    dataKinds = (COREWEBVIEW2_BROWSING_DATA_KINDS)0;
                    std::string types = storageTypesJson;

                    if (types.find("cookies") != std::string::npos) {
                        dataKinds = (COREWEBVIEW2_BROWSING_DATA_KINDS)(dataKinds | COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES);
                    }
                    if (types.find("cache") != std::string::npos) {
                        dataKinds = (COREWEBVIEW2_BROWSING_DATA_KINDS)(dataKinds | COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE);
                    }
                    if (types.find("localStorage") != std::string::npos ||
                        types.find("sessionStorage") != std::string::npos ||
                        types.find("indexedDB") != std::string::npos) {
                        dataKinds = (COREWEBVIEW2_BROWSING_DATA_KINDS)(dataKinds | COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_SITE);
                    }
                }

                HANDLE event = CreateEvent(NULL, FALSE, FALSE, NULL);
                profile2->ClearBrowsingData(dataKinds,
                    Callback<ICoreWebView2ClearBrowsingDataCompletedHandler>(
                        [event](HRESULT result) -> HRESULT {
                            SetEvent(event);
                            return S_OK;
                        }).Get());
                WaitForSingleObject(event, 10000);
                CloseHandle(event);
            }
        }
    }
}

// URL scheme handler - macOS only, stub for Windows
extern "C" ELECTROBUN_EXPORT void setURLOpenHandler(void (*callback)(const char*)) {
    (void)callback;
    // Not supported on Windows - stub to prevent dlopen failure
    // Windows URL protocol handling is done via registry
}

// App reopen handler - macOS only, stub for Windows
extern "C" ELECTROBUN_EXPORT void setAppReopenHandler(void (*callback)()) {
    (void)callback;
    // Not supported on Windows - stub to prevent dlopen failure
}

// Dock icon visibility - macOS only, stubs for Windows
extern "C" ELECTROBUN_EXPORT void setDockIconVisible(bool visible) {
    (void)visible;
    // Not supported on Windows - stub to prevent dlopen failure
}

extern "C" ELECTROBUN_EXPORT bool isDockIconVisible() {
    // Not supported on Windows
    return true;
}

// Window icon - Linux only, no-op for Windows
extern "C" ELECTROBUN_EXPORT void setWindowIcon(void* window, const char* iconPath) {
    // Not yet implemented on Windows
    // TODO: Implement using SetWindowIcon/LoadImage APIs
}

// DComp exported API removed — zero-copy bridge is now an internal
// implementation detail of the WGPU surface lifecycle (see
// wgpuSurfaceConfigureMainThread, wgpuSurfaceGetCurrentTextureMainThread,
// wgpuSurfacePresentMainThread).

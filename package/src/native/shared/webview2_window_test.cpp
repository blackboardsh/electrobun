#include "webview2_window.h"
#include <WebView2.h>
#include <Windows.h>
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <vector>
#include <wrl.h>
using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
struct View {
    ComPtr<ICoreWebView2Controller> controller;
    electrobun::WebView2Window window;
    HWND initial = nullptr;
};
static HWND host;
static ComPtr<ICoreWebView2Environment> environment;
static std::vector<std::unique_ptr<View>> views;
static bool done = false, failed = false;
static bool legacyControl = false;
static void check(bool ok, const char *name) {
    if (!ok)
        throw std::runtime_error(name);
}
static void hr(HRESULT result, const char *name) {
    if (FAILED(result)) {
        std::printf("HRESULT 0x%08lx: %s\n", result, name);
        throw std::runtime_error(name);
    }
}
static void createView();
// Negative control reproduces the old production lookup: the first Chrome
// descendant at the requested origin, regardless of controller ownership.
static bool raiseView(View &view) {
    if (!legacyControl)
        return view.window.bringToFront(host);
    RECT bounds = {};
    hr(view.controller->get_Bounds(&bounds), "read legacy bounds");
    struct Search {
        RECT bounds;
        HWND result;
    } search = {bounds, nullptr};
    EnumChildWindows(
        host,
        [](HWND candidate, LPARAM argument) -> BOOL {
            auto &data = *reinterpret_cast<Search *>(argument);
            wchar_t name[256] = {};
            GetClassNameW(candidate, name, 256);
            if (!wcsstr(name, L"Chrome_WidgetWin") && !wcsstr(name, L"Chrome_RenderWidgetHostHWND"))
                return TRUE;
            RECT rect = {};
            GetWindowRect(candidate, &rect);
            POINT origin = {rect.left, rect.top};
            ScreenToClient(host, &origin);
            if (abs(origin.x - data.bounds.left) >= 5 || abs(origin.y - data.bounds.top) >= 5)
                return TRUE;
            data.result = candidate;
            return FALSE;
        },
        reinterpret_cast<LPARAM>(&search));
    return search.result && SetWindowPos(search.result, HWND_TOP, 0, 0, 0, 0,
                                         SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}
static void verify() {
    auto &first = *views[0];
    auto &left = *views[1];
    auto &right = *views[2];
    const HWND firstWindow = first.window.get(host), leftWindow = left.window.get(host),
               rightWindow = right.window.get(host);
    check(firstWindow && leftWindow && rightWindow && firstWindow != leftWindow &&
              leftWindow != rightWindow && firstWindow != rightWindow,
          "distinct controller HWND associations");
    // The host and both hidden guests initially share (0,0). Put the host on
    // top first so a coordinate lookup deterministically selects the wrong HWND.
    check(first.window.bringToFront(host), "raise initial host");
    check(raiseView(left), "raise hidden zero-size child");
    check(GetWindow(host, GW_CHILD) == leftWindow, "zero-size target must be exact top sibling");
    check(right.window.setPassthrough(host, true), "zero-size right passthrough");
    check(!(GetWindowLongPtrW(firstWindow, GWL_EXSTYLE) & WS_EX_TRANSPARENT),
          "zero-size target must not change host input style");
    check(!(GetWindowLongPtrW(leftWindow, GWL_EXSTYLE) & WS_EX_TRANSPARENT),
          "zero-size target must not change sibling input style");
    check(right.window.setPassthrough(host, false), "clear zero-size right passthrough");
    RECT overlap = {30, 40, 230, 190};
    hr(left.controller->put_Bounds(overlap), "resize left");
    hr(right.controller->put_Bounds(overlap), "resize right");
    check(right.window.setPassthrough(host, true), "set right passthrough");
    check(!(GetWindowLongPtrW(firstWindow, GWL_EXSTYLE) & WS_EX_TRANSPARENT),
          "host must remain interactive");
    check(!(GetWindowLongPtrW(leftWindow, GWL_EXSTYLE) & WS_EX_TRANSPARENT),
          "overlapping left must remain interactive");
    check((GetWindowLongPtrW(rightWindow, GWL_EXSTYLE) & WS_EX_TRANSPARENT) != 0,
          "right passthrough must apply only to right");
    check(left.window.bringToFront(host), "raise left");
    check(GetWindow(host, GW_CHILD) == leftWindow, "left is exact top sibling");
    check(right.window.bringToFront(host), "raise right");
    check(GetWindow(host, GW_CHILD) == rightWindow, "right is exact top sibling");
    check(!left.window.get(firstWindow) && !left.window.bringToFront(firstWindow) &&
              !left.window.setPassthrough(firstWindow, true),
          "wrong parent must reject mutations");
    electrobun::WebView2Window conflictingOwner;
    check(FAILED(conflictingOwner.bind(left.controller.Get(), host)),
          "second owner cannot claim existing controller");
    check(left.window.get(host) == leftWindow, "failed second claim preserves real owner");
    hr(left.controller->put_IsVisible(TRUE), "reveal left");
    BOOL visible = FALSE;
    RECT actual = {};
    HWND parent = nullptr;
    hr(left.controller->get_IsVisible(&visible), "read visibility");
    hr(left.controller->get_Bounds(&actual), "read bounds");
    hr(left.controller->get_ParentWindow(&parent), "read parent");
    check(visible && EqualRect(&actual, &overlap) && parent == host,
          "reparent preserves controller operations and shared parent");
    // Retain the stale owner across actual controller destruction and replacement
    // creation. Even if Windows recycles its numeric HWND, ownership must differ.
    left.controller->Close();
    left.controller.Reset();
    check(!left.window.get(host), "removed owner association invalidated");
    std::printf("PASS: real WebView2 hidden zero-size and overlapping controller ownership, exact "
                "z-order and passthrough isolation\n");
    createView();
}
static void createView() {
    const size_t index = views.size();
    hr(environment->CreateCoreWebView2Controller(
           host,
           Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
               [index](HRESULT result, ICoreWebView2Controller *controller) -> HRESULT {
                   try {
                       hr(result, "create controller");
                       check(controller != nullptr, "controller present");
                       auto view = std::make_unique<View>();
                       view->controller = controller;
                       hr(controller->put_IsVisible(FALSE), "initial hide");
                       RECT bounds = index == 0 ? RECT{0, 0, 600, 400} : RECT{0, 0, 0, 0};
                       hr(controller->put_Bounds(bounds), "initial bounds");
                       hr(view->window.bind(controller, host),
                          "controller-specific HWND reparent probe");
                       check(view->window.get(host) != nullptr, "bound window is owned");
                       BOOL boundVisible = TRUE;
                       RECT boundFrame = {};
                       HWND boundParent = nullptr;
                       hr(controller->get_IsVisible(&boundVisible),
                          "read initial bound visibility");
                       hr(controller->get_Bounds(&boundFrame), "read initial bound frame");
                       hr(controller->get_ParentWindow(&boundParent), "read initial bound parent");
                       check(!boundVisible && EqualRect(&boundFrame, &bounds) &&
                                 boundParent == host,
                             "binding preserves initial hidden state, frame and parent without a "
                             "resize rescue");
                       view->initial = view->window.get(host);
                       std::printf("bound controller %zu child %p\n", index,
                                   view->window.get(host));
                       views.push_back(std::move(view));
                       if (index < 2)
                           createView();
                       else if (index == 2)
                           verify();
                       else {
                           check(!views[1]->window.get(host),
                                 "removed view stays unbound after recreation");
                           const HWND replacement = views[3]->window.get(host);
                           check(replacement && replacement != views[0]->window.get(host) &&
                                     replacement != views[2]->window.get(host),
                                 "replacement controller has own association");
                           check(!views[1]->window.bringToFront(host) &&
                                     !views[1]->window.setPassthrough(host, true),
                                 "stale owner cannot mutate replacement");
                           views[1]->window.reset();
                           check(views[3]->window.get(host) == replacement,
                                 "stale reset preserves replacement owner");
                           check(views[3]->window.bringToFront(host) &&
                                     GetWindow(host, GW_CHILD) == replacement,
                                 "replacement is exact top sibling");
                           check(!(GetWindowLongPtrW(replacement, GWL_EXSTYLE) & WS_EX_TRANSPARENT),
                                 "replacement input style unaffected by stale owner");
                           std::puts("PASS: destroy and recreate owner lifetime");
                           done = true;
                       }
                   } catch (const std::exception &error) {
                       std::printf("FAIL: %s\n", error.what());
                       failed = true;
                       done = true;
                   }
                   return S_OK;
               })
               .Get()),
       "start controller creation");
}
int wmain(int argc, wchar_t **argv) {
    if (argc == 2 && !wcscmp(argv[1], L"--check-runtime")) {
        LPWSTR version = nullptr;
        const HRESULT result = GetAvailableCoreWebView2BrowserVersionString(nullptr, &version);
        if (SUCCEEDED(result) && version && *version) {
            std::wprintf(L"WebView2 runtime: %ls\n", version);
            CoTaskMemFree(version);
            return 0;
        }
        if (version) CoTaskMemFree(version);
        if (result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) || SUCCEEDED(result)) {
            std::puts("WebView2 runtime is not installed");
            return 42;
        }
        std::printf("WebView2 runtime detection failed: HRESULT 0x%08lx\n", result);
        return 1;
    }
    if (argc != 2 && argc != 3)
        return 2;
    if (argc == 3) {
        if (wcscmp(argv[2], L"--legacy-coordinate-control"))
            return 2;
        legacyControl = true;
    }
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)))
        return 3;
    host =
        CreateWindowExW(0, L"STATIC", L"Private WebView2 ownership regression", WS_OVERLAPPEDWINDOW,
                        0, 0, 640, 480, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!host)
        return 3;
    HRESULT started = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, argv[1], nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [](HRESULT result, ICoreWebView2Environment *env) -> HRESULT {
                try {
                    hr(result, "create environment");
                    environment = env;
                    createView();
                } catch (const std::exception &error) {
                    std::printf("FAIL: %s\n", error.what());
                    failed = true;
                    done = true;
                }
                return S_OK;
            })
            .Get());
    if (FAILED(started)) {
        failed = true;
        done = true;
    }
    const ULONGLONG until = GetTickCount64() + 60000;
    while (!done && GetTickCount64() < until) {
        MSG message;
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        MsgWaitForMultipleObjects(0, nullptr, FALSE, 20, QS_ALLINPUT);
    }
    if (!done) {
        std::puts("FAIL: native probe timeout");
        failed = true;
    }
    for (auto &view : views) {
        view->window.reset();
        if (view->controller)
            view->controller->Close();
    }
    views.clear();
    environment.Reset();
    DestroyWindow(host);
    CoUninitialize();
    return failed ? 1 : 0;
}

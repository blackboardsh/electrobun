#pragma once

#include <Windows.h>
#include <WebView2.h>

namespace electrobun {

// WebView2 exposes its app-provided parent, but not its native child HWND.
// Bounds cannot identify that child: multiple hidden or overlapping controllers
// can have identical rectangles. While a new controller is hidden, temporarily
// give only that controller a private parent, then retain its exact child when
// restoring the normal shared parent. No layout or coordinate lookup is used.
class WebView2Window {
    static constexpr const wchar_t* ownerProperty = L"Electrobun.WebView2.WindowOwner";
    HWND child_ = nullptr;
    DWORD thread_ = 0;

public:
    WebView2Window() = default;
    WebView2Window(const WebView2Window&) = delete;
    WebView2Window& operator=(const WebView2Window&) = delete;
    ~WebView2Window() { reset(); }

    void reset() {
        if (child_ && IsWindow(child_) && GetPropW(child_, ownerProperty) == this) {
            RemovePropW(child_, ownerProperty);
        }
        child_ = nullptr;
        thread_ = 0;
    }

    HWND get(HWND parent) const {
        if (!child_ || !IsWindow(child_) || GetParent(child_) != parent ||
            GetPropW(child_, ownerProperty) != this) return nullptr;
        DWORD process = 0;
        const DWORD thread = GetWindowThreadProcessId(child_, &process);
        return process == GetCurrentProcessId() && thread == thread_ ? child_ : nullptr;
    }

    HRESULT bind(ICoreWebView2Controller* controller, HWND parent) {
        reset();
        if (!controller || !IsWindow(parent)) return E_INVALIDARG;
        const HWND probe = CreateWindowExW(
            0, L"STATIC", L"", WS_CHILD, 0, 0, 0, 0,
            parent, nullptr, GetModuleHandleW(nullptr), nullptr);
        if (!probe) return HRESULT_FROM_WIN32(GetLastError());

        const HRESULT moved = controller->put_ParentWindow(probe);
        if (FAILED(moved)) {
            DestroyWindow(probe);
            return moved;
        }
        const HWND candidate = GetWindow(probe, GW_CHILD);
        const bool soleChild = candidate && !GetWindow(candidate, GW_HWNDNEXT);
        // Always restore before destroying the probe. If restoration fails,
        // close the controller so destroying its temporary parent is safe.
        const HRESULT restored = controller->put_ParentWindow(parent);
        if (FAILED(restored)) controller->Close();
        DestroyWindow(probe);
        if (FAILED(restored)) return restored;
        if (!soleChild || !IsWindow(candidate) || GetParent(candidate) != parent) {
            return HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE);
        }
        DWORD process = 0;
        const DWORD thread = GetWindowThreadProcessId(candidate, &process);
        if (process != GetCurrentProcessId() || thread != GetCurrentThreadId() ||
            GetPropW(candidate, ownerProperty)) {
            return E_UNEXPECTED;
        }
        if (!SetPropW(candidate, ownerProperty, this)) {
            return HRESULT_FROM_WIN32(GetLastError());
        }
        child_ = candidate;
        thread_ = thread;
        return S_OK;
    }

    bool bringToFront(HWND parent) const {
        const HWND child = get(parent);
        return child && SetWindowPos(child, HWND_TOP, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    bool setPassthrough(HWND parent, bool enabled) const {
        const HWND child = get(parent);
        if (!child) return false;
        const LONG_PTR oldStyle = GetWindowLongPtrW(child, GWL_EXSTYLE);
        const LONG_PTR newStyle = enabled ? oldStyle | WS_EX_TRANSPARENT
                                         : oldStyle & ~WS_EX_TRANSPARENT;
        if (oldStyle == newStyle) return true;
        SetWindowLongPtrW(child, GWL_EXSTYLE, newStyle);
        // The previous style can legitimately be zero. WebView2's synchronous
        // style-change handler can also alter last-error, so verify the actual
        // owned window's resulting bit instead of relying on that ambiguity.
        return get(parent) == child &&
            ((GetWindowLongPtrW(child, GWL_EXSTYLE) & WS_EX_TRANSPARENT) != 0) == enabled;
    }
};

} // namespace electrobun

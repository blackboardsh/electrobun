#pragma once

#ifdef _WIN32

#include <Windows.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace electrobun {

constexpr UINT kWindowsDefaultDpi = 96;

inline UINT normalizeWindowsDpi(UINT dpi) {
    return dpi == 0 ? kWindowsDefaultDpi : dpi;
}

inline LONG logicalToPhysicalPixel(double logical, UINT dpi) {
    const double scale =
        static_cast<double>(normalizeWindowsDpi(dpi)) / kWindowsDefaultDpi;
    return static_cast<LONG>(std::lround(logical * scale));
}

inline LONG physicalToLogicalPixel(LONG physical, UINT dpi) {
    const double scale =
        static_cast<double>(kWindowsDefaultDpi) / normalizeWindowsDpi(dpi);
    return static_cast<LONG>(std::lround(static_cast<double>(physical) * scale));
}

inline double physicalToLogicalCoordinate(LONG physical, UINT dpi) {
    return static_cast<double>(physical) * kWindowsDefaultDpi /
        normalizeWindowsDpi(dpi);
}

// Scale both edges instead of scaling the size independently. This keeps
// adjacent rectangles adjacent at fractional scale factors such as 125%/150%.
inline RECT logicalToPhysicalRect(
    double x,
    double y,
    double width,
    double height,
    UINT dpi
) {
    return {
        logicalToPhysicalPixel(x, dpi),
        logicalToPhysicalPixel(y, dpi),
        logicalToPhysicalPixel(x + width, dpi),
        logicalToPhysicalPixel(y + height, dpi),
    };
}

inline RECT physicalToLogicalRect(const RECT& physical, UINT dpi) {
    return {
        physicalToLogicalPixel(physical.left, dpi),
        physicalToLogicalPixel(physical.top, dpi),
        physicalToLogicalPixel(physical.right, dpi),
        physicalToLogicalPixel(physical.bottom, dpi),
    };
}

inline bool pointInRectInclusive(const RECT& rect, LONG x, LONG y) {
    return x >= rect.left && x < rect.right &&
        y >= rect.top && y < rect.bottom;
}

inline unsigned long long squaredDistanceToRect(
    const RECT& rect,
    LONG x,
    LONG y
) {
    const long long dx = x < rect.left
        ? static_cast<long long>(rect.left) - x
        : (x >= rect.right ? static_cast<long long>(x) - rect.right + 1 : 0);
    const long long dy = y < rect.top
        ? static_cast<long long>(rect.top) - y
        : (y >= rect.bottom ? static_cast<long long>(y) - rect.bottom + 1 : 0);
    return static_cast<unsigned long long>(dx * dx + dy * dy);
}

inline UINT windowsDpiForMonitor(HMONITOR monitor) {
    if (!monitor) return kWindowsDefaultDpi;

    using GetDpiForMonitorFn = HRESULT(WINAPI*)(HMONITOR, int, UINT*, UINT*);
    static const GetDpiForMonitorFn getDpiForMonitor = []() {
        HMODULE shcore = LoadLibraryW(L"shcore.dll");
        return shcore
            ? reinterpret_cast<GetDpiForMonitorFn>(
                  GetProcAddress(shcore, "GetDpiForMonitor"))
            : nullptr;
    }();

    if (getDpiForMonitor) {
        UINT dpiX = kWindowsDefaultDpi;
        UINT dpiY = kWindowsDefaultDpi;
        // MDT_EFFECTIVE_DPI = 0. A per-monitor-aware process receives the
        // actual DPI for the requested monitor.
        if (SUCCEEDED(getDpiForMonitor(monitor, 0, &dpiX, &dpiY))) {
            return normalizeWindowsDpi(dpiX);
        }
    }

    return kWindowsDefaultDpi;
}

inline UINT windowsDpiForWindow(HWND window) {
    using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
    static const GetDpiForWindowFn getDpiForWindow = []() {
        HMODULE user32 = GetModuleHandleW(L"user32.dll");
        return user32
            ? reinterpret_cast<GetDpiForWindowFn>(
                  GetProcAddress(user32, "GetDpiForWindow"))
            : nullptr;
    }();

    if (window && getDpiForWindow) {
        const UINT dpi = getDpiForWindow(window);
        if (dpi != 0) return dpi;
    }

    return windowsDpiForMonitor(MonitorFromWindow(
        window, MONITOR_DEFAULTTOPRIMARY));
}

struct WindowsLogicalMonitor {
    HMONITOR handle = nullptr;
    RECT physicalBounds = {};
    RECT physicalWorkArea = {};
    RECT logicalBounds = {};
    RECT logicalWorkArea = {};
    UINT dpi = kWindowsDefaultDpi;
    bool primary = false;
};

inline LONG physicalToLogicalSize(LONG physical, UINT dpi) {
    if (physical <= 0) return 0;
    return static_cast<LONG>(std::ceil(
        static_cast<double>(physical) * kWindowsDefaultDpi /
        normalizeWindowsDpi(dpi)));
}

inline LONG logicalToPhysicalSize(double logical, UINT dpi) {
    if (logical <= 0) return 0;
    return static_cast<LONG>(std::ceil(
        logical * normalizeWindowsDpi(dpi) / kWindowsDefaultDpi));
}

inline LONG physicalOffsetToLogicalFloor(LONG physical, UINT dpi) {
    return static_cast<LONG>(std::floor(
        static_cast<double>(physical) * kWindowsDefaultDpi /
        normalizeWindowsDpi(dpi)));
}

inline LONG physicalOffsetToLogicalCeil(LONG physical, UINT dpi) {
    return static_cast<LONG>(std::ceil(
        static_cast<double>(physical) * kWindowsDefaultDpi /
        normalizeWindowsDpi(dpi)));
}

inline bool windowsMonitorBoundsTouch(const RECT& first, const RECT& second) {
    const bool verticalOverlap =
        std::max(first.top, second.top) <= std::min(first.bottom, second.bottom);
    const bool horizontalOverlap =
        std::max(first.left, second.left) <= std::min(first.right, second.right);
    return ((first.right == second.left || second.right == first.left) &&
            verticalOverlap) ||
        ((first.bottom == second.top || second.bottom == first.top) &&
         horizontalOverlap);
}

inline void sizeWindowsLogicalMonitor(WindowsLogicalMonitor& monitor) {
    const LONG width = physicalToLogicalSize(
        monitor.physicalBounds.right - monitor.physicalBounds.left,
        monitor.dpi);
    const LONG height = physicalToLogicalSize(
        monitor.physicalBounds.bottom - monitor.physicalBounds.top,
        monitor.dpi);
    monitor.logicalBounds.right = monitor.logicalBounds.left + width;
    monitor.logicalBounds.bottom = monitor.logicalBounds.top + height;
}

enum class WindowsMonitorPlacement {
    Top,
    Right,
    Bottom,
    Left,
};

inline WindowsMonitorPlacement windowsMonitorPlacement(
    const RECT& parent,
    const RECT& child
) {
    const LONG maxLeft = std::max(parent.left, child.left);
    const LONG maxTop = std::max(parent.top, child.top);
    const LONG minRight = std::min(parent.right, child.right);
    const LONG minBottom = std::min(parent.bottom, child.bottom);
    if (maxLeft == minRight && maxTop == minBottom) {
        if (parent.bottom == maxTop) return WindowsMonitorPlacement::Bottom;
        if (parent.left == maxLeft) return WindowsMonitorPlacement::Left;
        return WindowsMonitorPlacement::Top;
    }
    if (maxLeft == minRight) {
        return parent.left == maxLeft
            ? WindowsMonitorPlacement::Left
            : WindowsMonitorPlacement::Right;
    }
    return parent.top == maxTop
        ? WindowsMonitorPlacement::Top
        : WindowsMonitorPlacement::Bottom;
}

struct WindowsMonitorPlacementOffset {
    LONG value = 0;
    bool fromFarEdge = false;
};

inline bool windowsCoordinateInRange(LONG value, LONG begin, LONG end) {
    return value >= begin && value <= end;
}

inline WindowsMonitorPlacementOffset windowsMonitorPlacementOffset(
    const WindowsLogicalMonitor& parent,
    const WindowsLogicalMonitor& child,
    WindowsMonitorPlacement placement
) {
    LONG parentBegin;
    LONG parentEnd;
    LONG childBegin;
    LONG childEnd;
    if (placement == WindowsMonitorPlacement::Top ||
        placement == WindowsMonitorPlacement::Bottom) {
        parentBegin = parent.physicalBounds.left;
        parentEnd = parent.physicalBounds.right;
        childBegin = child.physicalBounds.left;
        childEnd = child.physicalBounds.right;
    } else {
        parentBegin = parent.physicalBounds.top;
        parentEnd = parent.physicalBounds.bottom;
        childBegin = child.physicalBounds.top;
        childEnd = child.physicalBounds.bottom;
    }

    parentEnd -= parentBegin;
    childBegin -= parentBegin;
    childEnd -= parentBegin;
    parentBegin = 0;

    WindowsMonitorPlacementOffset result;
    if (parentEnd == childEnd && parentBegin != childBegin) {
        result.fromFarEdge = true;
    } else if (windowsCoordinateInRange(childBegin, parentBegin, parentEnd)) {
        result.value = physicalOffsetToLogicalFloor(childBegin, parent.dpi);
    } else if (windowsCoordinateInRange(childEnd, parentBegin, parentEnd)) {
        result.fromFarEdge = true;
        result.value = physicalOffsetToLogicalFloor(
            parentEnd - childEnd, parent.dpi);
    } else {
        // The child spans the parent's whole perpendicular axis, so its own
        // scale defines the relative offset.
        result.value = physicalOffsetToLogicalFloor(childBegin, child.dpi);
    }
    return result;
}

inline void placeWindowsLogicalMonitor(
    const WindowsLogicalMonitor& parent,
    WindowsLogicalMonitor& child
) {
    sizeWindowsLogicalMonitor(child);
    const LONG width = child.logicalBounds.right - child.logicalBounds.left;
    const LONG height = child.logicalBounds.bottom - child.logicalBounds.top;
    const auto placement = windowsMonitorPlacement(
        parent.physicalBounds, child.physicalBounds);
    const auto placementOffset = windowsMonitorPlacementOffset(
        parent, child, placement);
    const LONG parentLength =
        placement == WindowsMonitorPlacement::Top ||
            placement == WindowsMonitorPlacement::Bottom
        ? parent.logicalBounds.right - parent.logicalBounds.left
        : parent.logicalBounds.bottom - parent.logicalBounds.top;
    const LONG childLength =
        placement == WindowsMonitorPlacement::Top ||
            placement == WindowsMonitorPlacement::Bottom
        ? width
        : height;
    const LONG offset = placementOffset.fromFarEdge
        ? parentLength - placementOffset.value - childLength
        : placementOffset.value;

    switch (placement) {
        case WindowsMonitorPlacement::Top:
            child.logicalBounds.left = parent.logicalBounds.left + offset;
            child.logicalBounds.top = parent.logicalBounds.top - height;
            break;
        case WindowsMonitorPlacement::Right:
            child.logicalBounds.left = parent.logicalBounds.right;
            child.logicalBounds.top = parent.logicalBounds.top + offset;
            break;
        case WindowsMonitorPlacement::Bottom:
            child.logicalBounds.left = parent.logicalBounds.left + offset;
            child.logicalBounds.top = parent.logicalBounds.bottom;
            break;
        case WindowsMonitorPlacement::Left:
            child.logicalBounds.left = parent.logicalBounds.left - width;
            child.logicalBounds.top = parent.logicalBounds.top + offset;
            break;
    }
    child.logicalBounds.right = child.logicalBounds.left + width;
    child.logicalBounds.bottom = child.logicalBounds.top + height;
}

// Match Chromium's primary-rooted monitor topology: scale each monitor's size,
// then preserve the touching edge with its already-placed parent. Dividing
// absolute virtual-screen coordinates independently would introduce gaps or
// overlaps whenever adjacent monitors use different scale factors.
inline void layoutWindowsLogicalMonitors(
    std::vector<WindowsLogicalMonitor>& monitors
) {
    if (monitors.empty()) return;

    size_t primaryIndex = 0;
    for (size_t index = 0; index < monitors.size(); ++index) {
        if (monitors[index].primary) {
            primaryIndex = index;
            break;
        }
    }

    auto& primary = monitors[primaryIndex];
    primary.logicalBounds.left = physicalToLogicalPixel(
        primary.physicalBounds.left, primary.dpi);
    primary.logicalBounds.top = physicalToLogicalPixel(
        primary.physicalBounds.top, primary.dpi);
    sizeWindowsLogicalMonitor(primary);

    std::vector<bool> placed(monitors.size(), false);
    placed[primaryIndex] = true;
    std::vector<size_t> availableParents = {primaryIndex};
    while (!availableParents.empty()) {
        const size_t parentIndex = availableParents.back();
        availableParents.pop_back();
        for (size_t childIndex = 0; childIndex < monitors.size(); ++childIndex) {
            if (placed[childIndex] ||
                !windowsMonitorBoundsTouch(
                    monitors[parentIndex].physicalBounds,
                    monitors[childIndex].physicalBounds)) {
                continue;
            }
            placeWindowsLogicalMonitor(
                monitors[parentIndex], monitors[childIndex]);
            placed[childIndex] = true;
            availableParents.push_back(childIndex);
        }
    }

    // Disconnected coordinates can occur transiently while Windows is applying
    // a display-layout change. Scale those relative to the virtual origin.
    for (size_t index = 0; index < monitors.size(); ++index) {
        auto& monitor = monitors[index];
        if (!placed[index]) {
            monitor.logicalBounds.left = physicalToLogicalPixel(
                monitor.physicalBounds.left, monitor.dpi);
            monitor.logicalBounds.top = physicalToLogicalPixel(
                monitor.physicalBounds.top, monitor.dpi);
            sizeWindowsLogicalMonitor(monitor);
        }

        monitor.logicalWorkArea.left = monitor.logicalBounds.left +
            physicalOffsetToLogicalFloor(
                monitor.physicalWorkArea.left - monitor.physicalBounds.left,
                monitor.dpi);
        monitor.logicalWorkArea.top = monitor.logicalBounds.top +
            physicalOffsetToLogicalFloor(
                monitor.physicalWorkArea.top - monitor.physicalBounds.top,
                monitor.dpi);
        monitor.logicalWorkArea.right = monitor.logicalBounds.left +
            physicalOffsetToLogicalCeil(
                monitor.physicalWorkArea.right - monitor.physicalBounds.left,
                monitor.dpi);
        monitor.logicalWorkArea.bottom = monitor.logicalBounds.top +
            physicalOffsetToLogicalCeil(
                monitor.physicalWorkArea.bottom - monitor.physicalBounds.top,
                monitor.dpi);
    }
}

inline BOOL CALLBACK collectWindowsLogicalMonitor(
    HMONITOR monitor,
    HDC,
    LPRECT,
    LPARAM context
) {
    auto* monitors = reinterpret_cast<std::vector<WindowsLogicalMonitor>*>(context);
    MONITORINFO info = {sizeof(MONITORINFO)};
    if (!GetMonitorInfoW(monitor, &info)) return TRUE;

    WindowsLogicalMonitor logicalMonitor;
    logicalMonitor.handle = monitor;
    logicalMonitor.physicalBounds = info.rcMonitor;
    logicalMonitor.physicalWorkArea = info.rcWork;
    logicalMonitor.dpi = windowsDpiForMonitor(monitor);
    logicalMonitor.primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
    monitors->push_back(logicalMonitor);
    return TRUE;
}

inline std::vector<WindowsLogicalMonitor> windowsLogicalMonitors() {
    std::vector<WindowsLogicalMonitor> monitors;
    EnumDisplayMonitors(
        nullptr,
        nullptr,
        collectWindowsLogicalMonitor,
        reinterpret_cast<LPARAM>(&monitors));
    layoutWindowsLogicalMonitors(monitors);
    return monitors;
}

inline WindowsLogicalMonitor windowsMonitorForHandle(HMONITOR handle) {
    const auto monitors = windowsLogicalMonitors();
    for (const auto& monitor : monitors) {
        if (monitor.handle == handle) return monitor;
    }
    WindowsLogicalMonitor fallback;
    fallback.handle = handle;
    fallback.dpi = windowsDpiForMonitor(handle);
    MONITORINFO info = {sizeof(MONITORINFO)};
    if (handle && GetMonitorInfoW(handle, &info)) {
        fallback.physicalBounds = info.rcMonitor;
        fallback.physicalWorkArea = info.rcWork;
        fallback.primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
        std::vector<WindowsLogicalMonitor> single = {fallback};
        layoutWindowsLogicalMonitors(single);
        return single.front();
    }
    return fallback;
}

inline POINT physicalScreenPointToLogical(
    LONG x,
    LONG y,
    const WindowsLogicalMonitor& monitor
) {
    return {
        monitor.logicalBounds.left + physicalToLogicalPixel(
            x - monitor.physicalBounds.left, monitor.dpi),
        monitor.logicalBounds.top + physicalToLogicalPixel(
            y - monitor.physicalBounds.top, monitor.dpi),
    };
}

inline POINT logicalScreenPointToPhysical(
    double x,
    double y,
    const WindowsLogicalMonitor& monitor
) {
    return {
        monitor.physicalBounds.left + logicalToPhysicalPixel(
            x - monitor.logicalBounds.left, monitor.dpi),
        monitor.physicalBounds.top + logicalToPhysicalPixel(
            y - monitor.logicalBounds.top, monitor.dpi),
    };
}

inline RECT logicalToPhysicalScreenRect(
    double x,
    double y,
    double width,
    double height,
    const WindowsLogicalMonitor& monitor
) {
    const POINT origin = logicalScreenPointToPhysical(x, y, monitor);
    return {
        origin.x,
        origin.y,
        origin.x + logicalToPhysicalSize(width, monitor.dpi),
        origin.y + logicalToPhysicalSize(height, monitor.dpi),
    };
}

inline double physicalScreenToLogicalCoordinate(
    LONG value,
    LONG physicalOrigin,
    LONG logicalOrigin,
    UINT dpi
) {
    return logicalOrigin +
        physicalToLogicalCoordinate(value - physicalOrigin, dpi);
}

// Public Electrobun geometry is expressed in logical pixels. Prefer the
// window's current monitor if rounding makes logical display edges overlap.
inline WindowsLogicalMonitor windowsMonitorForLogicalPoint(
    double x,
    double y,
    HMONITOR preferred = nullptr
) {
    const LONG logicalX = static_cast<LONG>(std::lround(x));
    const LONG logicalY = static_cast<LONG>(std::lround(y));
    const auto monitors = windowsLogicalMonitors();

    const WindowsLogicalMonitor* primaryMatch = nullptr;
    const WindowsLogicalMonitor* firstMatch = nullptr;
    for (const auto& monitor : monitors) {
        if (!pointInRectInclusive(monitor.logicalBounds, logicalX, logicalY)) {
            continue;
        }
        if (monitor.handle == preferred) return monitor;
        if (monitor.primary) primaryMatch = &monitor;
        if (!firstMatch) firstMatch = &monitor;
    }
    if (primaryMatch) return *primaryMatch;
    if (firstMatch) return *firstMatch;

    const WindowsLogicalMonitor* nearest = nullptr;
    unsigned long long nearestDistance =
        std::numeric_limits<unsigned long long>::max();
    int nearestPreference = -1;
    for (const auto& monitor : monitors) {
        const auto distance = squaredDistanceToRect(
            monitor.logicalBounds, logicalX, logicalY);
        const int preference = monitor.handle == preferred
            ? 2
            : (monitor.primary ? 1 : 0);
        if (distance < nearestDistance ||
            (distance == nearestDistance && preference > nearestPreference)) {
            nearest = &monitor;
            nearestDistance = distance;
            nearestPreference = preference;
        }
    }
    if (nearest) return *nearest;

    WindowsLogicalMonitor fallback;
    fallback.handle = MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY);
    fallback.dpi = windowsDpiForMonitor(fallback.handle);
    fallback.primary = true;
    return fallback;
}

} // namespace electrobun

#endif // _WIN32

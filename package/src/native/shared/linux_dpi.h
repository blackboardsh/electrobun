#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

namespace electrobun {

// Public view geometry is kept in logical pixels until it reaches the platform
// boundary. In particular, do not replace these doubles with a toolkit integer
// rectangle before applying the monitor scale factor.
struct LogicalRect {
    double x;
    double y;
    double width;
    double height;
};

struct LinuxPhysicalRect {
    int x;
    int y;
    int width;
    int height;
};

// Field-compatible with XRectangle without requiring Xlib in this shared,
// independently testable header.
struct LinuxXRectangleFields {
    std::int16_t x;
    std::int16_t y;
    std::uint16_t width;
    std::uint16_t height;
};

inline double normalizeLinuxScaleFactor(double scaleFactor) {
    return std::isfinite(scaleFactor) && scaleFactor > 0.0
        ? scaleFactor
        : 1.0;
}

inline int logicalToLinuxPhysicalPixel(double logical, double scaleFactor) {
    if (!std::isfinite(logical)) {
        return 0;
    }

    const double scaled = logical * normalizeLinuxScaleFactor(scaleFactor);
    if (!std::isfinite(scaled)) {
        return scaled < 0.0
            ? std::numeric_limits<int>::min()
            : std::numeric_limits<int>::max();
    }

    const double rounded = std::round(scaled);
    if (rounded <= static_cast<double>(std::numeric_limits<int>::min())) {
        return std::numeric_limits<int>::min();
    }
    if (rounded >= static_cast<double>(std::numeric_limits<int>::max())) {
        return std::numeric_limits<int>::max();
    }
    return static_cast<int>(rounded);
}

inline int linuxPhysicalEdgeDistance(int start, int end) {
    const std::int64_t distance =
        static_cast<std::int64_t>(end) - static_cast<std::int64_t>(start);
    if (distance <= 0) {
        return 0;
    }
    return distance >= std::numeric_limits<int>::max()
        ? std::numeric_limits<int>::max()
        : static_cast<int>(distance);
}

// Scale both edges instead of scaling the size independently. This keeps
// adjacent rectangles adjacent at fractional scale factors.
inline LinuxPhysicalRect logicalToLinuxPhysicalRect(
    double x,
    double y,
    double width,
    double height,
    double scaleFactor
) {
    const double finiteWidth = std::isfinite(width) ? std::max(0.0, width) : 0.0;
    const double finiteHeight =
        std::isfinite(height) ? std::max(0.0, height) : 0.0;
    const int left = logicalToLinuxPhysicalPixel(x, scaleFactor);
    const int top = logicalToLinuxPhysicalPixel(y, scaleFactor);
    const int right = logicalToLinuxPhysicalPixel(x + finiteWidth, scaleFactor);
    const int bottom = logicalToLinuxPhysicalPixel(y + finiteHeight, scaleFactor);
    return {
        left,
        top,
        linuxPhysicalEdgeDistance(left, right),
        linuxPhysicalEdgeDistance(top, bottom),
    };
}

inline LinuxPhysicalRect logicalToLinuxPhysicalRect(
    const LogicalRect& rect,
    double scaleFactor
) {
    return logicalToLinuxPhysicalRect(
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        scaleFactor);
}

// Convert a local rectangle using its parent's logical origin as the rounding
// anchor. This is important for masks: rounding a fractional local offset on
// its own can disagree by one pixel with the already-rounded child window.
inline LinuxPhysicalRect logicalSubrectToLinuxPhysicalRect(
    double parentX,
    double parentY,
    double x,
    double y,
    double width,
    double height,
    double scaleFactor
) {
    const double finiteWidth = std::isfinite(width) ? std::max(0.0, width) : 0.0;
    const double finiteHeight =
        std::isfinite(height) ? std::max(0.0, height) : 0.0;
    const int parentLeft = logicalToLinuxPhysicalPixel(parentX, scaleFactor);
    const int parentTop = logicalToLinuxPhysicalPixel(parentY, scaleFactor);
    const int left = logicalToLinuxPhysicalPixel(parentX + x, scaleFactor);
    const int top = logicalToLinuxPhysicalPixel(parentY + y, scaleFactor);
    const int right = logicalToLinuxPhysicalPixel(
        parentX + x + finiteWidth,
        scaleFactor);
    const int bottom = logicalToLinuxPhysicalPixel(
        parentY + y + finiteHeight,
        scaleFactor);

    const std::int64_t localX =
        static_cast<std::int64_t>(left) - static_cast<std::int64_t>(parentLeft);
    const std::int64_t localY =
        static_cast<std::int64_t>(top) - static_cast<std::int64_t>(parentTop);
    const auto clampInt = [](std::int64_t value) {
        return static_cast<int>(std::clamp(
            value,
            static_cast<std::int64_t>(std::numeric_limits<int>::min()),
            static_cast<std::int64_t>(std::numeric_limits<int>::max())));
    };

    return {
        clampInt(localX),
        clampInt(localY),
        linuxPhysicalEdgeDistance(left, right),
        linuxPhysicalEdgeDistance(top, bottom),
    };
}

// Clip scrolled overlay geometry to the parent's top/left edge while it is
// still represented as doubles. Scaling afterward preserves the visible edge.
inline LogicalRect clipLinuxLogicalRectToOrigin(const LogicalRect& rect) {
    const double x = std::isfinite(rect.x) ? rect.x : 0.0;
    const double y = std::isfinite(rect.y) ? rect.y : 0.0;
    const double width =
        std::isfinite(rect.width) ? std::max(0.0, rect.width) : 0.0;
    const double height =
        std::isfinite(rect.height) ? std::max(0.0, rect.height) : 0.0;
    const double left = std::max(0.0, x);
    const double top = std::max(0.0, y);
    const double right = std::max(left, x + width);
    const double bottom = std::max(top, y + height);
    return {left, top, right - left, bottom - top};
}

inline LinuxXRectangleFields linuxPhysicalRectToXRectangleFields(
    const LinuxPhysicalRect& rect
) {
    const auto clampSigned = [](int value) {
        return static_cast<std::int16_t>(std::clamp(
            value,
            static_cast<int>(std::numeric_limits<std::int16_t>::min()),
            static_cast<int>(std::numeric_limits<std::int16_t>::max())));
    };
    const auto clampUnsigned = [](int value) {
        return static_cast<std::uint16_t>(std::clamp(
            value,
            0,
            static_cast<int>(std::numeric_limits<std::uint16_t>::max())));
    };
    return {
        clampSigned(rect.x),
        clampSigned(rect.y),
        clampUnsigned(rect.width),
        clampUnsigned(rect.height),
    };
}

} // namespace electrobun

#pragma once

#include <algorithm>
#include <cmath>

namespace electrobun {

struct LinuxPhysicalRect {
    int x;
    int y;
    int width;
    int height;
};

inline double normalizeLinuxScaleFactor(double scaleFactor) {
    return std::isfinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1.0;
}

inline int logicalToLinuxPhysicalPixel(double logical, double scaleFactor) {
    return static_cast<int>(
        std::lround(logical * normalizeLinuxScaleFactor(scaleFactor)));
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
    const int left = logicalToLinuxPhysicalPixel(x, scaleFactor);
    const int top = logicalToLinuxPhysicalPixel(y, scaleFactor);
    const int right = logicalToLinuxPhysicalPixel(x + width, scaleFactor);
    const int bottom = logicalToLinuxPhysicalPixel(y + height, scaleFactor);
    return {
        left,
        top,
        std::max(0, right - left),
        std::max(0, bottom - top),
    };
}

} // namespace electrobun

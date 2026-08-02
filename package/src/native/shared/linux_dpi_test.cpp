#include "linux_dpi.h"

#include <cassert>
#include <cmath>
#include <limits>

using electrobun::LinuxPhysicalRect;
using electrobun::LogicalRect;

static void expectRect(
    const LinuxPhysicalRect& actual,
    int x,
    int y,
    int width,
    int height
) {
    assert(actual.x == x);
    assert(actual.y == y);
    assert(actual.width == width);
    assert(actual.height == height);
}

int main() {
    // The four scale factors in the Linux support matrix.
    expectRect(
        electrobun::logicalToLinuxPhysicalRect(100, 40, 800, 600, 1.0),
        100,
        40,
        800,
        600);
    expectRect(
        electrobun::logicalToLinuxPhysicalRect(100, 40, 800, 600, 1.25),
        125,
        50,
        1000,
        750);
    expectRect(
        electrobun::logicalToLinuxPhysicalRect(100, 40, 800, 600, 1.5),
        150,
        60,
        1200,
        900);
    expectRect(
        electrobun::logicalToLinuxPhysicalRect(100, 40, 800, 600, 2.0),
        200,
        80,
        1600,
        1200);

    // Negative monitor coordinates and fractional CSS geometry stay intact.
    expectRect(
        electrobun::logicalToLinuxPhysicalRect(-1279.6, -100.4, 640.2, 50.6, 1.25),
        -1600,
        -126,
        801,
        64);
    expectRect(
        electrobun::logicalToLinuxPhysicalRect(LogicalRect{0.4, 1.2, 2.4, 3.2}, 1.25),
        1,
        2,
        3,
        4);

    // Independently converted adjacent edges must meet exactly at every scale.
    for (const double scale : {1.0, 1.25, 1.5, 2.0}) {
        const auto left = electrobun::logicalToLinuxPhysicalRect(
            -10.25, 0.0, 10.65, 10.0, scale);
        const auto right = electrobun::logicalToLinuxPhysicalRect(
            0.4, 0.0, 9.6, 10.0, scale);
        assert(left.x + left.width == right.x);
    }

    // Invalid scale factors fall back to 100% rather than collapsing bounds.
    for (const double invalidScale : {
             0.0,
             -1.0,
             std::numeric_limits<double>::quiet_NaN(),
             std::numeric_limits<double>::infinity(),
         }) {
        expectRect(
            electrobun::logicalToLinuxPhysicalRect(2, 3, 4, 5, invalidScale),
            2,
            3,
            4,
            5);
    }

    // Empty and inverted dimensions remain empty.
    expectRect(
        electrobun::logicalToLinuxPhysicalRect(2.25, 3.25, 0, 0, 1.5),
        3,
        5,
        0,
        0);
    expectRect(
        electrobun::logicalToLinuxPhysicalRect(2, 3, -4, -5, 2.0),
        4,
        6,
        0,
        0);

    // Clip logical edges before scaling so partially scrolled views retain the
    // correct fractional visible extent.
    const auto clipped = electrobun::clipLinuxLogicalRectToOrigin(
        LogicalRect{-2.25, -1.5, 7.0, 4.0});
    assert(clipped.x == 0.0);
    assert(clipped.y == 0.0);
    assert(clipped.width == 4.75);
    assert(clipped.height == 2.5);
    expectRect(
        electrobun::logicalToLinuxPhysicalRect(clipped, 1.25),
        0,
        0,
        6,
        3);
    const auto fullyClipped = electrobun::clipLinuxLogicalRectToOrigin(
        LogicalRect{-10.0, -20.0, 2.0, 3.0});
    assert(fullyClipped.width == 0.0);
    assert(fullyClipped.height == 0.0);

    // A mask is relative to the already-rounded child origin. Independent
    // local rounding would produce x=1 here; anchored rounding correctly gives
    // x=0 and keeps its far edge aligned with the absolute logical geometry.
    expectRect(
        electrobun::logicalSubrectToLinuxPhysicalRect(
            0.4, 0.4, 0.4, 0.4, 2.0, 2.0, 1.25),
        0,
        0,
        3,
        3);
    expectRect(
        electrobun::logicalSubrectToLinuxPhysicalRect(
            -100.4, -50.4, 0.8, 1.2, 3.2, 4.0, 1.5),
        2,
        2,
        4,
        6);

    // XRectangle's narrow fields must saturate instead of wrapping.
    const auto xrect = electrobun::linuxPhysicalRectToXRectangleFields(
        LinuxPhysicalRect{-50000, 50000, -10, 100000});
    assert(xrect.x == std::numeric_limits<std::int16_t>::min());
    assert(xrect.y == std::numeric_limits<std::int16_t>::max());
    assert(xrect.width == 0);
    assert(xrect.height == std::numeric_limits<std::uint16_t>::max());

    return 0;
}

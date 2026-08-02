#include "linux_dpi.h"

#include <cassert>

int main() {
    const auto dpr150 =
        electrobun::logicalToLinuxPhysicalRect(100, 40, 800, 600, 1.5);
    assert(dpr150.x == 150);
    assert(dpr150.y == 60);
    assert(dpr150.width == 1200);
    assert(dpr150.height == 900);

    const auto dpr200 =
        electrobun::logicalToLinuxPhysicalRect(100, 40, 800, 600, 2.0);
    assert(dpr200.x == 200);
    assert(dpr200.y == 80);
    assert(dpr200.width == 1600);
    assert(dpr200.height == 1200);

    const auto fractional =
        electrobun::logicalToLinuxPhysicalRect(1, 1, 2, 2, 1.25);
    assert(fractional.x == 1);
    assert(fractional.y == 1);
    assert(fractional.width == 3);
    assert(fractional.height == 3);

    const auto invalid =
        electrobun::logicalToLinuxPhysicalRect(2, 3, 4, 5, 0.0);
    assert(invalid.x == 2);
    assert(invalid.y == 3);
    assert(invalid.width == 4);
    assert(invalid.height == 5);

    return 0;
}

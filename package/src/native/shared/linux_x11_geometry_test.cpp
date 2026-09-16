#include "linux_x11_geometry.h"

#include <cassert>

using electrobun::LinuxX11Geometry;
using electrobun::LinuxX11GeometryChange;
using electrobun::LinuxX11GeometryReducer;

static void expectGeometry(
    const LinuxX11Geometry& geometry,
    double x,
    double y,
    double width,
    double height
) {
    assert(geometry.x == x);
    assert(geometry.y == y);
    assert(geometry.width == width);
    assert(geometry.height == height);
}

static LinuxX11GeometryChange reduceOne(
    const LinuxX11Geometry& current,
    const LinuxX11Geometry& configured
) {
    LinuxX11GeometryReducer reducer(current);
    reducer.observe(configured);
    return reducer.result();
}

int main() {
    const LinuxX11Geometry current = {100, 200, 800, 600};

    // No ConfigureNotify means there is nothing to deliver.
    const LinuxX11GeometryChange empty =
        LinuxX11GeometryReducer(current).result();
    assert(!empty.hasConfigure);
    assert(!empty.moved);
    assert(!empty.resized);
    assert(!empty.changed());
    expectGeometry(empty.geometry, 100, 200, 800, 600);

    const auto identical = reduceOne(current, current);
    assert(identical.hasConfigure);
    assert(!identical.moved);
    assert(!identical.resized);
    assert(!identical.changed());

    const auto pureMove = reduceOne(current, {150, -75, 800, 600});
    assert(pureMove.hasConfigure);
    assert(pureMove.moved);
    assert(!pureMove.resized);
    assert(pureMove.changed());
    expectGeometry(pureMove.geometry, 150, -75, 800, 600);

    const auto pureResize = reduceOne(current, {100, 200, 1024, 768});
    assert(pureResize.hasConfigure);
    assert(!pureResize.moved);
    assert(pureResize.resized);
    assert(pureResize.changed());
    expectGeometry(pureResize.geometry, 100, 200, 1024, 768);

    const auto mixed = reduceOne(current, {-1920, 20, 1280, 720});
    assert(mixed.hasConfigure);
    assert(mixed.moved);
    assert(mixed.resized);
    assert(mixed.changed());
    expectGeometry(mixed.geometry, -1920, 20, 1280, 720);

    // Intermediate WM geometry is discarded. Classification is based on the
    // final event in the burst relative to the last applied geometry.
    LinuxX11GeometryReducer burst(current);
    burst.observe(110, 210, 810, 610);
    burst.observe(-1920, 0, 1920, 1080);
    burst.observe(400, 300, 900, 700);
    const auto latest = burst.result();
    assert(latest.hasConfigure);
    assert(latest.moved);
    assert(latest.resized);
    expectGeometry(latest.geometry, 400, 300, 900, 700);

    // A burst that returns to its starting geometry has no net callback work.
    burst.observe(current);
    const auto returned = burst.result();
    assert(returned.hasConfigure);
    assert(!returned.moved);
    assert(!returned.resized);
    expectGeometry(returned.geometry, 100, 200, 800, 600);

    return 0;
}

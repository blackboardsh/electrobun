#pragma once

namespace electrobun {

// X11 can emit a burst of ConfigureNotify events while a window manager moves
// or tiles a parent. Keep only the final geometry and classify its net change
// from the last applied state before delivering callbacks.
struct LinuxX11Geometry {
    double x;
    double y;
    double width;
    double height;
};

struct LinuxX11GeometryChange {
    bool hasConfigure;
    LinuxX11Geometry geometry;
    bool moved;
    bool resized;

    bool changed() const {
        return moved || resized;
    }
};

class LinuxX11GeometryReducer {
public:
    explicit LinuxX11GeometryReducer(const LinuxX11Geometry& current)
        : current_(current), latest_(current), hasLatest_(false) {}

    void observe(const LinuxX11Geometry& geometry) {
        latest_ = geometry;
        hasLatest_ = true;
    }

    void observe(double x, double y, double width, double height) {
        observe({x, y, width, height});
    }

    LinuxX11GeometryChange result() const {
        return {
            hasLatest_,
            latest_,
            hasLatest_ &&
                (latest_.x != current_.x || latest_.y != current_.y),
            hasLatest_ &&
                (latest_.width != current_.width ||
                 latest_.height != current_.height),
        };
    }

private:
    LinuxX11Geometry current_;
    LinuxX11Geometry latest_;
    bool hasLatest_;
};

} // namespace electrobun

#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>

namespace electrobun {

// Geometry reported by the ScreenCast portal is expressed in compositor
// logical coordinates. The cached PipeWire frame may have a different pixel
// size when display scaling is active.
struct WaylandScreenCaptureLogicalBounds {
    std::int64_t x;
    std::int64_t y;
    std::uint32_t width;
    std::uint32_t height;
};

struct WaylandScreenCaptureRegion {
    std::int64_t x;
    std::int64_t y;
    std::uint32_t width;
    std::uint32_t height;
};

// The frame contains RGBA pixels. row_stride may include padding, but every
// logical row must contain at least pixel_width * 4 bytes.
struct WaylandScreenCaptureFrameView {
    const std::uint8_t* rgba;
    std::size_t byte_length;
    std::uint32_t pixel_width;
    std::uint32_t pixel_height;
    std::size_t row_stride;
    WaylandScreenCaptureLogicalBounds logical_bounds;
};

inline bool checkedWaylandScreenCaptureSizeMultiply(
    std::size_t left,
    std::size_t right,
    std::size_t* result
) {
    if (!result ||
        (right != 0 && left > std::numeric_limits<std::size_t>::max() / right)) {
        return false;
    }
    *result = left * right;
    return true;
}

inline bool checkedWaylandScreenCaptureSizeAdd(
    std::size_t left,
    std::size_t right,
    std::size_t* result
) {
    if (!result || left > std::numeric_limits<std::size_t>::max() - right) {
        return false;
    }
    *result = left + right;
    return true;
}

inline bool checkedWaylandScreenCaptureRightEdge(
    std::int64_t origin,
    std::uint32_t extent,
    std::int64_t* edge
) {
    if (!edge ||
        origin > std::numeric_limits<std::int64_t>::max() -
            static_cast<std::int64_t>(extent)) {
        return false;
    }
    *edge = origin + static_cast<std::int64_t>(extent);
    return true;
}

inline bool validateWaylandScreenCaptureFrame(
    const WaylandScreenCaptureFrameView& frame,
    std::size_t* packed_row_bytes = nullptr
) {
    if (!frame.rgba || frame.pixel_width == 0 || frame.pixel_height == 0 ||
        frame.logical_bounds.width == 0 || frame.logical_bounds.height == 0) {
        return false;
    }

    std::int64_t logical_right = 0;
    std::int64_t logical_bottom = 0;
    if (!checkedWaylandScreenCaptureRightEdge(
            frame.logical_bounds.x,
            frame.logical_bounds.width,
            &logical_right) ||
        !checkedWaylandScreenCaptureRightEdge(
            frame.logical_bounds.y,
            frame.logical_bounds.height,
            &logical_bottom)) {
        return false;
    }

    std::size_t row_bytes = 0;
    if (!checkedWaylandScreenCaptureSizeMultiply(
            static_cast<std::size_t>(frame.pixel_width),
            4,
            &row_bytes) ||
        frame.row_stride < row_bytes) {
        return false;
    }

    std::size_t last_row_offset = 0;
    std::size_t required_bytes = 0;
    if (!checkedWaylandScreenCaptureSizeMultiply(
            static_cast<std::size_t>(frame.pixel_height - 1),
            frame.row_stride,
            &last_row_offset) ||
        !checkedWaylandScreenCaptureSizeAdd(
            last_row_offset,
            row_bytes,
            &required_bytes) ||
        required_bytes > frame.byte_length) {
        return false;
    }

    if (packed_row_bytes) {
        *packed_row_bytes = row_bytes;
    }
    return true;
}

inline bool mapWaylandScreenCaptureAxis(
    std::uint64_t relative_logical_pixel,
    std::uint32_t logical_extent,
    std::uint32_t physical_extent,
    std::uint32_t* physical_pixel
) {
    if (!physical_pixel || logical_extent == 0 || physical_extent == 0 ||
        relative_logical_pixel >= logical_extent ||
        relative_logical_pixel >
            (std::numeric_limits<std::uint64_t>::max() - 1) / 2) {
        return false;
    }

    const std::uint64_t center = relative_logical_pixel * 2 + 1;
    if (center > std::numeric_limits<std::uint64_t>::max() / physical_extent) {
        return false;
    }

    const std::uint64_t denominator =
        static_cast<std::uint64_t>(logical_extent) * 2;
    const std::uint64_t mapped = center * physical_extent / denominator;
    if (mapped >= physical_extent) {
        return false;
    }

    *physical_pixel = static_cast<std::uint32_t>(mapped);
    return true;
}

// Map the center of one compositor logical pixel into the corresponding
// physical frame pixel. Center sampling matches the existing X11 capture
// behavior and avoids consistently choosing the top-left device pixel at 2x.
inline bool mapWaylandScreenCaptureLogicalPixel(
    const WaylandScreenCaptureFrameView& frame,
    std::int64_t logical_x,
    std::int64_t logical_y,
    std::uint32_t* pixel_x,
    std::uint32_t* pixel_y
) {
    if (!pixel_x || !pixel_y || !validateWaylandScreenCaptureFrame(frame)) {
        return false;
    }

    std::int64_t logical_right = 0;
    std::int64_t logical_bottom = 0;
    if (!checkedWaylandScreenCaptureRightEdge(
            frame.logical_bounds.x,
            frame.logical_bounds.width,
            &logical_right) ||
        !checkedWaylandScreenCaptureRightEdge(
            frame.logical_bounds.y,
            frame.logical_bounds.height,
            &logical_bottom) ||
        logical_x < frame.logical_bounds.x || logical_x >= logical_right ||
        logical_y < frame.logical_bounds.y || logical_y >= logical_bottom) {
        return false;
    }

    const std::uint64_t relative_x = static_cast<std::uint64_t>(
        logical_x - frame.logical_bounds.x);
    const std::uint64_t relative_y = static_cast<std::uint64_t>(
        logical_y - frame.logical_bounds.y);
    return mapWaylandScreenCaptureAxis(
               relative_x,
               frame.logical_bounds.width,
               frame.pixel_width,
               pixel_x) &&
        mapWaylandScreenCaptureAxis(
               relative_y,
               frame.logical_bounds.height,
               frame.pixel_height,
               pixel_y);
}

// Map a PipeWire frame coordinate (including SPA cursor metadata positions)
// back into the compositor's logical desktop coordinate space.
inline bool mapWaylandScreenCaptureFramePointToLogical(
    const WaylandScreenCaptureLogicalBounds& logical_bounds,
    std::uint32_t pixel_width,
    std::uint32_t pixel_height,
    std::int32_t pixel_x,
    std::int32_t pixel_y,
    std::int64_t* logical_x,
    std::int64_t* logical_y
) {
    if (!logical_x || !logical_y || pixel_width == 0 || pixel_height == 0 ||
        logical_bounds.width == 0 || logical_bounds.height == 0 ||
        pixel_x < 0 || pixel_y < 0 ||
        static_cast<std::uint32_t>(pixel_x) >= pixel_width ||
        static_cast<std::uint32_t>(pixel_y) >= pixel_height) {
        return false;
    }

    std::int64_t logical_right = 0;
    std::int64_t logical_bottom = 0;
    if (!checkedWaylandScreenCaptureRightEdge(
            logical_bounds.x, logical_bounds.width, &logical_right) ||
        !checkedWaylandScreenCaptureRightEdge(
            logical_bounds.y, logical_bounds.height, &logical_bottom)) {
        return false;
    }

    const std::uint64_t relative_x =
        static_cast<std::uint64_t>(pixel_x) * logical_bounds.width /
        pixel_width;
    const std::uint64_t relative_y =
        static_cast<std::uint64_t>(pixel_y) * logical_bounds.height /
        pixel_height;
    *logical_x = logical_bounds.x + static_cast<std::int64_t>(relative_x);
    *logical_y = logical_bounds.y + static_cast<std::int64_t>(relative_y);
    return *logical_x < logical_right && *logical_y < logical_bottom;
}

inline bool copyWaylandScreenCaptureRegion(
    const WaylandScreenCaptureFrameView& frame,
    const WaylandScreenCaptureRegion& region,
    std::uint8_t* out_rgba,
    std::size_t out_length
) {
    if (!out_rgba || region.width == 0 || region.height == 0 ||
        !validateWaylandScreenCaptureFrame(frame)) {
        return false;
    }

    std::size_t output_pixels = 0;
    std::size_t required_output_bytes = 0;
    if (!checkedWaylandScreenCaptureSizeMultiply(
            static_cast<std::size_t>(region.width),
            static_cast<std::size_t>(region.height),
            &output_pixels) ||
        !checkedWaylandScreenCaptureSizeMultiply(
            output_pixels,
            4,
            &required_output_bytes) ||
        out_length != required_output_bytes) {
        return false;
    }

    std::int64_t frame_right = 0;
    std::int64_t frame_bottom = 0;
    std::int64_t region_right = 0;
    std::int64_t region_bottom = 0;
    if (!checkedWaylandScreenCaptureRightEdge(
            frame.logical_bounds.x,
            frame.logical_bounds.width,
            &frame_right) ||
        !checkedWaylandScreenCaptureRightEdge(
            frame.logical_bounds.y,
            frame.logical_bounds.height,
            &frame_bottom) ||
        !checkedWaylandScreenCaptureRightEdge(
            region.x,
            region.width,
            &region_right) ||
        !checkedWaylandScreenCaptureRightEdge(
            region.y,
            region.height,
            &region_bottom) ||
        region.x < frame.logical_bounds.x || region.y < frame.logical_bounds.y ||
        region_right > frame_right || region_bottom > frame_bottom) {
        return false;
    }

    const std::uint64_t first_relative_x = static_cast<std::uint64_t>(
        region.x - frame.logical_bounds.x);
    const std::uint64_t first_relative_y = static_cast<std::uint64_t>(
        region.y - frame.logical_bounds.y);

    for (std::uint32_t destination_y = 0;
         destination_y < region.height;
         ++destination_y) {
        std::uint32_t source_y = 0;
        if (!mapWaylandScreenCaptureAxis(
                first_relative_y + destination_y,
                frame.logical_bounds.height,
                frame.pixel_height,
                &source_y)) {
            return false;
        }

        for (std::uint32_t destination_x = 0;
             destination_x < region.width;
             ++destination_x) {
            std::uint32_t source_x = 0;
            if (!mapWaylandScreenCaptureAxis(
                    first_relative_x + destination_x,
                    frame.logical_bounds.width,
                    frame.pixel_width,
                    &source_x)) {
                return false;
            }

            std::size_t source_row = 0;
            std::size_t source_pixel = 0;
            std::size_t source_offset = 0;
            std::size_t destination_row = 0;
            std::size_t destination_pixel = 0;
            std::size_t destination_offset = 0;
            if (!checkedWaylandScreenCaptureSizeMultiply(
                    static_cast<std::size_t>(source_y),
                    frame.row_stride,
                    &source_row) ||
                !checkedWaylandScreenCaptureSizeMultiply(
                    static_cast<std::size_t>(source_x),
                    4,
                    &source_pixel) ||
                !checkedWaylandScreenCaptureSizeAdd(
                    source_row,
                    source_pixel,
                    &source_offset) ||
                !checkedWaylandScreenCaptureSizeMultiply(
                    static_cast<std::size_t>(destination_y),
                    static_cast<std::size_t>(region.width),
                    &destination_row) ||
                !checkedWaylandScreenCaptureSizeAdd(
                    destination_row,
                    static_cast<std::size_t>(destination_x),
                    &destination_pixel) ||
                !checkedWaylandScreenCaptureSizeMultiply(
                    destination_pixel,
                    4,
                    &destination_offset) ||
                source_offset > frame.byte_length - 4 ||
                destination_offset > out_length - 4) {
                return false;
            }

            std::memcpy(out_rgba + destination_offset, frame.rgba + source_offset, 4);
        }
    }

    return true;
}

} // namespace electrobun

#include "wayland_screen_capture_frame.h"

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

using electrobun::WaylandScreenCaptureFrameView;
using electrobun::WaylandScreenCaptureLogicalBounds;
using electrobun::WaylandScreenCaptureRegion;

static void setPixel(
    std::vector<std::uint8_t>& pixels,
    std::size_t stride,
    std::uint32_t x,
    std::uint32_t y,
    std::array<std::uint8_t, 4> rgba
) {
    const std::size_t offset =
        static_cast<std::size_t>(y) * stride + static_cast<std::size_t>(x) * 4;
    for (std::size_t channel = 0; channel < rgba.size(); ++channel) {
        pixels[offset + channel] = rgba[channel];
    }
}

static std::array<std::uint8_t, 4> coordinatePixel(
    std::uint32_t x,
    std::uint32_t y
) {
    return {
        static_cast<std::uint8_t>(x),
        static_cast<std::uint8_t>(y),
        static_cast<std::uint8_t>(x + y * 16),
        0xff,
    };
}

static void fillCoordinatePixels(
    std::vector<std::uint8_t>& pixels,
    std::size_t stride,
    std::uint32_t width,
    std::uint32_t height
) {
    for (std::uint32_t y = 0; y < height; ++y) {
        for (std::uint32_t x = 0; x < width; ++x) {
            setPixel(pixels, stride, x, y, coordinatePixel(x, y));
        }
    }
}

static void expectPixel(
    const std::uint8_t* actual,
    std::array<std::uint8_t, 4> expected
) {
    for (std::size_t channel = 0; channel < expected.size(); ++channel) {
        assert(actual[channel] == expected[channel]);
    }
}

static WaylandScreenCaptureFrameView makeFrame(
    const std::vector<std::uint8_t>& pixels,
    std::uint32_t pixel_width,
    std::uint32_t pixel_height,
    std::size_t row_stride,
    WaylandScreenCaptureLogicalBounds logical_bounds
) {
    return {
        pixels.data(),
        pixels.size(),
        pixel_width,
        pixel_height,
        row_stride,
        logical_bounds,
    };
}

int main() {
    {
        // Identity-scale subregions retain row-major RGBA channel order.
        constexpr std::uint32_t width = 4;
        constexpr std::uint32_t height = 3;
        constexpr std::size_t stride = width * 4;
        std::vector<std::uint8_t> pixels(stride * height);
        fillCoordinatePixels(pixels, stride, width, height);
        const auto frame = makeFrame(
            pixels,
            width,
            height,
            stride,
            WaylandScreenCaptureLogicalBounds{0, 0, width, height});

        std::array<std::uint8_t, 2 * 2 * 4> output{};
        assert(electrobun::copyWaylandScreenCaptureRegion(
            frame,
            WaylandScreenCaptureRegion{1, 1, 2, 2},
            output.data(),
            output.size()));
        expectPixel(output.data(), coordinatePixel(1, 1));
        expectPixel(output.data() + 4, coordinatePixel(2, 1));
        expectPixel(output.data() + 8, coordinatePixel(1, 2));
        expectPixel(output.data() + 12, coordinatePixel(2, 2));
    }

    {
        // A negatively positioned 2x monitor samples the center device pixel
        // for every requested compositor logical pixel.
        constexpr std::uint32_t pixel_width = 6;
        constexpr std::uint32_t pixel_height = 4;
        constexpr std::size_t stride = pixel_width * 4;
        std::vector<std::uint8_t> pixels(stride * pixel_height);
        fillCoordinatePixels(pixels, stride, pixel_width, pixel_height);
        const auto frame = makeFrame(
            pixels,
            pixel_width,
            pixel_height,
            stride,
            WaylandScreenCaptureLogicalBounds{-2, -1, 3, 2});

        std::array<std::uint8_t, 3 * 2 * 4> output{};
        assert(electrobun::copyWaylandScreenCaptureRegion(
            frame,
            WaylandScreenCaptureRegion{-2, -1, 3, 2},
            output.data(),
            output.size()));
        const std::uint32_t expected_x[] = {1, 3, 5};
        const std::uint32_t expected_y[] = {1, 3};
        for (std::uint32_t y = 0; y < 2; ++y) {
            for (std::uint32_t x = 0; x < 3; ++x) {
                expectPixel(
                    output.data() + (y * 3 + x) * 4,
                    coordinatePixel(expected_x[x], expected_y[y]));
            }
        }
    }

    {
        // Fractional physical scaling uses exact rational center mapping.
        constexpr std::uint32_t pixel_width = 5;
        constexpr std::uint32_t pixel_height = 3;
        constexpr std::size_t stride = pixel_width * 4;
        std::vector<std::uint8_t> pixels(stride * pixel_height);
        fillCoordinatePixels(pixels, stride, pixel_width, pixel_height);
        const auto frame = makeFrame(
            pixels,
            pixel_width,
            pixel_height,
            stride,
            WaylandScreenCaptureLogicalBounds{10, 20, 4, 2});

        const std::uint32_t expected_x[] = {0, 1, 3, 4};
        const std::uint32_t expected_y[] = {0, 2};
        for (std::uint32_t y = 0; y < 2; ++y) {
            for (std::uint32_t x = 0; x < 4; ++x) {
                std::uint32_t mapped_x = 0;
                std::uint32_t mapped_y = 0;
                assert(electrobun::mapWaylandScreenCaptureLogicalPixel(
                    frame,
                    10 + x,
                    20 + y,
                    &mapped_x,
                    &mapped_y));
                assert(mapped_x == expected_x[x]);
                assert(mapped_y == expected_y[y]);
            }
        }

        std::int64_t logical_x = 0;
        std::int64_t logical_y = 0;
        assert(electrobun::mapWaylandScreenCaptureFramePointToLogical(
            frame.logical_bounds,
            frame.pixel_width,
            frame.pixel_height,
            3,
            2,
            &logical_x,
            &logical_y));
        assert(logical_x == 12);
        assert(logical_y == 21);
        assert(!electrobun::mapWaylandScreenCaptureFramePointToLogical(
            frame.logical_bounds,
            frame.pixel_width,
            frame.pixel_height,
            -1,
            0,
            &logical_x,
            &logical_y));
        assert(!electrobun::mapWaylandScreenCaptureFramePointToLogical(
            frame.logical_bounds,
            frame.pixel_width,
            frame.pixel_height,
            static_cast<std::int32_t>(frame.pixel_width),
            0,
            &logical_x,
            &logical_y));
    }

    {
        // PipeWire rows may be padded; padding bytes must never leak into the
        // packed output.
        constexpr std::uint32_t width = 3;
        constexpr std::uint32_t height = 2;
        constexpr std::size_t stride = 16;
        std::vector<std::uint8_t> pixels(stride * height, 0xee);
        fillCoordinatePixels(pixels, stride, width, height);
        const auto frame = makeFrame(
            pixels,
            width,
            height,
            stride,
            WaylandScreenCaptureLogicalBounds{-10, 5, width, height});

        std::array<std::uint8_t, width * height * 4> output{};
        assert(electrobun::copyWaylandScreenCaptureRegion(
            frame,
            WaylandScreenCaptureRegion{-10, 5, width, height},
            output.data(),
            output.size()));
        for (std::uint32_t y = 0; y < height; ++y) {
            for (std::uint32_t x = 0; x < width; ++x) {
                expectPixel(
                    output.data() + (y * width + x) * 4,
                    coordinatePixel(x, y));
            }
        }
    }

    {
        constexpr std::uint32_t width = 2;
        constexpr std::uint32_t height = 2;
        constexpr std::size_t stride = width * 4;
        std::vector<std::uint8_t> pixels(stride * height);
        fillCoordinatePixels(pixels, stride, width, height);
        const auto valid_frame = makeFrame(
            pixels,
            width,
            height,
            stride,
            WaylandScreenCaptureLogicalBounds{-1, -1, width, height});
        std::array<std::uint8_t, 4> output{0xaa, 0xbb, 0xcc, 0xdd};
        const auto unchanged = output;

        // Requests must be fully contained and have an exact output length.
        for (const auto& invalid_region : {
                 WaylandScreenCaptureRegion{-2, -1, 1, 1},
                 WaylandScreenCaptureRegion{-1, -2, 1, 1},
                 WaylandScreenCaptureRegion{1, -1, 1, 1},
                 WaylandScreenCaptureRegion{-1, 1, 1, 1},
                 WaylandScreenCaptureRegion{-1, -1, 0, 1},
                 WaylandScreenCaptureRegion{-1, -1, 1, 0},
             }) {
            assert(!electrobun::copyWaylandScreenCaptureRegion(
                valid_frame,
                invalid_region,
                output.data(),
                output.size()));
            assert(output == unchanged);
        }
        assert(!electrobun::copyWaylandScreenCaptureRegion(
            valid_frame,
            WaylandScreenCaptureRegion{-1, -1, 1, 1},
            output.data(),
            output.size() - 1));
        assert(!electrobun::copyWaylandScreenCaptureRegion(
            valid_frame,
            WaylandScreenCaptureRegion{-1, -1, 1, 1},
            nullptr,
            output.size()));

        // Invalid frame layouts fail before reading any pixels.
        for (const auto& invalid_frame : {
                 WaylandScreenCaptureFrameView{
                     nullptr,
                     pixels.size(),
                     width,
                     height,
                     stride,
                     {-1, -1, width, height},
                 },
                 WaylandScreenCaptureFrameView{
                     pixels.data(),
                     pixels.size(),
                     0,
                     height,
                     stride,
                     {-1, -1, width, height},
                 },
                 WaylandScreenCaptureFrameView{
                     pixels.data(),
                     pixels.size(),
                     width,
                     0,
                     stride,
                     {-1, -1, width, height},
                 },
                 WaylandScreenCaptureFrameView{
                     pixels.data(),
                     pixels.size(),
                     width,
                     height,
                     stride - 1,
                     {-1, -1, width, height},
                 },
                 WaylandScreenCaptureFrameView{
                     pixels.data(),
                     pixels.size() - 1,
                     width,
                     height,
                     stride,
                     {-1, -1, width, height},
                 },
                 WaylandScreenCaptureFrameView{
                     pixels.data(),
                     pixels.size(),
                     width,
                     height,
                     stride,
                     {-1, -1, 0, height},
                 },
             }) {
            assert(!electrobun::copyWaylandScreenCaptureRegion(
                invalid_frame,
                WaylandScreenCaptureRegion{-1, -1, 1, 1},
                output.data(),
                output.size()));
            assert(output == unchanged);
        }
    }

    {
        std::uint8_t pixel[] = {1, 2, 3, 4};
        std::uint8_t output[] = {0, 0, 0, 0};

        // Logical edge and destination size arithmetic must reject overflow.
        const WaylandScreenCaptureFrameView overflowing_bounds = {
            pixel,
            sizeof(pixel),
            1,
            1,
            4,
            {
                std::numeric_limits<std::int64_t>::max() - 1,
                0,
                4,
                1,
            },
        };
        assert(!electrobun::copyWaylandScreenCaptureRegion(
            overflowing_bounds,
            WaylandScreenCaptureRegion{0, 0, 1, 1},
            output,
            sizeof(output)));

        const WaylandScreenCaptureFrameView enormous_logical_frame = {
            pixel,
            std::numeric_limits<std::size_t>::max(),
            std::numeric_limits<std::uint32_t>::max(),
            1,
            std::numeric_limits<std::size_t>::max(),
            {0, 0, std::numeric_limits<std::uint32_t>::max(), 1},
        };
        std::uint32_t mapped_x = 0;
        std::uint32_t mapped_y = 0;
        assert(!electrobun::mapWaylandScreenCaptureLogicalPixel(
            enormous_logical_frame,
            std::numeric_limits<std::uint32_t>::max() - 1,
            0,
            &mapped_x,
            &mapped_y));

        const WaylandScreenCaptureFrameView overflowing_stride = {
            pixel,
            std::numeric_limits<std::size_t>::max(),
            1,
            2,
            std::numeric_limits<std::size_t>::max(),
            {0, 0, 1, 2},
        };
        assert(!electrobun::copyWaylandScreenCaptureRegion(
            overflowing_stride,
            WaylandScreenCaptureRegion{0, 0, 1, 1},
            output,
            sizeof(output)));

        const WaylandScreenCaptureFrameView tiny_frame = {
            pixel,
            sizeof(pixel),
            1,
            1,
            4,
            {0, 0, 1, 1},
        };
        assert(!electrobun::copyWaylandScreenCaptureRegion(
            tiny_frame,
            WaylandScreenCaptureRegion{
                0,
                0,
                std::numeric_limits<std::uint32_t>::max(),
                std::numeric_limits<std::uint32_t>::max(),
            },
            output,
            std::numeric_limits<std::size_t>::max()));

        std::array<std::uint8_t, 16> larger_output{};
        assert(!electrobun::copyWaylandScreenCaptureRegion(
            tiny_frame,
            WaylandScreenCaptureRegion{
                std::numeric_limits<std::int64_t>::max() - 1,
                0,
                4,
                1,
            },
            larger_output.data(),
            larger_output.size()));
    }

    return 0;
}

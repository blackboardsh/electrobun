#pragma once

#include <cstdint>

namespace electrobun::wayland_pipewire_capture {

struct LogicalBounds {
    std::int64_t x;
    std::int64_t y;
    std::uint32_t width;
    std::uint32_t height;
};

struct CursorPoint {
    // Portal-global compositor logical coordinates. PipeWire cursor metadata
    // is expressed in stream pixels; the capture backend maps it through the
    // selected monitor's logical bounds before exposing it here.
    double logicalX;
    double logicalY;

    // The last hotspot supplied with a cursor bitmap. Mutter sends position-
    // only updates with bitmap_offset == 0 and zeroed hotspot fields, so these
    // values deliberately remain cached across such updates.
    std::int32_t hotspotPixelX;
    std::int32_t hotspotPixelY;
};

// Start consuming one ScreenCast portal stream on a private PipeWire main-loop
// thread. Ownership of portalFd is transferred on entry, including when this
// function returns false. The current implementation supports one monitor
// stream with an untransformed, packed, CPU-mappable raw-video buffer.
bool start(
    int portalFd,
    std::uint32_t nodeId,
    const LogicalBounds& logicalBounds);

// Stop the stream thread and release all cached pixels/cursor state. Safe to
// call more than once, but not from a PipeWire callback.
void stop();

// Report an asynchronous stream/worker failure after start() has returned.
// This lets the portal owner close its session instead of polling a stream that
// can no longer produce frames.
bool hasFailed();

// Copy one RGBA output pixel per compositor logical coordinate. This also
// requests that the next available PipeWire frame refresh the full-frame
// cache, limiting expensive frame conversion to consumer demand.
bool capture(
    double x,
    double y,
    std::uint32_t width,
    std::uint32_t height,
    std::uint8_t* outRgba,
    std::uint64_t outLen);

// Return the last compositor-owned cursor position reported for the selected
// monitor. Cursor metadata uses id == 0 to mean "no new data", so the last
// position remains cached across those buffers. False means no valid cursor
// position has arrived, an unsupported transform was reported, or an explicit
// position update placed the pointer outside the selected stream.
bool getCursorPoint(CursorPoint* point);

}  // namespace electrobun::wayland_pipewire_capture

#pragma once

#include <cstdint>

namespace electrobun::wayland_screen_capture {

// Electrobun currently runs its Linux UI through XWayland even in a Wayland
// desktop session. This reports the desktop session, rather than GDK's forced
// backend, so callers can choose the portal capture path.
bool isWaylandSession();

// Capture one RGBA pixel for each logical desktop coordinate in the requested
// rectangle. On Wayland, the first call starts the asynchronous ScreenCast
// portal flow and returns false until the user has approved a monitor and the
// first frame has arrived. Cancellation and setup failures are terminal for the
// process lifetime, so polling this function never causes repeated prompts.
bool captureRegion(
    double x,
    double y,
    uint32_t width,
    uint32_t height,
    uint8_t* outRgba,
    uint64_t outLen);

// Return the compositor cursor position supplied alongside the current
// PipeWire stream. This stays accurate while the pointer is over native
// Wayland surfaces, unlike XWayland's root-pointer query.
bool getCursorScreenPoint(double* x, double* y);

// Stop the PipeWire stream, close the portal request/session, and release
// the cached frame. Call this on the GTK/GLib main context before its event loop
// exits. It is safe to call more than once.
void shutdown();

}  // namespace electrobun::wayland_screen_capture

// permissions_cef.h - CEF-aware permission helpers
// Must be included AFTER include/cef_app.h (or any header that pulls in
// internal/cef_types.h) so the CEF_PERMISSION_TYPE_* constants are available.

#ifndef ELECTROBUN_PERMISSIONS_CEF_H
#define ELECTROBUN_PERMISSIONS_CEF_H

// Consumers must already have included CEF headers that define
// CEF_PERMISSION_TYPE_* (e.g. include/cef_app.h, which pulls in
// include/internal/cef_types.h transitively).

#include <string>
#include <cstdint>
#include <cstdio>

namespace electrobun {

// Decode a CEF permission bitmask (as passed to OnShowPermissionPrompt) into a
// human-readable comma-separated list of permission names. Used to build
// informative dialogs for permission types we don't have a dedicated UI for.
inline std::string describeCefPermissions(uint32_t mask) {
    std::string out;
    auto add = [&](const char* name) {
        if (!out.empty()) out += ", ";
        out += name;
    };

    if (mask & CEF_PERMISSION_TYPE_AR_SESSION) add("AR session");
    if (mask & CEF_PERMISSION_TYPE_CAMERA_PAN_TILT_ZOOM) add("Camera pan/tilt/zoom");
    if (mask & CEF_PERMISSION_TYPE_CAMERA_STREAM) add("Camera");
    if (mask & CEF_PERMISSION_TYPE_CAPTURED_SURFACE_CONTROL) add("Captured surface control");
    if (mask & CEF_PERMISSION_TYPE_CLIPBOARD) add("Clipboard");
    if (mask & CEF_PERMISSION_TYPE_TOP_LEVEL_STORAGE_ACCESS) add("Top-level storage access");
    if (mask & CEF_PERMISSION_TYPE_DISK_QUOTA) add("Disk quota");
    if (mask & CEF_PERMISSION_TYPE_LOCAL_FONTS) add("Local fonts");
    if (mask & CEF_PERMISSION_TYPE_GEOLOCATION) add("Location");
    if (mask & CEF_PERMISSION_TYPE_HAND_TRACKING) add("Hand tracking");
    if (mask & CEF_PERMISSION_TYPE_IDENTITY_PROVIDER) add("Identity provider");
    if (mask & CEF_PERMISSION_TYPE_IDLE_DETECTION) add("Idle detection");
    if (mask & CEF_PERMISSION_TYPE_MIC_STREAM) add("Microphone");
    if (mask & CEF_PERMISSION_TYPE_MIDI_SYSEX) add("MIDI system-exclusive");
    if (mask & CEF_PERMISSION_TYPE_MULTIPLE_DOWNLOADS) add("Multiple downloads");
    if (mask & CEF_PERMISSION_TYPE_NOTIFICATIONS) add("Notifications");
    if (mask & CEF_PERMISSION_TYPE_KEYBOARD_LOCK) add("Keyboard lock");
    if (mask & CEF_PERMISSION_TYPE_POINTER_LOCK) add("Pointer lock");
    if (mask & CEF_PERMISSION_TYPE_PROTECTED_MEDIA_IDENTIFIER) add("Protected media identifier");
    if (mask & CEF_PERMISSION_TYPE_REGISTER_PROTOCOL_HANDLER) add("Register protocol handler");
    if (mask & CEF_PERMISSION_TYPE_STORAGE_ACCESS) add("Storage access");
    if (mask & CEF_PERMISSION_TYPE_VR_SESSION) add("VR session");
    if (mask & CEF_PERMISSION_TYPE_WEB_APP_INSTALLATION) add("Web app installation");
    if (mask & CEF_PERMISSION_TYPE_WINDOW_MANAGEMENT) add("Window management");
    if (mask & CEF_PERMISSION_TYPE_FILE_SYSTEM_ACCESS) add("File system access");
#if CEF_API_ADDED(13600)
    if (mask & CEF_PERMISSION_TYPE_LOCAL_NETWORK_ACCESS) add("Local network access");
#endif
#if CEF_API_ADDED(14500)
    if (mask & CEF_PERMISSION_TYPE_LOCAL_NETWORK) add("Local network");
    if (mask & CEF_PERMISSION_TYPE_LOOPBACK_NETWORK) add("Loopback network");
#endif
#if CEF_API_ADDED(14700)
    if (mask & CEF_PERMISSION_TYPE_SENSORS) add("Sensors");
#endif

    if (out.empty()) {
        char buf[64];
        snprintf(buf, sizeof(buf), "unknown (bitmask 0x%x)", mask);
        out = buf;
    }
    return out;
}

} // namespace electrobun

#endif // ELECTROBUN_PERMISSIONS_CEF_H

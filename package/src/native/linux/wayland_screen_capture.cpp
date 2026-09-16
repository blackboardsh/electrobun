#include "wayland_screen_capture.h"

#include <cstdlib>
#include <cstring>

#ifdef ELECTROBUN_ENABLE_WAYLAND_SCREEN_CAPTURE

#include <gio/gio.h>
#include <glib.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <string>

#include <unistd.h>

#include "wayland_pipewire_capture.h"

namespace electrobun::wayland_screen_capture {
namespace {

constexpr const char* kPortalBusName = "org.freedesktop.portal.Desktop";
constexpr const char* kPortalObjectPath = "/org/freedesktop/portal/desktop";
constexpr const char* kScreenCastInterface =
    "org.freedesktop.portal.ScreenCast";
constexpr const char* kPropertiesInterface =
    "org.freedesktop.DBus.Properties";
constexpr const char* kRequestInterface = "org.freedesktop.portal.Request";
constexpr const char* kSessionInterface = "org.freedesktop.portal.Session";

enum class CaptureState {
    idle,
    scheduled,
    connecting_bus,
    creating_session,
    selecting_sources,
    starting_session,
    opening_remote,
    streaming,
    cancelled,
    failed,
    shutting_down,
    shut_down,
};

enum class RequestKind {
    none,
    create_session,
    select_sources,
    start_session,
};

struct PortalStream {
    uint32_t nodeId = 0;
    int logicalX = 0;
    int logicalY = 0;
    int logicalWidth = 0;
    int logicalHeight = 0;
};

struct CaptureSession {
    std::mutex stateMutex;
    CaptureState state = CaptureState::idle;

    // Portal fields are owned and mutated on the default GLib main context.
    GDBusConnection* connection = nullptr;
    GCancellable* cancellable = nullptr;
    guint requestSubscription = 0;
    guint sessionSubscription = 0;
    RequestKind pendingRequest = RequestKind::none;
    std::string pendingRequestPath;
    std::string sessionPath;
    PortalStream stream;
    uint32_t cursorMode = 0;
};

CaptureSession& session() {
    // Deliberately leaked process-lifetime state: async GIO callbacks may still
    // observe it while shutdown cancellation is being delivered.
    static CaptureSession* value = new CaptureSession();
    return *value;
}

bool isTerminalState(CaptureState state) {
    return state == CaptureState::cancelled || state == CaptureState::failed ||
           state == CaptureState::shutting_down ||
           state == CaptureState::shut_down;
}

void logMessage(const char* message) {
    g_printerr("[electrobun] Wayland screen capture: %s\n", message);
}

void logError(const char* action, const GError* error) {
    g_printerr(
        "[electrobun] Wayland screen capture: %s: %s\n",
        action,
        error && error->message ? error->message : "unknown error");
}

std::string makeToken(const char* prefix) {
    static std::atomic<uint64_t> counter{0};
    const uint64_t serial = counter.fetch_add(1, std::memory_order_relaxed);
    const guint32 random = g_random_int();
    char token[96];
    g_snprintf(
        token,
        sizeof(token),
        "electrobun_%s_%08x_%llu",
        prefix,
        random,
        static_cast<unsigned long long>(serial));
    return token;
}

std::string requestPathForToken(
    GDBusConnection* connection,
    const std::string& token) {
    const char* uniqueName = g_dbus_connection_get_unique_name(connection);
    if (!uniqueName || uniqueName[0] != ':') return {};

    std::string sender(uniqueName + 1);
    std::replace(sender.begin(), sender.end(), '.', '_');
    return "/org/freedesktop/portal/desktop/request/" + sender + "/" +
           token;
}

GVariant* finishOptions(GVariantBuilder* builder) {
    return g_variant_builder_end(builder);
}

void addStringOption(
    GVariantBuilder* builder,
    const char* key,
    const std::string& value) {
    g_variant_builder_add(
        builder,
        "{sv}",
        key,
        g_variant_new_string(value.c_str()));
}

void addUintOption(GVariantBuilder* builder, const char* key, guint32 value) {
    g_variant_builder_add(
        builder,
        "{sv}",
        key,
        g_variant_new_uint32(value));
}

void addBoolOption(GVariantBuilder* builder, const char* key, bool value) {
    g_variant_builder_add(
        builder,
        "{sv}",
        key,
        g_variant_new_boolean(value));
}

uint32_t preferredCursorMode(GDBusConnection* connection) {
    GError* error = nullptr;
    GVariant* reply = g_dbus_connection_call_sync(
        connection,
        kPortalBusName,
        kPortalObjectPath,
        kPropertiesInterface,
        "Get",
        g_variant_new(
            "(ss)", kScreenCastInterface, "AvailableCursorModes"),
        G_VARIANT_TYPE("(v)"),
        G_DBUS_CALL_FLAGS_NONE,
        2000,
        nullptr,
        &error);
    if (!reply) {
        logError("could not query portal cursor modes", error);
        if (error) g_error_free(error);
        return 0;
    }

    uint32_t available = 0;
    GVariant* boxed = g_variant_get_child_value(reply, 0);
    GVariant* value = g_variant_get_variant(boxed);
    if (g_variant_is_of_type(value, G_VARIANT_TYPE_UINT32)) {
        available = g_variant_get_uint32(value);
    }
    g_variant_unref(value);
    g_variant_unref(boxed);
    g_variant_unref(reply);

    constexpr uint32_t kHidden = 1;
    constexpr uint32_t kEmbedded = 2;
    constexpr uint32_t kMetadata = 4;
    if ((available & kMetadata) != 0) return kMetadata;
    if ((available & kHidden) != 0) return kHidden;
    if ((available & kEmbedded) != 0) return kEmbedded;
    return 0;
}

void closePortalObjects(CaptureSession& capture) {
    if (!capture.connection) return;

    if (!capture.pendingRequestPath.empty()) {
        g_dbus_connection_call(
            capture.connection,
            kPortalBusName,
            capture.pendingRequestPath.c_str(),
            kRequestInterface,
            "Close",
            nullptr,
            nullptr,
            G_DBUS_CALL_FLAGS_NONE,
            -1,
            nullptr,
            nullptr,
            nullptr);
        capture.pendingRequestPath.clear();
        capture.pendingRequest = RequestKind::none;
    }

    if (!capture.sessionPath.empty()) {
        g_dbus_connection_call(
            capture.connection,
            kPortalBusName,
            capture.sessionPath.c_str(),
            kSessionInterface,
            "Close",
            nullptr,
            nullptr,
            G_DBUS_CALL_FLAGS_NONE,
            -1,
            nullptr,
            nullptr,
            nullptr);
        capture.sessionPath.clear();
    }
}

void stopCaptureStream() {
    wayland_pipewire_capture::stop();
}

void markFailed(CaptureSession& capture, const char* reason) {
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (isTerminalState(capture.state)) return;
        capture.state = CaptureState::failed;
    }
    logMessage(reason);
    closePortalObjects(capture);
    stopCaptureStream();
}

void markFailed(CaptureSession& capture, const char* action, GError* error) {
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (isTerminalState(capture.state)) {
            if (error) g_error_free(error);
            return;
        }
        capture.state = CaptureState::failed;
    }
    logError(action, error);
    if (error) g_error_free(error);
    closePortalObjects(capture);
    stopCaptureStream();
}

void markCancelled(CaptureSession& capture) {
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (isTerminalState(capture.state)) return;
        capture.state = CaptureState::cancelled;
    }
    logMessage("the user cancelled monitor sharing");
    closePortalObjects(capture);
    stopCaptureStream();
}

struct MethodCallContext {
    CaptureSession* capture = nullptr;
    RequestKind kind = RequestKind::none;
    std::string predictedPath;
};

void onPortalMethodReturned(
    GObject* source,
    GAsyncResult* result,
    gpointer userData) {
    std::unique_ptr<MethodCallContext> context(
        static_cast<MethodCallContext*>(userData));
    CaptureSession& capture = *context->capture;

    GError* error = nullptr;
    GVariant* reply = g_dbus_connection_call_finish(
        G_DBUS_CONNECTION(source), result, &error);
    if (!reply) {
        bool stillPending = false;
        {
            std::lock_guard<std::mutex> lock(capture.stateMutex);
            stillPending = capture.pendingRequest == context->kind &&
                           !isTerminalState(capture.state);
        }
        if (stillPending) {
            markFailed(capture, "portal method call failed", error);
        } else if (error) {
            g_error_free(error);
        }
        return;
    }

    const char* returnedPath = nullptr;
    g_variant_get(reply, "(&o)", &returnedPath);
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (capture.pendingRequest == context->kind && returnedPath &&
            capture.pendingRequestPath == context->predictedPath) {
            // Modern portals return the predicted path. Keeping the actual path
            // also supports older implementations whose handle differs.
            capture.pendingRequestPath = returnedPath;
        }
    }
    g_variant_unref(reply);
}

void callPortalRequest(
    CaptureSession& capture,
    RequestKind kind,
    const char* method,
    GVariant* parameters,
    const std::string& token) {
    const std::string predictedPath =
        requestPathForToken(capture.connection, token);
    if (predictedPath.empty()) {
        if (parameters) g_variant_unref(g_variant_ref_sink(parameters));
        markFailed(capture, "session bus did not provide a unique sender name");
        return;
    }

    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        capture.pendingRequest = kind;
        capture.pendingRequestPath = predictedPath;
    }

    auto* context = new MethodCallContext{
        .capture = &capture,
        .kind = kind,
        .predictedPath = predictedPath,
    };
    g_dbus_connection_call(
        capture.connection,
        kPortalBusName,
        kPortalObjectPath,
        kScreenCastInterface,
        method,
        parameters,
        G_VARIANT_TYPE("(o)"),
        G_DBUS_CALL_FLAGS_NONE,
        -1,
        capture.cancellable,
        onPortalMethodReturned,
        context);
}

void requestSelectSources(CaptureSession& capture);
void requestStartSession(CaptureSession& capture);
void openPipeWireRemote(CaptureSession& capture);

void onPipeWireRemoteOpened(
    GObject* source,
    GAsyncResult* result,
    gpointer userData) {
    auto& capture = *static_cast<CaptureSession*>(userData);
    GError* error = nullptr;
    GUnixFDList* fdList = nullptr;
    GVariant* reply = g_dbus_connection_call_with_unix_fd_list_finish(
        G_DBUS_CONNECTION(source), &fdList, result, &error);
    if (!reply) {
        if (fdList) g_object_unref(fdList);
        markFailed(capture, "could not open the portal PipeWire remote", error);
        return;
    }

    gint32 fdIndex = -1;
    g_variant_get(reply, "(h)", &fdIndex);
    g_variant_unref(reply);
    if (!fdList || fdIndex < 0) {
        if (fdList) g_object_unref(fdList);
        markFailed(capture, "portal returned no PipeWire file descriptor");
        return;
    }

    const int fd = g_unix_fd_list_get(fdList, fdIndex, &error);
    g_object_unref(fdList);
    if (fd < 0) {
        markFailed(capture, "could not duplicate the portal PipeWire fd", error);
        return;
    }

    PortalStream stream;
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (isTerminalState(capture.state)) {
            close(fd);
            return;
        }
        stream = capture.stream;
    }

    const wayland_pipewire_capture::LogicalBounds bounds{
        .x = stream.logicalX,
        .y = stream.logicalY,
        .width = static_cast<uint32_t>(stream.logicalWidth),
        .height = static_cast<uint32_t>(stream.logicalHeight),
    };
    // start() takes ownership of fd, including when startup fails.
    if (!wayland_pipewire_capture::start(fd, stream.nodeId, bounds)) {
        markFailed(capture, "could not start the PipeWire capture stream");
        return;
    }

    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (isTerminalState(capture.state)) {
            stopCaptureStream();
            return;
        }
        capture.state = CaptureState::streaming;
    }
    logMessage("monitor sharing approved; awaiting the first PipeWire frame");
}

void openPipeWireRemote(CaptureSession& capture) {
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (isTerminalState(capture.state)) return;
        capture.state = CaptureState::opening_remote;
    }

    GVariantBuilder options;
    g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
    g_dbus_connection_call_with_unix_fd_list(
        capture.connection,
        kPortalBusName,
        kPortalObjectPath,
        kScreenCastInterface,
        "OpenPipeWireRemote",
        g_variant_new(
            "(o@a{sv})",
            capture.sessionPath.c_str(),
            finishOptions(&options)),
        G_VARIANT_TYPE("(h)"),
        G_DBUS_CALL_FLAGS_NONE,
        -1,
        nullptr,
        capture.cancellable,
        onPipeWireRemoteOpened,
        &capture);
}

bool parseFirstStream(GVariant* results, PortalStream* stream) {
    GVariant* streams = g_variant_lookup_value(
        results, "streams", G_VARIANT_TYPE("a(ua{sv})"));
    if (!streams) return false;

    GVariantIter iterator;
    g_variant_iter_init(&iterator, streams);
    guint32 nodeId = 0;
    GVariant* properties = nullptr;
    const bool found =
        g_variant_iter_next(&iterator, "(u@a{sv})", &nodeId, &properties);
    g_variant_unref(streams);
    if (!found || !properties) return false;

    gint32 x = 0;
    gint32 y = 0;
    gint32 width = 0;
    gint32 height = 0;
    const bool hasPosition =
        g_variant_lookup(properties, "position", "(ii)", &x, &y);
    const bool hasSize =
        g_variant_lookup(properties, "size", "(ii)", &width, &height);

    g_variant_unref(properties);

    if (!hasPosition || !hasSize || width <= 0 || height <= 0) {
        logMessage(
            "portal stream omitted the monitor position/size needed for "
            "logical coordinate mapping");
        return false;
    }

    stream->nodeId = nodeId;
    stream->logicalX = x;
    stream->logicalY = y;
    stream->logicalWidth = width;
    stream->logicalHeight = height;
    return true;
}

void requestSelectSources(CaptureSession& capture) {
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (isTerminalState(capture.state)) return;
        capture.state = CaptureState::selecting_sources;
    }

    const std::string token = makeToken("select");
    GVariantBuilder options;
    g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
    addStringOption(&options, "handle_token", token);
    addUintOption(&options, "types", 1);  // MONITOR
    addBoolOption(&options, "multiple", false);
    if (capture.cursorMode != 0) {
        addUintOption(&options, "cursor_mode", capture.cursorMode);
    }
    callPortalRequest(
        capture,
        RequestKind::select_sources,
        "SelectSources",
        g_variant_new(
            "(o@a{sv})",
            capture.sessionPath.c_str(),
            finishOptions(&options)),
        token);
}

void requestStartSession(CaptureSession& capture) {
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (isTerminalState(capture.state)) return;
        capture.state = CaptureState::starting_session;
    }

    const std::string token = makeToken("start");
    GVariantBuilder options;
    g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
    addStringOption(&options, "handle_token", token);
    callPortalRequest(
        capture,
        RequestKind::start_session,
        "Start",
        // captureRegion has no initiating-window parameter. The portal spec
        // permits an empty parent, and the chooser remains compositor-owned.
        g_variant_new(
            "(os@a{sv})",
            capture.sessionPath.c_str(),
            "",
            finishOptions(&options)),
        token);
}

void onSessionClosed(
    GDBusConnection*,
    const gchar*,
    const gchar*,
    const gchar*,
    const gchar*,
    GVariant*,
    gpointer userData) {
    auto& capture = *static_cast<CaptureSession*>(userData);
    markFailed(capture, "desktop portal closed the screen-capture session");
}

void onRequestResponse(
    GDBusConnection*,
    const gchar*,
    const gchar* objectPath,
    const gchar*,
    const gchar*,
    GVariant* parameters,
    gpointer userData) {
    auto& capture = *static_cast<CaptureSession*>(userData);

    RequestKind kind = RequestKind::none;
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (capture.pendingRequest == RequestKind::none ||
            capture.pendingRequestPath != objectPath ||
            isTerminalState(capture.state)) {
            return;
        }
        kind = capture.pendingRequest;
        capture.pendingRequest = RequestKind::none;
        capture.pendingRequestPath.clear();
    }

    guint32 response = 2;
    GVariant* results = nullptr;
    g_variant_get(parameters, "(u@a{sv})", &response, &results);
    if (response != 0) {
        if (results) g_variant_unref(results);
        if (response == 1) markCancelled(capture);
        else markFailed(capture, "desktop portal rejected the capture request");
        return;
    }

    switch (kind) {
        case RequestKind::create_session: {
            const char* sessionPath = nullptr;
            if (!results || !g_variant_lookup(
                                results,
                                "session_handle",
                                "&s",
                                &sessionPath) ||
                !sessionPath || !*sessionPath) {
                if (results) g_variant_unref(results);
                markFailed(capture, "portal returned no ScreenCast session handle");
                return;
            }
            capture.sessionPath = sessionPath;
            capture.sessionSubscription =
                g_dbus_connection_signal_subscribe(
                    capture.connection,
                    kPortalBusName,
                    kSessionInterface,
                    "Closed",
                    capture.sessionPath.c_str(),
                    nullptr,
                    G_DBUS_SIGNAL_FLAGS_NONE,
                    onSessionClosed,
                    &capture,
                    nullptr);
            g_variant_unref(results);
            requestSelectSources(capture);
            return;
        }
        case RequestKind::select_sources:
            if (results) g_variant_unref(results);
            requestStartSession(capture);
            return;
        case RequestKind::start_session:
            if (!results || !parseFirstStream(results, &capture.stream)) {
                if (results) g_variant_unref(results);
                markFailed(capture, "portal returned no mappable monitor stream");
                return;
            }
            g_variant_unref(results);
            openPipeWireRemote(capture);
            return;
        case RequestKind::none:
            break;
    }
    if (results) g_variant_unref(results);
}

void requestCreateSession(CaptureSession& capture) {
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (isTerminalState(capture.state)) return;
        capture.state = CaptureState::creating_session;
    }

    const std::string requestToken = makeToken("create");
    const std::string sessionToken = makeToken("session");
    GVariantBuilder options;
    g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
    addStringOption(&options, "handle_token", requestToken);
    addStringOption(&options, "session_handle_token", sessionToken);
    callPortalRequest(
        capture,
        RequestKind::create_session,
        "CreateSession",
        g_variant_new("(@a{sv})", finishOptions(&options)),
        requestToken);
}

void onSessionBusReady(
    GObject*,
    GAsyncResult* result,
    gpointer userData) {
    auto& capture = *static_cast<CaptureSession*>(userData);
    GError* error = nullptr;
    GDBusConnection* connection = g_bus_get_finish(result, &error);
    if (!connection) {
        markFailed(capture, "could not connect to the session bus", error);
        return;
    }
    const uint32_t cursorMode = preferredCursorMode(connection);

    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (isTerminalState(capture.state)) {
            g_object_unref(connection);
            return;
        }
        capture.connection = connection;
        capture.cursorMode = cursorMode;
    }

    // Subscribe before issuing CreateSession. handle_token lets us predict the
    // Request path, while the broad subscription also avoids missing a very
    // fast response before the method-return callback has verified that path.
    capture.requestSubscription = g_dbus_connection_signal_subscribe(
        connection,
        kPortalBusName,
        kRequestInterface,
        "Response",
        nullptr,
        nullptr,
        G_DBUS_SIGNAL_FLAGS_NONE,
        onRequestResponse,
        &capture,
        nullptr);
    requestCreateSession(capture);
}

gboolean beginPortalCapture(gpointer userData) {
    auto& capture = *static_cast<CaptureSession*>(userData);
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (capture.state != CaptureState::scheduled) return G_SOURCE_REMOVE;
        capture.state = CaptureState::connecting_bus;
    }

    capture.cancellable = g_cancellable_new();
    g_bus_get(
        G_BUS_TYPE_SESSION,
        capture.cancellable,
        onSessionBusReady,
        &capture);
    return G_SOURCE_REMOVE;
}

void ensureCaptureScheduled(CaptureSession& capture) {
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (capture.state != CaptureState::idle) return;
        capture.state = CaptureState::scheduled;
    }
    g_main_context_invoke(nullptr, beginPortalCapture, &capture);
}

}  // namespace

bool isWaylandSession() {
    const char* sessionType = g_getenv("XDG_SESSION_TYPE");
    const char* waylandDisplay = g_getenv("WAYLAND_DISPLAY");
    return (sessionType &&
            g_ascii_strcasecmp(sessionType, "wayland") == 0) ||
           (waylandDisplay && *waylandDisplay != '\0');
}

bool captureRegion(
    double x,
    double y,
    uint32_t width,
    uint32_t height,
    uint8_t* outRgba,
    uint64_t outLen) {
    CaptureSession& capture = session();
    ensureCaptureScheduled(capture);

    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (capture.state != CaptureState::streaming) return false;
    }
    if (wayland_pipewire_capture::hasFailed()) {
        markFailed(capture, "the PipeWire capture stream stopped unexpectedly");
        return false;
    }
    return wayland_pipewire_capture::capture(
        x, y, width, height, outRgba, outLen);
}

bool getCursorScreenPoint(double* x, double* y) {
    if (!x || !y) return false;
    wayland_pipewire_capture::CursorPoint cursor{};
    if (!wayland_pipewire_capture::getCursorPoint(&cursor)) return false;
    *x = cursor.logicalX;
    *y = cursor.logicalY;
    return true;
}

void shutdown() {
    CaptureSession& capture = session();
    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        if (capture.state == CaptureState::shutting_down ||
            capture.state == CaptureState::shut_down) {
            return;
        }
        capture.state = CaptureState::shutting_down;
    }

    if (capture.cancellable) g_cancellable_cancel(capture.cancellable);
    closePortalObjects(capture);
    stopCaptureStream();

    if (capture.connection) {
        if (capture.requestSubscription != 0) {
            g_dbus_connection_signal_unsubscribe(
                capture.connection, capture.requestSubscription);
            capture.requestSubscription = 0;
        }
        if (capture.sessionSubscription != 0) {
            g_dbus_connection_signal_unsubscribe(
                capture.connection, capture.sessionSubscription);
            capture.sessionSubscription = 0;
        }
        g_object_unref(capture.connection);
        capture.connection = nullptr;
    }
    if (capture.cancellable) {
        g_object_unref(capture.cancellable);
        capture.cancellable = nullptr;
    }

    {
        std::lock_guard<std::mutex> lock(capture.stateMutex);
        capture.state = CaptureState::shut_down;
    }
}

}  // namespace electrobun::wayland_screen_capture

#else

namespace electrobun::wayland_screen_capture {

bool isWaylandSession() {
    const char* sessionType = std::getenv("XDG_SESSION_TYPE");
    const char* waylandDisplay = std::getenv("WAYLAND_DISPLAY");
    return (sessionType && std::strcmp(sessionType, "wayland") == 0) ||
           (waylandDisplay && *waylandDisplay != '\0');
}

bool captureRegion(
    double,
    double,
    uint32_t,
    uint32_t,
    uint8_t*,
    uint64_t) {
    return false;
}

bool getCursorScreenPoint(double*, double*) {
    return false;
}

void shutdown() {}

}  // namespace electrobun::wayland_screen_capture

#endif

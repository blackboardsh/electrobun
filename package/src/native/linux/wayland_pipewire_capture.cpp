#include "wayland_pipewire_capture.h"

#include <unistd.h>

#if defined(ELECTROBUN_ENABLE_WAYLAND_SCREEN_CAPTURE)

#include <dlfcn.h>

#include <pipewire/pipewire.h>
#include <spa/buffer/buffer.h>
#include <spa/buffer/meta.h>
#include <spa/param/buffers.h>
#include <spa/param/video/format-utils.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <limits>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "../shared/wayland_screen_capture_frame.h"

namespace electrobun::wayland_pipewire_capture {
namespace {

constexpr const char* kPipeWireLibrary = "libpipewire-0.3.so.0";
constexpr std::uint32_t kMaximumFrameExtent = 32768;

constexpr std::int32_t cursorMetaSize(std::uint32_t width, std::uint32_t height) {
    return static_cast<std::int32_t>(
        sizeof(spa_meta_cursor) + sizeof(spa_meta_bitmap) +
        static_cast<std::uint64_t>(width) * height * 4);
}

constexpr std::int32_t kMinimumCursorMetaSize = cursorMetaSize(1, 1);
constexpr std::int32_t kDefaultCursorMetaSize = cursorMetaSize(384, 384);
constexpr std::int32_t kMaximumCursorMetaSize = cursorMetaSize(512, 512);

static_assert(kDefaultCursorMetaSize >= cursorMetaSize(384, 384));
static_assert(kMaximumCursorMetaSize > kDefaultCursorMetaSize);

void logMessage(const char* message) {
    std::fprintf(stderr, "[electrobun] Wayland PipeWire capture: %s\n", message);
}

void logMessage(const char* action, const char* detail) {
    std::fprintf(
        stderr,
        "[electrobun] Wayland PipeWire capture: %s: %s\n",
        action,
        detail ? detail : "unknown error");
}

struct PipeWireApi {
    using Init = void (*)(int*, char***);
    using Deinit = void (*)();
    using MainLoopNew = pw_main_loop* (*)(const spa_dict*);
    using MainLoopGetLoop = pw_loop* (*)(pw_main_loop*);
    using MainLoopRun = int (*)(pw_main_loop*);
    using MainLoopQuit = int (*)(pw_main_loop*);
    using MainLoopDestroy = void (*)(pw_main_loop*);
    using ContextNew = pw_context* (*)(pw_loop*, pw_properties*, std::size_t);
    using ContextConnectFd =
        pw_core* (*)(pw_context*, int, pw_properties*, std::size_t);
    using ContextDestroy = void (*)(pw_context*);
    using CoreDisconnect = int (*)(pw_core*);
    using PropertiesNew = pw_properties* (*)(const char*, ...);
    using StreamNew = pw_stream* (*)(pw_core*, const char*, pw_properties*);
    using StreamDestroy = void (*)(pw_stream*);
    using StreamAddListener = void (*)(
        pw_stream*,
        spa_hook*,
        const pw_stream_events*,
        void*);
    using StreamConnect = int (*)(
        pw_stream*,
        pw_direction,
        std::uint32_t,
        pw_stream_flags,
        const spa_pod**,
        std::uint32_t);
    using StreamUpdateParams =
        int (*)(pw_stream*, const spa_pod**, std::uint32_t);
    using StreamDequeueBuffer = pw_buffer* (*)(pw_stream*);
    using StreamQueueBuffer = int (*)(pw_stream*, pw_buffer*);

    void* library = nullptr;
    Init init = nullptr;
    Deinit deinit = nullptr;
    MainLoopNew mainLoopNew = nullptr;
    MainLoopGetLoop mainLoopGetLoop = nullptr;
    MainLoopRun mainLoopRun = nullptr;
    MainLoopQuit mainLoopQuit = nullptr;
    MainLoopDestroy mainLoopDestroy = nullptr;
    ContextNew contextNew = nullptr;
    ContextConnectFd contextConnectFd = nullptr;
    ContextDestroy contextDestroy = nullptr;
    CoreDisconnect coreDisconnect = nullptr;
    PropertiesNew propertiesNew = nullptr;
    StreamNew streamNew = nullptr;
    StreamDestroy streamDestroy = nullptr;
    StreamAddListener streamAddListener = nullptr;
    StreamConnect streamConnect = nullptr;
    StreamUpdateParams streamUpdateParams = nullptr;
    StreamDequeueBuffer streamDequeueBuffer = nullptr;
    StreamQueueBuffer streamQueueBuffer = nullptr;

    template <typename Function>
    bool resolve(Function* function, const char* name) {
        dlerror();
        void* symbol = dlsym(library, name);
        const char* error = dlerror();
        if (error || !symbol) {
            logMessage(name, error ? error : "symbol was not found");
            return false;
        }
        *function = reinterpret_cast<Function>(symbol);
        return true;
    }

    bool load() {
        library = dlopen(kPipeWireLibrary, RTLD_NOW | RTLD_LOCAL);
        if (!library) {
            logMessage("could not load libpipewire-0.3.so.0", dlerror());
            return false;
        }

        const bool loaded =
            resolve(&init, "pw_init") &&
            resolve(&deinit, "pw_deinit") &&
            resolve(&mainLoopNew, "pw_main_loop_new") &&
            resolve(&mainLoopGetLoop, "pw_main_loop_get_loop") &&
            resolve(&mainLoopRun, "pw_main_loop_run") &&
            resolve(&mainLoopQuit, "pw_main_loop_quit") &&
            resolve(&mainLoopDestroy, "pw_main_loop_destroy") &&
            resolve(&contextNew, "pw_context_new") &&
            resolve(&contextConnectFd, "pw_context_connect_fd") &&
            resolve(&contextDestroy, "pw_context_destroy") &&
            resolve(&coreDisconnect, "pw_core_disconnect") &&
            resolve(&propertiesNew, "pw_properties_new") &&
            resolve(&streamNew, "pw_stream_new") &&
            resolve(&streamDestroy, "pw_stream_destroy") &&
            resolve(&streamAddListener, "pw_stream_add_listener") &&
            resolve(&streamConnect, "pw_stream_connect") &&
            resolve(&streamUpdateParams, "pw_stream_update_params") &&
            resolve(&streamDequeueBuffer, "pw_stream_dequeue_buffer") &&
            resolve(&streamQueueBuffer, "pw_stream_queue_buffer");
        if (!loaded) unload();
        return loaded;
    }

    void unload() {
        if (library) dlclose(library);
        *this = PipeWireApi{};
    }
};

enum class State {
    stopped,
    starting,
    streaming,
    failed,
    stopping,
};

struct CachedFrame {
    std::vector<std::uint8_t> rgba;
    std::uint32_t pixelWidth = 0;
    std::uint32_t pixelHeight = 0;
    LogicalBounds logicalBounds{};
};

struct CachedCursor {
    bool valid = false;
    double logicalX = 0;
    double logicalY = 0;
    std::int32_t hotspotPixelX = 0;
    std::int32_t hotspotPixelY = 0;
};

struct Session {
    // start() and stop() serialize on this mutex. The worker never takes it,
    // allowing stop() to hold it while joining the thread.
    std::mutex controlMutex;
    std::thread worker;
    PipeWireApi api;
    std::atomic<State> state{State::stopped};
    std::atomic<bool> stopRequested{false};

    std::mutex runtimeMutex;
    pw_main_loop* runtimeMainLoop = nullptr;

    LogicalBounds logicalBounds{};
    std::uint32_t nodeId = 0;
    std::atomic<bool> refreshRequested{true};
    std::atomic<bool> hasFrame{false};

    std::mutex cacheMutex;
    CachedFrame frame;
    CachedCursor cursor;
};

Session& session() {
    // Explicit shutdown occurs before the native wrapper exits. Keeping this
    // process-lifetime object alive avoids destructor-order races with dynamic
    // library teardown if an embedding application skips orderly shutdown.
    static Session* value = new Session();
    return *value;
}

void clearCache(Session& capture) {
    std::lock_guard<std::mutex> lock(capture.cacheMutex);
    capture.frame = CachedFrame{};
    capture.cursor = CachedCursor{};
    capture.hasFrame.store(false, std::memory_order_release);
}

struct WorkerRuntime {
    Session* capture = nullptr;
    PipeWireApi* api = nullptr;
    pw_main_loop* mainLoop = nullptr;
    pw_context* context = nullptr;
    pw_core* core = nullptr;
    pw_stream* stream = nullptr;
    spa_hook streamListener{};
    spa_video_info_raw video{};
    bool formatReady = false;
    bool reportedUnsupportedTransform = false;
};

void failWorker(WorkerRuntime& runtime, const char* reason) {
    State expected = runtime.capture->state.load(std::memory_order_acquire);
    if (expected != State::stopping && expected != State::stopped) {
        runtime.capture->state.store(State::failed, std::memory_order_release);
        logMessage(reason);
    }
    if (runtime.mainLoop) runtime.api->mainLoopQuit(runtime.mainLoop);
}

int bytesPerPixel(spa_video_format format) {
    switch (format) {
        case SPA_VIDEO_FORMAT_BGRx:
        case SPA_VIDEO_FORMAT_BGRA:
        case SPA_VIDEO_FORMAT_RGBx:
        case SPA_VIDEO_FORMAT_RGBA:
            return 4;
        default:
            return 0;
    }
}

void onStreamStateChanged(
    void* userData,
    pw_stream_state,
    pw_stream_state state,
    const char* error) {
    auto& runtime = *static_cast<WorkerRuntime*>(userData);
    if (state == PW_STREAM_STATE_STREAMING) {
        runtime.capture->state.store(State::streaming, std::memory_order_release);
    } else if (state == PW_STREAM_STATE_ERROR) {
        logMessage("PipeWire stream failed", error);
        failWorker(runtime, "the PipeWire stream entered an error state");
    } else if (state == PW_STREAM_STATE_UNCONNECTED &&
               !runtime.capture->stopRequested.load(std::memory_order_acquire)) {
        failWorker(runtime, "the PipeWire stream disconnected");
    }
}

void onStreamParamChanged(
    void* userData,
    std::uint32_t id,
    const spa_pod* parameter) {
    auto& runtime = *static_cast<WorkerRuntime*>(userData);
    if (!parameter || id != SPA_PARAM_Format) return;

    std::uint32_t mediaType = 0;
    std::uint32_t mediaSubtype = 0;
    if (spa_format_parse(parameter, &mediaType, &mediaSubtype) < 0 ||
        mediaType != SPA_MEDIA_TYPE_video ||
        mediaSubtype != SPA_MEDIA_SUBTYPE_raw ||
        spa_format_video_raw_parse(parameter, &runtime.video) < 0 ||
        bytesPerPixel(runtime.video.format) != 4 ||
        runtime.video.size.width == 0 || runtime.video.size.height == 0) {
        failWorker(runtime, "the portal negotiated an unsupported video format");
        return;
    }

    const std::uint64_t stride64 =
        static_cast<std::uint64_t>(runtime.video.size.width) * 4;
    const std::uint64_t size64 = stride64 * runtime.video.size.height;
    if (stride64 > std::numeric_limits<std::int32_t>::max() ||
        size64 > std::numeric_limits<std::int32_t>::max()) {
        failWorker(runtime, "the negotiated screen frame is too large");
        return;
    }

    std::uint8_t storage[2048];
    spa_pod_builder builder{};
    spa_pod_builder_init(&builder, storage, sizeof(storage));
    const spa_pod* parameters[5]{};

    parameters[0] = static_cast<const spa_pod*>(spa_pod_builder_add_object(
        &builder,
        SPA_TYPE_OBJECT_ParamBuffers,
        SPA_PARAM_Buffers,
        SPA_PARAM_BUFFERS_buffers,
        SPA_POD_CHOICE_RANGE_Int(8, 2, 16),
        SPA_PARAM_BUFFERS_blocks,
        SPA_POD_Int(1),
        SPA_PARAM_BUFFERS_size,
        SPA_POD_Int(static_cast<std::int32_t>(size64)),
        SPA_PARAM_BUFFERS_stride,
        SPA_POD_Int(static_cast<std::int32_t>(stride64)),
        SPA_PARAM_BUFFERS_dataType,
        SPA_POD_CHOICE_FLAGS_Int(
            (1 << SPA_DATA_MemPtr) | (1 << SPA_DATA_MemFd))));

    parameters[1] = static_cast<const spa_pod*>(spa_pod_builder_add_object(
        &builder,
        SPA_TYPE_OBJECT_ParamMeta,
        SPA_PARAM_Meta,
        SPA_PARAM_META_type,
        SPA_POD_Id(SPA_META_Header),
        SPA_PARAM_META_size,
        SPA_POD_Int(sizeof(spa_meta_header))));

    parameters[2] = static_cast<const spa_pod*>(spa_pod_builder_add_object(
        &builder,
        SPA_TYPE_OBJECT_ParamMeta,
        SPA_PARAM_Meta,
        SPA_PARAM_META_type,
        SPA_POD_Id(SPA_META_VideoCrop),
        SPA_PARAM_META_size,
        SPA_POD_Int(sizeof(spa_meta_region))));

    // Mutter 48 offers a fixed 384x384 cursor metadata capacity. The 256x256
    // maximum used by older PipeWire examples has an empty negotiation
    // intersection and silently removes SPA_META_Cursor from every buffer.
    parameters[3] = static_cast<const spa_pod*>(spa_pod_builder_add_object(
        &builder,
        SPA_TYPE_OBJECT_ParamMeta,
        SPA_PARAM_Meta,
        SPA_PARAM_META_type,
        SPA_POD_Id(SPA_META_Cursor),
        SPA_PARAM_META_size,
        SPA_POD_CHOICE_RANGE_Int(
            kDefaultCursorMetaSize,
            kMinimumCursorMetaSize,
            kMaximumCursorMetaSize)));

    // Most monitor streams are already upright. Request transform metadata so
    // that another compositor cannot make us return incorrectly oriented
    // pixels silently; non-identity transforms are rejected in processBuffer.
    parameters[4] = static_cast<const spa_pod*>(spa_pod_builder_add_object(
        &builder,
        SPA_TYPE_OBJECT_ParamMeta,
        SPA_PARAM_Meta,
        SPA_PARAM_META_type,
        SPA_POD_Id(SPA_META_VideoTransform),
        SPA_PARAM_META_size,
        SPA_POD_Int(sizeof(spa_meta_videotransform))));

    const int result =
        runtime.api->streamUpdateParams(runtime.stream, parameters, 5);
    if (result < 0) {
        failWorker(runtime, "PipeWire rejected the screen buffer parameters");
        return;
    }

    runtime.formatReady = true;
    runtime.capture->refreshRequested.store(true, std::memory_order_release);
}

bool checkedMultiply(
    std::size_t left,
    std::size_t right,
    std::size_t* result) {
    if (!result ||
        (right != 0 && left > std::numeric_limits<std::size_t>::max() / right)) {
        return false;
    }
    *result = left * right;
    return true;
}

bool checkedAdd(std::size_t left, std::size_t right, std::size_t* result) {
    if (!result || left > std::numeric_limits<std::size_t>::max() - right) {
        return false;
    }
    *result = left + right;
    return true;
}

struct Crop {
    std::uint32_t x = 0;
    std::uint32_t y = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

Crop getCrop(const WorkerRuntime& runtime, const spa_buffer* buffer) {
    Crop crop{
        0,
        0,
        runtime.video.size.width,
        runtime.video.size.height,
    };
    auto* metadata = static_cast<spa_meta_region*>(spa_buffer_find_meta_data(
        buffer,
        SPA_META_VideoCrop,
        sizeof(spa_meta_region)));
    if (!metadata || !spa_meta_region_is_valid(metadata) ||
        metadata->region.position.x < 0 || metadata->region.position.y < 0) {
        return crop;
    }

    const std::uint32_t x =
        static_cast<std::uint32_t>(metadata->region.position.x);
    const std::uint32_t y =
        static_cast<std::uint32_t>(metadata->region.position.y);
    const std::uint32_t width = metadata->region.size.width;
    const std::uint32_t height = metadata->region.size.height;
    if (width > 0 && height > 0 && x <= runtime.video.size.width &&
        width <= runtime.video.size.width - x &&
        y <= runtime.video.size.height &&
        height <= runtime.video.size.height - y) {
        crop = Crop{x, y, width, height};
    }
    return crop;
}

bool hasUnsupportedTransform(
    WorkerRuntime& runtime,
    const spa_buffer* buffer) {
    auto* metadata = static_cast<spa_meta_videotransform*>(
        spa_buffer_find_meta_data(
            buffer,
            SPA_META_VideoTransform,
            sizeof(spa_meta_videotransform)));
    if (!metadata || metadata->transform == SPA_META_TRANSFORMATION_None) {
        return false;
    }
    if (!runtime.reportedUnsupportedTransform) {
        runtime.reportedUnsupportedTransform = true;
        logMessage("non-identity PipeWire video transforms are not supported");
    }
    return true;
}

bool metadataContains(
    const spa_meta* metadata,
    const void* value,
    std::size_t size) {
    if (!metadata || !metadata->data) return false;
    const auto* begin = static_cast<const std::uint8_t*>(metadata->data);
    const auto* end = begin + metadata->size;
    const auto* address = static_cast<const std::uint8_t*>(value);
    return address >= begin && address <= end &&
           size <= static_cast<std::size_t>(end - address);
}

void updateCursor(
    WorkerRuntime& runtime,
    const spa_buffer* buffer,
    const Crop& crop,
    bool transformUnsupported) {
    Session& capture = *runtime.capture;
    spa_meta* metadata = spa_buffer_find_meta(buffer, SPA_META_Cursor);
    if (transformUnsupported) {
        std::lock_guard<std::mutex> lock(capture.cacheMutex);
        capture.cursor.valid = false;
        return;
    }
    // SPA_META_Cursor is update metadata: an absent/short entry, or id == 0,
    // means this buffer carries no new cursor state. Preserve the last valid
    // compositor position instead of falling back to XWayland's stale pointer.
    if (!metadata || !metadata->data ||
        metadata->size < sizeof(spa_meta_cursor)) {
        return;
    }

    const auto* cursor = static_cast<const spa_meta_cursor*>(metadata->data);
    if (!spa_meta_cursor_is_valid(cursor)) {
        return;
    }

    const std::int64_t relativeX =
        static_cast<std::int64_t>(cursor->position.x) - crop.x;
    const std::int64_t relativeY =
        static_cast<std::int64_t>(cursor->position.y) - crop.y;
    if (relativeX < 0 || relativeY < 0 ||
        relativeX >= static_cast<std::int64_t>(crop.width) ||
        relativeY >= static_cast<std::int64_t>(crop.height)) {
        std::lock_guard<std::mutex> lock(capture.cacheMutex);
        capture.cursor.valid = false;
        return;
    }

    const double logicalX = static_cast<double>(capture.logicalBounds.x) +
        static_cast<double>(relativeX) * capture.logicalBounds.width /
            crop.width;
    const double logicalY = static_cast<double>(capture.logicalBounds.y) +
        static_cast<double>(relativeY) * capture.logicalBounds.height /
            crop.height;

    bool hasBitmapUpdate = false;
    if (cursor->bitmap_offset >= sizeof(spa_meta_cursor) &&
        cursor->bitmap_offset <= metadata->size &&
        sizeof(spa_meta_bitmap) <= metadata->size - cursor->bitmap_offset) {
        const auto* bitmap = reinterpret_cast<const spa_meta_bitmap*>(
            static_cast<const std::uint8_t*>(metadata->data) +
            cursor->bitmap_offset);
        hasBitmapUpdate = metadataContains(metadata, bitmap, sizeof(*bitmap)) &&
                          spa_meta_bitmap_is_valid(bitmap);
    }

    std::lock_guard<std::mutex> lock(capture.cacheMutex);
    capture.cursor.valid = true;
    capture.cursor.logicalX = logicalX;
    capture.cursor.logicalY = logicalY;
    if (hasBitmapUpdate) {
        capture.cursor.hotspotPixelX = cursor->hotspot.x;
        capture.cursor.hotspotPixelY = cursor->hotspot.y;
    }
}

bool copyMappedFrame(
    WorkerRuntime& runtime,
    const spa_buffer* buffer,
    const Crop& crop,
    CachedFrame* destination) {
    if (!destination || buffer->n_datas == 0 || !buffer->datas) return false;
    const spa_data& data = buffer->datas[0];
    const std::uint32_t chunkFlags = data.chunk
        ? static_cast<std::uint32_t>(data.chunk->flags)
        : 0;
    if (!data.data || !data.chunk || data.maxsize == 0 ||
        (chunkFlags & SPA_CHUNK_FLAG_CORRUPTED) != 0 ||
        (chunkFlags & SPA_CHUNK_FLAG_EMPTY) != 0 ||
        (data.type != SPA_DATA_MemPtr && data.type != SPA_DATA_MemFd)) {
        return false;
    }

    const std::int32_t signedStride = data.chunk->stride;
    if (signedStride <= 0) return false;
    const std::size_t stride = static_cast<std::size_t>(signedStride);

    std::size_t rawRowBytes = 0;
    if (!checkedMultiply(runtime.video.size.width, 4, &rawRowBytes) ||
        stride < rawRowBytes) {
        return false;
    }

    const std::size_t chunkOffset = data.chunk->offset % data.maxsize;
    const std::size_t availableByMapping = data.maxsize - chunkOffset;
    const std::size_t available = std::min<std::size_t>(
        availableByMapping,
        data.chunk->size);

    std::size_t lastSourceRow = 0;
    std::size_t sourceColumnEnd = 0;
    std::size_t requiredSource = 0;
    if (!checkedMultiply(
            static_cast<std::size_t>(crop.y + crop.height - 1),
            stride,
            &lastSourceRow) ||
        !checkedMultiply(
            static_cast<std::size_t>(crop.x + crop.width),
            4,
            &sourceColumnEnd) ||
        !checkedAdd(lastSourceRow, sourceColumnEnd, &requiredSource) ||
        requiredSource > available) {
        return false;
    }

    std::size_t outputPixels = 0;
    std::size_t outputBytes = 0;
    if (!checkedMultiply(crop.width, crop.height, &outputPixels) ||
        !checkedMultiply(outputPixels, 4, &outputBytes)) {
        return false;
    }

    destination->rgba.resize(outputBytes);
    destination->pixelWidth = crop.width;
    destination->pixelHeight = crop.height;
    destination->logicalBounds = runtime.capture->logicalBounds;

    const auto* sourceBase =
        static_cast<const std::uint8_t*>(data.data) + chunkOffset;
    const spa_video_format format = runtime.video.format;
    for (std::uint32_t y = 0; y < crop.height; ++y) {
        const auto* source = sourceBase +
            static_cast<std::size_t>(crop.y + y) * stride +
            static_cast<std::size_t>(crop.x) * 4;
        auto* output = destination->rgba.data() +
            static_cast<std::size_t>(y) * crop.width * 4;

        for (std::uint32_t x = 0; x < crop.width; ++x) {
            switch (format) {
                case SPA_VIDEO_FORMAT_BGRx:
                    output[0] = source[2];
                    output[1] = source[1];
                    output[2] = source[0];
                    output[3] = 255;
                    break;
                case SPA_VIDEO_FORMAT_BGRA:
                    output[0] = source[2];
                    output[1] = source[1];
                    output[2] = source[0];
                    output[3] = 255;
                    break;
                case SPA_VIDEO_FORMAT_RGBx:
                    output[0] = source[0];
                    output[1] = source[1];
                    output[2] = source[2];
                    output[3] = 255;
                    break;
                case SPA_VIDEO_FORMAT_RGBA:
                    output[0] = source[0];
                    output[1] = source[1];
                    output[2] = source[2];
                    output[3] = 255;
                    break;
                default:
                    return false;
            }
            source += 4;
            output += 4;
        }
    }
    return true;
}

void processBuffer(WorkerRuntime& runtime, spa_buffer* buffer) {
    if (!runtime.formatReady || !buffer) return;
    const Crop crop = getCrop(runtime, buffer);
    const bool transformUnsupported = hasUnsupportedTransform(runtime, buffer);
    updateCursor(runtime, buffer, crop, transformUnsupported);

    Session& capture = *runtime.capture;
    if (transformUnsupported) {
        capture.hasFrame.store(false, std::memory_order_release);
        return;
    }

    const bool shouldRefresh =
        capture.refreshRequested.exchange(false, std::memory_order_acq_rel) ||
        !capture.hasFrame.load(std::memory_order_acquire);
    if (!shouldRefresh) return;

    CachedFrame nextFrame;
    if (!copyMappedFrame(runtime, buffer, crop, &nextFrame)) {
        // Retry on a later PipeWire buffer. A previous valid cache remains
        // usable while a transient malformed/corrupt buffer is skipped.
        capture.refreshRequested.store(true, std::memory_order_release);
        return;
    }

    {
        std::lock_guard<std::mutex> lock(capture.cacheMutex);
        capture.frame = std::move(nextFrame);
        capture.hasFrame.store(true, std::memory_order_release);
    }
}

void onStreamProcess(void* userData) {
    auto& runtime = *static_cast<WorkerRuntime*>(userData);
    pw_buffer* latest = nullptr;
    while (pw_buffer* next = runtime.api->streamDequeueBuffer(runtime.stream)) {
        if (latest) runtime.api->streamQueueBuffer(runtime.stream, latest);
        latest = next;
    }
    if (!latest) return;

    try {
        processBuffer(runtime, latest->buffer);
    } catch (const std::bad_alloc&) {
        failWorker(runtime, "out of memory while caching a screen frame");
    } catch (...) {
        failWorker(runtime, "unexpected error while processing a screen frame");
    }
    runtime.api->streamQueueBuffer(runtime.stream, latest);
}

const pw_stream_events& streamEvents() {
    static const pw_stream_events events = [] {
        pw_stream_events value{};
        value.version = PW_VERSION_STREAM_EVENTS;
        value.state_changed = onStreamStateChanged;
        value.param_changed = onStreamParamChanged;
        value.process = onStreamProcess;
        return value;
    }();
    return events;
}

const spa_pod* buildFormatParameter(
    spa_pod_builder* builder,
    const LogicalBounds& logicalBounds) {
    const spa_rectangle defaultSize{
        std::clamp(logicalBounds.width, 1u, kMaximumFrameExtent),
        std::clamp(logicalBounds.height, 1u, kMaximumFrameExtent),
    };
    const spa_rectangle minimumSize{1, 1};
    const spa_rectangle maximumSize{
        kMaximumFrameExtent,
        kMaximumFrameExtent,
    };
    const spa_fraction defaultRate{30, 1};
    const spa_fraction minimumRate{0, 1};
    const spa_fraction maximumRate{60, 1};

    return static_cast<const spa_pod*>(spa_pod_builder_add_object(
        builder,
        SPA_TYPE_OBJECT_Format,
        SPA_PARAM_EnumFormat,
        SPA_FORMAT_mediaType,
        SPA_POD_Id(SPA_MEDIA_TYPE_video),
        SPA_FORMAT_mediaSubtype,
        SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
        SPA_FORMAT_VIDEO_format,
        SPA_POD_CHOICE_ENUM_Id(
            5,
            SPA_VIDEO_FORMAT_BGRx,
            SPA_VIDEO_FORMAT_BGRx,
            SPA_VIDEO_FORMAT_BGRA,
            SPA_VIDEO_FORMAT_RGBx,
            SPA_VIDEO_FORMAT_RGBA),
        SPA_FORMAT_VIDEO_size,
        SPA_POD_CHOICE_RANGE_Rectangle(
            &defaultSize,
            &minimumSize,
            &maximumSize),
        SPA_FORMAT_VIDEO_framerate,
        SPA_POD_CHOICE_RANGE_Fraction(
            &defaultRate,
            &minimumRate,
            &maximumRate)));
}

void workerMain(Session* capture, int portalFd) {
    WorkerRuntime runtime{
        .capture = capture,
        .api = &capture->api,
    };
    bool pipeWireOwnsFd = false;

    runtime.mainLoop = runtime.api->mainLoopNew(nullptr);
    if (!runtime.mainLoop) {
        logMessage("could not create the PipeWire main loop");
        capture->state.store(State::failed, std::memory_order_release);
        close(portalFd);
        return;
    }
    {
        std::lock_guard<std::mutex> lock(capture->runtimeMutex);
        capture->runtimeMainLoop = runtime.mainLoop;
    }

    if (!capture->stopRequested.load(std::memory_order_acquire)) {
        runtime.context = runtime.api->contextNew(
            runtime.api->mainLoopGetLoop(runtime.mainLoop),
            nullptr,
            0);
    }
    if (!runtime.context) {
        if (!capture->stopRequested.load(std::memory_order_acquire)) {
            logMessage("could not create the PipeWire context");
            capture->state.store(State::failed, std::memory_order_release);
        }
        goto cleanup;
    }

    // PipeWire takes ownership of the fd on both success and connection error.
    runtime.core =
        runtime.api->contextConnectFd(runtime.context, portalFd, nullptr, 0);
    pipeWireOwnsFd = true;
    if (!runtime.core) {
        logMessage("could not connect to the portal PipeWire remote");
        capture->state.store(State::failed, std::memory_order_release);
        goto cleanup;
    }

    {
        pw_properties* properties = runtime.api->propertiesNew(
            PW_KEY_MEDIA_TYPE,
            "Video",
            PW_KEY_MEDIA_CATEGORY,
            "Capture",
            PW_KEY_MEDIA_ROLE,
            "Screen",
            nullptr);
        if (!properties) {
            logMessage("could not allocate PipeWire stream properties");
            capture->state.store(State::failed, std::memory_order_release);
            goto cleanup;
        }
        // pw_stream_new takes ownership of properties.
        runtime.stream = runtime.api->streamNew(
            runtime.core,
            "electrobun-wayland-screen-capture",
            properties);
    }
    if (!runtime.stream) {
        logMessage("could not create the PipeWire screen stream");
        capture->state.store(State::failed, std::memory_order_release);
        goto cleanup;
    }

    runtime.api->streamAddListener(
        runtime.stream,
        &runtime.streamListener,
        &streamEvents(),
        &runtime);

    {
        std::uint8_t storage[1024];
        spa_pod_builder builder{};
        spa_pod_builder_init(&builder, storage, sizeof(storage));
        const spa_pod* parameter =
            buildFormatParameter(&builder, capture->logicalBounds);
        const int result = runtime.api->streamConnect(
            runtime.stream,
            PW_DIRECTION_INPUT,
            capture->nodeId,
            static_cast<pw_stream_flags>(
                PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS),
            &parameter,
            1);
        if (result < 0) {
            logMessage("could not connect the PipeWire screen stream");
            capture->state.store(State::failed, std::memory_order_release);
            goto cleanup;
        }
    }

    if (!capture->stopRequested.load(std::memory_order_acquire)) {
        runtime.api->mainLoopRun(runtime.mainLoop);
    }

cleanup:
    if (runtime.stream) runtime.api->streamDestroy(runtime.stream);
    if (runtime.core) runtime.api->coreDisconnect(runtime.core);
    if (runtime.context) runtime.api->contextDestroy(runtime.context);

    {
        std::lock_guard<std::mutex> lock(capture->runtimeMutex);
        capture->runtimeMainLoop = nullptr;
    }
    runtime.api->mainLoopDestroy(runtime.mainLoop);
    if (!pipeWireOwnsFd) close(portalFd);

    clearCache(*capture);
    if (capture->stopRequested.load(std::memory_order_acquire)) {
        capture->state.store(State::stopped, std::memory_order_release);
    } else {
        capture->state.store(State::failed, std::memory_order_release);
    }
}

bool validateCaptureArguments(
    double x,
    double y,
    std::uint32_t width,
    std::uint32_t height,
    std::uint8_t* output,
    std::uint64_t outputLength,
    std::int64_t* left,
    std::int64_t* top) {
    if (!output || !left || !top || width == 0 || height == 0 ||
        !std::isfinite(x) || !std::isfinite(y)) {
        return false;
    }
    const std::uint64_t pixels = static_cast<std::uint64_t>(width) * height;
    if (pixels > std::numeric_limits<std::uint64_t>::max() / 4 ||
        outputLength != pixels * 4 ||
        outputLength > std::numeric_limits<std::size_t>::max()) {
        return false;
    }

    const long double flooredX = std::floor(static_cast<long double>(x));
    const long double flooredY = std::floor(static_cast<long double>(y));
    if (flooredX < std::numeric_limits<std::int64_t>::min() ||
        flooredX > std::numeric_limits<std::int64_t>::max() ||
        flooredY < std::numeric_limits<std::int64_t>::min() ||
        flooredY > std::numeric_limits<std::int64_t>::max()) {
        return false;
    }
    *left = static_cast<std::int64_t>(flooredX);
    *top = static_cast<std::int64_t>(flooredY);
    return true;
}

}  // namespace

bool start(
    int portalFd,
    std::uint32_t nodeId,
    const LogicalBounds& logicalBounds) {
    if (portalFd < 0 || nodeId == 0 || logicalBounds.width == 0 ||
        logicalBounds.height == 0) {
        if (portalFd >= 0) close(portalFd);
        return false;
    }

    Session& capture = session();
    std::lock_guard<std::mutex> controlLock(capture.controlMutex);
    if (capture.state.load(std::memory_order_acquire) != State::stopped ||
        capture.worker.joinable()) {
        close(portalFd);
        return false;
    }

    if (!capture.api.load()) {
        close(portalFd);
        return false;
    }
    capture.api.init(nullptr, nullptr);
    capture.logicalBounds = logicalBounds;
    capture.nodeId = nodeId;
    capture.stopRequested.store(false, std::memory_order_release);
    capture.refreshRequested.store(true, std::memory_order_release);
    capture.state.store(State::starting, std::memory_order_release);
    clearCache(capture);

    try {
        capture.worker = std::thread(workerMain, &capture, portalFd);
    } catch (...) {
        capture.state.store(State::stopped, std::memory_order_release);
        capture.api.deinit();
        capture.api.unload();
        close(portalFd);
        return false;
    }
    return true;
}

void stop() {
    Session& capture = session();
    std::lock_guard<std::mutex> controlLock(capture.controlMutex);
    if (!capture.worker.joinable()) {
        clearCache(capture);
        capture.state.store(State::stopped, std::memory_order_release);
        return;
    }

    capture.state.store(State::stopping, std::memory_order_release);
    capture.stopRequested.store(true, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lock(capture.runtimeMutex);
        if (capture.runtimeMainLoop) {
            capture.api.mainLoopQuit(capture.runtimeMainLoop);
        }
    }
    capture.worker.join();
    capture.api.deinit();
    capture.api.unload();
    clearCache(capture);
    capture.state.store(State::stopped, std::memory_order_release);
}

bool hasFailed() {
    return session().state.load(std::memory_order_acquire) == State::failed;
}

bool capture(
    double x,
    double y,
    std::uint32_t width,
    std::uint32_t height,
    std::uint8_t* outRgba,
    std::uint64_t outLen) {
    std::int64_t left = 0;
    std::int64_t top = 0;
    if (!validateCaptureArguments(
            x,
            y,
            width,
            height,
            outRgba,
            outLen,
            &left,
            &top)) {
        return false;
    }

    Session& captureSession = session();
    captureSession.refreshRequested.store(true, std::memory_order_release);
    if (!captureSession.hasFrame.load(std::memory_order_acquire)) return false;

    std::lock_guard<std::mutex> lock(captureSession.cacheMutex);
    if (captureSession.frame.rgba.empty()) return false;
    const WaylandScreenCaptureFrameView frameView{
        .rgba = captureSession.frame.rgba.data(),
        .byte_length = captureSession.frame.rgba.size(),
        .pixel_width = captureSession.frame.pixelWidth,
        .pixel_height = captureSession.frame.pixelHeight,
        .row_stride =
            static_cast<std::size_t>(captureSession.frame.pixelWidth) * 4,
        .logical_bounds = {
            .x = captureSession.frame.logicalBounds.x,
            .y = captureSession.frame.logicalBounds.y,
            .width = captureSession.frame.logicalBounds.width,
            .height = captureSession.frame.logicalBounds.height,
        },
    };
    const WaylandScreenCaptureRegion region{
        .x = left,
        .y = top,
        .width = width,
        .height = height,
    };
    return copyWaylandScreenCaptureRegion(
        frameView,
        region,
        outRgba,
        static_cast<std::size_t>(outLen));
}

bool getCursorPoint(CursorPoint* point) {
    if (!point) return false;
    Session& capture = session();
    std::lock_guard<std::mutex> lock(capture.cacheMutex);
    if (!capture.cursor.valid) return false;
    point->logicalX = capture.cursor.logicalX;
    point->logicalY = capture.cursor.logicalY;
    point->hotspotPixelX = capture.cursor.hotspotPixelX;
    point->hotspotPixelY = capture.cursor.hotspotPixelY;
    return true;
}

}  // namespace electrobun::wayland_pipewire_capture

#else

namespace electrobun::wayland_pipewire_capture {

bool start(int portalFd, std::uint32_t, const LogicalBounds&) {
    if (portalFd >= 0) close(portalFd);
    return false;
}

void stop() {}

bool hasFailed() {
    return false;
}

bool capture(
    double,
    double,
    std::uint32_t,
    std::uint32_t,
    std::uint8_t*,
    std::uint64_t) {
    return false;
}

bool getCursorPoint(CursorPoint*) {
    return false;
}

}  // namespace electrobun::wayland_pipewire_capture

#endif

// partition_context.h - Cross-platform CEF partition (CefRequestContext) management.
//
// Consumers must already have included CEF headers that define
// CefRequestContext / CefRequestContextSettings / CefSchemeHandlerFactory
// (e.g. include/cef_app.h, which pulls them in transitively).
//
// Behavior (consistent across macOS, Linux, Windows):
//   - partition == ""               → shared global context (default profile).
//   - partition starts with "persist:" → cached per identifier; first call creates
//     a new CefRequestContext with a custom cache_path on disk, subsequent calls
//     for the same identifier reuse it. Caching is required because CEF's Chrome
//     runtime refuses to bind two CefRequestContexts to the same on-disk profile,
//     and prior code crashed when a second webview tried to share a partition.
//   - any other partition (e.g. "temp:foo") → fresh ephemeral in-memory context
//     per call, never cached. Closing and reopening a webview that uses
//     "temp:foo" therefore yields fresh storage.
//   - if CefRequestContext::CreateContext returns null (some Chrome runtime
//     configurations refuse custom profile paths), we fall back to the global
//     context for that partition with a warning. The webview still loads;
//     isolation is lost for that one partition.

#ifndef ELECTROBUN_PARTITION_CONTEXT_H
#define ELECTROBUN_PARTITION_CONTEXT_H

#include <string>
#include <map>
#include <mutex>
#include <cstdio>

namespace electrobun {

// Platform-provided. Returns the absolute filesystem cache_path for a
// persistent partition with the given name (e.g. "test1"), creating any
// missing parent directories. Returning an empty string causes the caller
// to fall back to an ephemeral (in-memory) context for that webview.
std::string buildAndEnsurePartitionCachePath(const std::string& partitionName);

inline std::map<std::string, CefRefPtr<CefRequestContext>>& partitionContextMap_() {
    static std::map<std::string, CefRefPtr<CefRequestContext>> map;
    return map;
}

inline std::mutex& partitionContextMutex_() {
    static std::mutex m;
    return m;
}

// Returns the CefRequestContext to use for a webview with the given partition
// identifier. Registers `schemeFactory` on every returned context so views://
// resolves correctly regardless of which context handles the request.
inline CefRefPtr<CefRequestContext> getOrCreateRequestContextForPartition(
    const char* partitionIdentifier,
    uint32_t webviewId,
    CefRefPtr<CefSchemeHandlerFactory> schemeFactory) {

    std::string identifier(partitionIdentifier ? partitionIdentifier : "");

    auto registerScheme = [&](CefRefPtr<CefRequestContext> ctx) {
        if (ctx && schemeFactory) {
            ctx->RegisterSchemeHandlerFactory("views", "", schemeFactory);
        }
    };

    // Default partition → shared global context.
    if (identifier.empty()) {
        CefRefPtr<CefRequestContext> ctx = CefRequestContext::GetGlobalContext();
        registerScheme(ctx);
        return ctx;
    }

    bool isPersistent = identifier.size() >= 8 && identifier.compare(0, 8, "persist:") == 0;

    // Reuse cached context for persist:* partitions only.
    if (isPersistent) {
        std::lock_guard<std::mutex> lock(partitionContextMutex_());
        auto& map = partitionContextMap_();
        auto it = map.find(identifier);
        if (it != map.end()) {
            fprintf(stderr, "[partition_context] webview %u reusing cached context for '%s'\n",
                    webviewId, identifier.c_str());
            return it->second;
        }
    }

    CefRequestContextSettings settings;
    if (isPersistent) {
        std::string partitionName = identifier.substr(8);
        std::string cachePathStr = buildAndEnsurePartitionCachePath(partitionName);
        if (!cachePathStr.empty()) {
            settings.persist_session_cookies = true;
            CefString(&settings.cache_path).FromString(cachePathStr);
            fprintf(stderr, "[partition_context] webview %u creating persistent context for '%s' at %s\n",
                    webviewId, identifier.c_str(), cachePathStr.c_str());
        } else {
            fprintf(stderr, "[partition_context] webview %u: failed to build cache path for '%s', "
                            "falling back to ephemeral\n",
                    webviewId, identifier.c_str());
            settings.persist_session_cookies = false;
        }
    } else {
        settings.persist_session_cookies = false;
        fprintf(stderr, "[partition_context] webview %u creating ephemeral context for '%s'\n",
                webviewId, identifier.c_str());
    }

    CefRefPtr<CefRequestContext> context = CefRequestContext::CreateContext(settings, nullptr);

    if (!context) {
        fprintf(stderr, "[partition_context] WARNING: CreateContext returned null for partition '%s' "
                        "— falling back to global context (this partition will NOT be isolated)\n",
                identifier.c_str());
        context = CefRequestContext::GetGlobalContext();
    }

    registerScheme(context);

    if (isPersistent) {
        std::lock_guard<std::mutex> lock(partitionContextMutex_());
        partitionContextMap_()[identifier] = context;
    }

    return context;
}

} // namespace electrobun

#endif // ELECTROBUN_PARTITION_CONTEXT_H

#pragma once

#include <array>
#include <cstring>
#include <stdexcept>
#include <string>
#include <sys/random.h>
#include <unistd.h>

namespace electrobun {

inline std::string createWebKitBridgeToken() {
    std::array<unsigned char, 32> bytes;
    // GLib's random/UUID helpers are not cryptographic. Fail closed if the
    // operating system cannot supply entropy for this webview's capability.
    if (getentropy(bytes.data(), bytes.size()) != 0) {
        throw std::runtime_error("Failed to generate WebKit bridge token");
    }
    constexpr char hex[] = "0123456789abcdef";
    std::string token;
    token.reserve(bytes.size() * 2);
    for (const auto byte : bytes) {
        token += hex[byte >> 4];
        token += hex[byte & 15];
    }
    return token;
}

// WebKitGTK exposes message handlers to every frame, but its message signal
// contains no frame identity. Only the top document receives this capability.
// As with any page-world bridge, same-origin scripts share the top page's trust;
// opaque sandboxed and cross-origin frames cannot access these wrappers.
inline std::string webKitBridgeBootstrap(const std::string& token) {
    return R"JS((function(token) {
    if (window !== window.top) return;
    const handlers = window.webkit.messageHandlers;
    function bridge(name) {
        const handler = handlers[name];
        if (!handler) return undefined;
        const postMessage = handler.postMessage.bind(handler);
        return { postMessage(message) {
            if (typeof message === 'string') postMessage(token + ':' + message);
        } };
    }
    window.__electrobunEventBridge = bridge('eventBridge');
    window.__electrobunInternalBridge = bridge('internalBridge');
    window.__electrobunHostBridge = bridge('hostBridge');
    window.__electrobunBunBridge = bridge('bunBridge');
}))JS" "('" + token + "');";
}

// Strip the capability before forwarding the original JSON string to the host.
// Never accept an unauthenticated fallback, even for event-only webviews.
inline const char* authenticatedWebKitBridgePayload(const char* message, const std::string& token) {
    if (!message || token.empty() || std::strncmp(message, token.c_str(), token.size()) != 0) {
        return nullptr;
    }
    if (message[token.size()] != ':') return nullptr;
    return message + token.size() + 1;
}

} // namespace electrobun

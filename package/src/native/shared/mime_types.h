// mime_types.h - Cross-platform MIME type detection
// Based on Bun runtime supported file types and web development standards
// Used across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_MIME_TYPES_H
#define ELECTROBUN_MIME_TYPES_H

#include <string>

namespace electrobun {

// Get MIME type from a URL or file path based on extension
// Returns "application/octet-stream" as default for unknown types
inline std::string getMimeTypeFromUrl(const std::string& url) {
    // Web/Code Files (Bun native support)
    if (url.find(".html") != std::string::npos || url.find(".htm") != std::string::npos) {
        return "text/html";
    } else if (url.find(".js") != std::string::npos || url.find(".mjs") != std::string::npos || url.find(".cjs") != std::string::npos) {
        return "text/javascript";
    } else if (url.find(".ts") != std::string::npos || url.find(".mts") != std::string::npos || url.find(".cts") != std::string::npos) {
        return "text/typescript";
    } else if (url.find(".jsx") != std::string::npos) {
        return "text/jsx";
    } else if (url.find(".tsx") != std::string::npos) {
        return "text/tsx";
    } else if (url.find(".css") != std::string::npos) {
        return "text/css";
    } else if (url.find(".json") != std::string::npos) {
        return "application/json";
    } else if (url.find(".xml") != std::string::npos) {
        return "application/xml";
    } else if (url.find(".md") != std::string::npos) {
        return "text/markdown";
    } else if (url.find(".txt") != std::string::npos) {
        return "text/plain";
    } else if (url.find(".toml") != std::string::npos) {
        return "application/toml";
    } else if (url.find(".yaml") != std::string::npos || url.find(".yml") != std::string::npos) {
        return "application/x-yaml";

    // Image Files
    } else if (url.find(".png") != std::string::npos) {
        return "image/png";
    } else if (url.find(".jpg") != std::string::npos || url.find(".jpeg") != std::string::npos) {
        return "image/jpeg";
    } else if (url.find(".gif") != std::string::npos) {
        return "image/gif";
    } else if (url.find(".webp") != std::string::npos) {
        return "image/webp";
    } else if (url.find(".svg") != std::string::npos) {
        return "image/svg+xml";
    } else if (url.find(".ico") != std::string::npos) {
        return "image/x-icon";
    } else if (url.find(".avif") != std::string::npos) {
        return "image/avif";

    // Font Files
    } else if (url.find(".woff") != std::string::npos) {
        return "font/woff";
    } else if (url.find(".woff2") != std::string::npos) {
        return "font/woff2";
    } else if (url.find(".ttf") != std::string::npos) {
        return "font/ttf";
    } else if (url.find(".otf") != std::string::npos) {
        return "font/otf";

    // Media Files
    } else if (url.find(".mp3") != std::string::npos) {
        return "audio/mpeg";
    } else if (url.find(".mp4") != std::string::npos) {
        return "video/mp4";
    } else if (url.find(".webm") != std::string::npos) {
        return "video/webm";
    } else if (url.find(".ogg") != std::string::npos) {
        return "audio/ogg";
    } else if (url.find(".wav") != std::string::npos) {
        return "audio/wav";

    // Document Files
    } else if (url.find(".pdf") != std::string::npos) {
        return "application/pdf";

    // WebAssembly (Bun support)
    } else if (url.find(".wasm") != std::string::npos) {
        return "application/wasm";

    // Compressed Files
    } else if (url.find(".zip") != std::string::npos) {
        return "application/zip";
    } else if (url.find(".gz") != std::string::npos) {
        return "application/gzip";
    }

    return "application/octet-stream"; // default
}

} // namespace electrobun

#endif // ELECTROBUN_MIME_TYPES_H

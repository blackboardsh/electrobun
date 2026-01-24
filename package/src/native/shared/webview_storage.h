// webview_storage.h - Cross-platform webview content storage
// Thread-safe storage for webview HTML content
// Used across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_WEBVIEW_STORAGE_H
#define ELECTROBUN_WEBVIEW_STORAGE_H

#include <string>
#include <map>
#include <mutex>
#include <cstdint>
#include <cstring>

namespace electrobun {

// Thread-safe storage for webview HTML content
// Replaces the duplicated webviewHTMLContent maps across platforms
class WebviewContentStorage {
public:
    static WebviewContentStorage& getInstance() {
        static WebviewContentStorage instance;
        return instance;
    }

    void setContent(uint32_t webviewId, const std::string& content) {
        std::lock_guard<std::mutex> lock(mutex_);
        content_[webviewId] = content;
    }

    void setContent(uint32_t webviewId, const char* content) {
        if (content) {
            setContent(webviewId, std::string(content));
        }
    }

    std::string getContent(uint32_t webviewId) const {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = content_.find(webviewId);
        if (it != content_.end()) {
            return it->second;
        }
        return "";
    }

    // Returns a strdup'd string for FFI - caller must free
    const char* getContentForFFI(uint32_t webviewId) const {
        std::string content = getContent(webviewId);
        if (content.empty()) {
            return nullptr;
        }
        return strdup(content.c_str());
    }

    bool hasContent(uint32_t webviewId) const {
        std::lock_guard<std::mutex> lock(mutex_);
        return content_.find(webviewId) != content_.end();
    }

    void removeContent(uint32_t webviewId) {
        std::lock_guard<std::mutex> lock(mutex_);
        content_.erase(webviewId);
    }

    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        content_.clear();
    }

private:
    WebviewContentStorage() = default;
    WebviewContentStorage(const WebviewContentStorage&) = delete;
    WebviewContentStorage& operator=(const WebviewContentStorage&) = delete;

    mutable std::mutex mutex_;
    std::map<uint32_t, std::string> content_;
};

// Convenience functions for backward compatibility with existing code
inline void setWebviewHTMLContentShared(uint32_t webviewId, const char* htmlContent) {
    WebviewContentStorage::getInstance().setContent(webviewId, htmlContent);
}

inline const char* getWebviewHTMLContentShared(uint32_t webviewId) {
    return WebviewContentStorage::getInstance().getContentForFFI(webviewId);
}

} // namespace electrobun

#endif // ELECTROBUN_WEBVIEW_STORAGE_H

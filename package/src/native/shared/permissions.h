// permissions.h - Cross-platform permission cache management
// Used for caching user media, geolocation, and notification permissions
// across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_PERMISSIONS_H
#define ELECTROBUN_PERMISSIONS_H

#include <string>
#include <map>
#include <chrono>
#include <mutex>
#include <utility>

namespace electrobun {

enum class PermissionType {
    USER_MEDIA,
    GEOLOCATION,
    NOTIFICATIONS,
    OTHER
};

enum class PermissionStatus {
    UNKNOWN,
    ALLOWED,
    DENIED
};

struct PermissionCacheEntry {
    PermissionStatus status;
    std::chrono::system_clock::time_point expiry;
};

// Thread-safe permission cache
class PermissionCache {
public:
    static PermissionCache& getInstance() {
        static PermissionCache instance;
        return instance;
    }

    // Extract origin from a URL (e.g., "https://example.com/path" -> "https://example.com")
    static std::string getOriginFromUrl(const std::string& url) {
        // For views:// scheme, use a constant origin since these are local files
        if (url.find("views://") == 0) {
            return "views://";
        }

        // For other schemes, extract origin from URL
        size_t protocolEnd = url.find("://");
        if (protocolEnd == std::string::npos) return url;

        size_t domainStart = protocolEnd + 3;
        size_t pathStart = url.find('/', domainStart);

        if (pathStart == std::string::npos) {
            return url;
        }

        return url.substr(0, pathStart);
    }

    PermissionStatus get(const std::string& origin, PermissionType type) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto key = std::make_pair(origin, type);
        auto it = cache_.find(key);

        if (it != cache_.end()) {
            // Check if permission hasn't expired
            auto now = std::chrono::system_clock::now();
            if (now < it->second.expiry) {
                return it->second.status;
            } else {
                // Permission expired, remove from cache
                cache_.erase(it);
            }
        }

        return PermissionStatus::UNKNOWN;
    }

    void set(const std::string& origin, PermissionType type, PermissionStatus status) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto key = std::make_pair(origin, type);

        // Cache permission for 24 hours
        auto expiry = std::chrono::system_clock::now() + std::chrono::hours(24);

        cache_[key] = {status, expiry};
    }

private:
    PermissionCache() = default;
    PermissionCache(const PermissionCache&) = delete;
    PermissionCache& operator=(const PermissionCache&) = delete;

    std::map<std::pair<std::string, PermissionType>, PermissionCacheEntry> cache_;
    std::mutex mutex_;
};

// Convenience functions that use the singleton (for easier migration from existing code)
inline std::string getOriginFromUrl(const std::string& url) {
    return PermissionCache::getOriginFromUrl(url);
}

inline PermissionStatus getPermissionFromCache(const std::string& origin, PermissionType type) {
    return PermissionCache::getInstance().get(origin, type);
}

inline void cachePermission(const std::string& origin, PermissionType type, PermissionStatus status) {
    PermissionCache::getInstance().set(origin, type, status);
}

} // namespace electrobun

#endif // ELECTROBUN_PERMISSIONS_H

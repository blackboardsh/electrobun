// thread_safe_map.h - Cross-platform thread-safe map template
// Generic thread-safe container for tracking windows, webviews, etc.
// Used across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_THREAD_SAFE_MAP_H
#define ELECTROBUN_THREAD_SAFE_MAP_H

#include <map>
#include <mutex>
#include <functional>
#include <optional>
#include <vector>

namespace electrobun {

// Thread-safe wrapper around std::map
// Provides synchronized access to key-value storage
template<typename KeyType, typename ValueType>
class ThreadSafeMap {
public:
    ThreadSafeMap() = default;

    // Insert or update a value
    void set(const KeyType& key, const ValueType& value) {
        std::lock_guard<std::mutex> lock(mutex_);
        map_[key] = value;
    }

    // Insert or update with move semantics
    void set(const KeyType& key, ValueType&& value) {
        std::lock_guard<std::mutex> lock(mutex_);
        map_[key] = std::move(value);
    }

    // Get a value (returns copy for thread safety)
    std::optional<ValueType> get(const KeyType& key) const {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = map_.find(key);
        if (it != map_.end()) {
            return it->second;
        }
        return std::nullopt;
    }

    // Get a value with default fallback
    ValueType getOrDefault(const KeyType& key, const ValueType& defaultValue) const {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = map_.find(key);
        if (it != map_.end()) {
            return it->second;
        }
        return defaultValue;
    }

    // Check if key exists
    bool contains(const KeyType& key) const {
        std::lock_guard<std::mutex> lock(mutex_);
        return map_.find(key) != map_.end();
    }

    // Remove a key
    bool remove(const KeyType& key) {
        std::lock_guard<std::mutex> lock(mutex_);
        return map_.erase(key) > 0;
    }

    // Clear all entries
    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        map_.clear();
    }

    // Get size
    size_t size() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return map_.size();
    }

    // Check if empty
    bool empty() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return map_.empty();
    }

    // Get all keys
    std::vector<KeyType> keys() const {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<KeyType> result;
        result.reserve(map_.size());
        for (const auto& pair : map_) {
            result.push_back(pair.first);
        }
        return result;
    }

    // Execute a function on each entry (read-only)
    void forEach(const std::function<void(const KeyType&, const ValueType&)>& fn) const {
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& pair : map_) {
            fn(pair.first, pair.second);
        }
    }

    // Execute a function on a specific entry if it exists
    // Returns true if the entry was found and the function was executed
    bool withEntry(const KeyType& key,
                   const std::function<void(ValueType&)>& fn) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = map_.find(key);
        if (it != map_.end()) {
            fn(it->second);
            return true;
        }
        return false;
    }

    // Execute a function on a specific entry (const version)
    bool withEntry(const KeyType& key,
                   const std::function<void(const ValueType&)>& fn) const {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = map_.find(key);
        if (it != map_.end()) {
            fn(it->second);
            return true;
        }
        return false;
    }

private:
    mutable std::mutex mutex_;
    std::map<KeyType, ValueType> map_;
};

} // namespace electrobun

#endif // ELECTROBUN_THREAD_SAFE_MAP_H

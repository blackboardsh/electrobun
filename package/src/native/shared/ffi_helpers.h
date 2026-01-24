// ffi_helpers.h - Cross-platform FFI helper utilities
// Helpers for passing strings and data across FFI boundaries
// Used across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_FFI_HELPERS_H
#define ELECTROBUN_FFI_HELPERS_H

#include <string>
#include <cstring>
#include <cstdlib>

namespace electrobun {

// Create a copy of a string for FFI callbacks
// The returned string is allocated with malloc/strdup and must be freed by the caller
// Returns nullptr if the input is empty
inline char* createFFIString(const std::string& str) {
    if (str.empty()) {
        return nullptr;
    }
    return strdup(str.c_str());
}

// Create a copy of a C string for FFI callbacks
// The returned string is allocated with malloc/strdup and must be freed by the caller
// Returns nullptr if the input is null or empty
inline char* createFFIString(const char* str) {
    if (!str || str[0] == '\0') {
        return nullptr;
    }
    return strdup(str);
}

// Free an FFI string that was created with createFFIString
inline void freeFFIString(char* str) {
    if (str) {
        free(str);
    }
}

// Free an FFI string (const version for convenience)
inline void freeFFIString(const char* str) {
    if (str) {
        free(const_cast<char*>(str));
    }
}

// RAII wrapper for FFI strings
// Automatically frees the string when it goes out of scope
class FFIString {
public:
    FFIString() : str_(nullptr) {}

    explicit FFIString(const std::string& str)
        : str_(createFFIString(str)) {}

    explicit FFIString(const char* str)
        : str_(createFFIString(str)) {}

    ~FFIString() {
        freeFFIString(str_);
    }

    // Get the raw pointer (for passing to FFI)
    const char* get() const { return str_; }

    // Release ownership (caller takes responsibility for freeing)
    char* release() {
        char* temp = str_;
        str_ = nullptr;
        return temp;
    }

    // Check if string is valid
    bool valid() const { return str_ != nullptr; }
    explicit operator bool() const { return valid(); }

    // Non-copyable
    FFIString(const FFIString&) = delete;
    FFIString& operator=(const FFIString&) = delete;

    // Movable
    FFIString(FFIString&& other) noexcept : str_(other.str_) {
        other.str_ = nullptr;
    }

    FFIString& operator=(FFIString&& other) noexcept {
        if (this != &other) {
            freeFFIString(str_);
            str_ = other.str_;
            other.str_ = nullptr;
        }
        return *this;
    }

private:
    char* str_;
};

// Helper to create event data strings for callbacks
// Format: "key1=value1&key2=value2&..."
class FFIEventBuilder {
public:
    FFIEventBuilder& add(const std::string& key, const std::string& value) {
        if (!data_.empty()) {
            data_ += "&";
        }
        data_ += key + "=" + value;
        return *this;
    }

    FFIEventBuilder& add(const std::string& key, int value) {
        return add(key, std::to_string(value));
    }

    FFIEventBuilder& add(const std::string& key, double value) {
        return add(key, std::to_string(value));
    }

    FFIEventBuilder& add(const std::string& key, bool value) {
        return add(key, value ? "true" : "false");
    }

    std::string str() const { return data_; }

    // Create FFI string (caller must free)
    char* createFFIString() const {
        return electrobun::createFFIString(data_);
    }

private:
    std::string data_;
};

} // namespace electrobun

#endif // ELECTROBUN_FFI_HELPERS_H

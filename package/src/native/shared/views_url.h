#pragma once

#include <algorithm>
#include <cstddef>
#include <string>

namespace electrobun {

enum class ViewsUrlPathError {
    none,
    malformed_percent_encoding,
    encoded_separator,
    nul_byte,
    control_character,
    invalid_utf8,
    traversal,
    drive_prefix,
};

inline int viewsUrlHexValue(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return 10 + (value - 'a');
    if (value >= 'A' && value <= 'F') return 10 + (value - 'A');
    return -1;
}

inline bool isValidViewsUrlUtf8(const std::string& value) {
    for (size_t index = 0; index < value.size();) {
        const unsigned char first = static_cast<unsigned char>(value[index]);
        if (first <= 0x7f) {
            index += 1;
            continue;
        }

        size_t continuationCount = 0;
        unsigned char secondMin = 0x80;
        unsigned char secondMax = 0xbf;
        if (first >= 0xc2 && first <= 0xdf) {
            continuationCount = 1;
        } else if (first >= 0xe0 && first <= 0xef) {
            continuationCount = 2;
            if (first == 0xe0) secondMin = 0xa0;
            if (first == 0xed) secondMax = 0x9f;
        } else if (first >= 0xf0 && first <= 0xf4) {
            continuationCount = 3;
            if (first == 0xf0) secondMin = 0x90;
            if (first == 0xf4) secondMax = 0x8f;
        } else {
            return false;
        }

        if (index + continuationCount >= value.size()) return false;
        const unsigned char second = static_cast<unsigned char>(value[index + 1]);
        if (second < secondMin || second > secondMax) return false;
        for (size_t offset = 2; offset <= continuationCount; ++offset) {
            const unsigned char continuation = static_cast<unsigned char>(value[index + offset]);
            if (continuation < 0x80 || continuation > 0xbf) return false;
        }
        index += continuationCount + 1;
    }
    return true;
}

inline bool normalizeViewsRelativePath(
    const std::string& url,
    std::string& normalizedPath,
    ViewsUrlPathError* error = nullptr
) {
    const auto fail = [&](ViewsUrlPathError failure) {
        normalizedPath.clear();
        if (error) *error = failure;
        return false;
    };

    if (error) *error = ViewsUrlPathError::none;
    std::string path = url.rfind("views://", 0) == 0 ? url.substr(8) : url;

    const size_t queryPos = path.find('?');
    const size_t hashPos = path.find('#');
    const size_t trimPos = std::min(
        queryPos == std::string::npos ? path.size() : queryPos,
        hashPos == std::string::npos ? path.size() : hashPos
    );
    path = path.substr(0, trimPos);

    while (!path.empty() && (path.front() == '/' || path.front() == '\\')) {
        path.erase(path.begin());
    }
    while (!path.empty() && (path.back() == '/' || path.back() == '\\')) {
        path.pop_back();
    }

    if (path.empty()) {
        normalizedPath = "index.html";
        return true;
    }

    std::string decoded;
    decoded.reserve(path.size());
    for (size_t index = 0; index < path.size(); ++index) {
        unsigned char byte = static_cast<unsigned char>(path[index]);
        if (byte == '%') {
            if (index + 2 >= path.size()) {
                return fail(ViewsUrlPathError::malformed_percent_encoding);
            }
            const int high = viewsUrlHexValue(path[index + 1]);
            const int low = viewsUrlHexValue(path[index + 2]);
            if (high < 0 || low < 0) {
                return fail(ViewsUrlPathError::malformed_percent_encoding);
            }
            byte = static_cast<unsigned char>((high << 4) | low);
            index += 2;
            if (byte == '/' || byte == '\\') {
                return fail(ViewsUrlPathError::encoded_separator);
            }
        }

        if (byte == 0) return fail(ViewsUrlPathError::nul_byte);
        if (byte < 0x20 || byte == 0x7f) {
            return fail(ViewsUrlPathError::control_character);
        }
        decoded.push_back(byte == '\\' ? '/' : static_cast<char>(byte));
    }

    if (!isValidViewsUrlUtf8(decoded)) {
        return fail(ViewsUrlPathError::invalid_utf8);
    }

    normalizedPath.clear();
    size_t segmentStart = 0;
    while (segmentStart <= decoded.size()) {
        const size_t separator = decoded.find('/', segmentStart);
        const size_t segmentEnd = separator == std::string::npos ? decoded.size() : separator;
        const std::string segment = decoded.substr(segmentStart, segmentEnd - segmentStart);

        if (segment == "..") return fail(ViewsUrlPathError::traversal);
        if (
            segment.size() >= 2 &&
            ((segment[0] >= 'a' && segment[0] <= 'z') ||
             (segment[0] >= 'A' && segment[0] <= 'Z')) &&
            segment[1] == ':'
        ) {
            return fail(ViewsUrlPathError::drive_prefix);
        }

        if (!segment.empty() && segment != ".") {
            if (!normalizedPath.empty()) normalizedPath.push_back('/');
            normalizedPath.append(segment);
        }

        if (separator == std::string::npos) break;
        segmentStart = separator + 1;
    }

    if (normalizedPath.empty()) normalizedPath = "index.html";
    return true;
}

inline std::string normalizeViewsRelativePath(const std::string& url) {
    std::string normalizedPath;
    normalizeViewsRelativePath(url, normalizedPath);
    return normalizedPath;
}

} // namespace electrobun

#pragma once

#include <algorithm>
#include <string>

namespace electrobun {

inline std::string normalizeViewsRelativePath(const std::string& url) {
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

    return path.empty() ? "index.html" : path;
}

} // namespace electrobun

#ifndef ELECTROBUN_WINDOWS_RESOURCE_PATHS_H
#define ELECTROBUN_WINDOWS_RESOURCE_PATHS_H

#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>

#include "windows_profile_paths.h"
#include "windows_utf.h"

namespace electrobun {

#ifdef _WIN32

inline std::filesystem::path windowsExtendedLengthPath(
    const std::filesystem::path& input
) {
    if (input.empty()) {
        return {};
    }

    std::filesystem::path normalized = input.lexically_normal();
    normalized.make_preferred();
    const std::wstring native = normalized.native();
    if (native.rfind(L"\\\\?\\", 0) == 0 ||
        native.rfind(L"\\\\.\\", 0) == 0) {
        return normalized;
    }
    if (native.rfind(L"\\\\", 0) == 0) {
        return std::filesystem::path(L"\\\\?\\UNC\\" + native.substr(2));
    }
    if (normalized.is_absolute()) {
        return std::filesystem::path(L"\\\\?\\" + native);
    }
    return normalized;
}

inline std::filesystem::path windowsResourcesDirectoryFromExecutable(
    const std::filesystem::path& executablePath
) {
    if (executablePath.empty() || !executablePath.has_parent_path()) {
        return {};
    }
    return (executablePath.parent_path() / L".." / L"Resources")
        .lexically_normal();
}

inline std::filesystem::path windowsResourcesDirectory() {
    const std::wstring executablePath = getModuleFileNameWide();
    if (executablePath.empty()) {
        return {};
    }
    return windowsResourcesDirectoryFromExecutable(
        std::filesystem::path(executablePath));
}

inline bool windowsRegularFileExists(const std::filesystem::path& path) {
    std::error_code error;
    const bool exists = std::filesystem::is_regular_file(
        windowsExtendedLengthPath(path), error);
    return exists && !error;
}

inline bool readWindowsBinaryFile(
    const std::filesystem::path& path,
    std::string& output
) {
    output.clear();
    std::ifstream file(windowsExtendedLengthPath(path), std::ios::binary);
    if (!file.is_open()) {
        return false;
    }
    output.assign(
        std::istreambuf_iterator<char>(file),
        std::istreambuf_iterator<char>());
    return !file.bad();
}

inline std::string windowsPathForLog(const std::filesystem::path& path) {
    std::string utf8;
    if (!wideToUtf8(path.native(), utf8)) {
        return "<invalid UTF-16 path>";
    }
    return utf8;
}

#endif

} // namespace electrobun

#endif // ELECTROBUN_WINDOWS_RESOURCE_PATHS_H

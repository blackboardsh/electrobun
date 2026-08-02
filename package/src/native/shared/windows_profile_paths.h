#ifndef ELECTROBUN_WINDOWS_PROFILE_PATHS_H
#define ELECTROBUN_WINDOWS_PROFILE_PATHS_H

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "app_paths.h"
#include "windows_utf.h"

#ifdef _WIN32
#include <windows.h>
#endif

namespace electrobun {

inline std::wstring buildWebView2UserDataPath(
    const std::wstring& localAppData,
    const std::wstring& identifier,
    const std::wstring& channel,
    const std::wstring& partitionIdentifier,
    uint32_t webviewId
) {
    std::wstring path = buildAppDataPath(
        localAppData, identifier, channel, L"WebView2", L'\\');

    if (partitionIdentifier.empty()) {
        return path;
    }

    constexpr std::wstring_view persistentPrefix = L"persist:";
    if (partitionIdentifier.rfind(persistentPrefix, 0) == 0) {
        path += L"\\Partitions\\";
        path += partitionIdentifier.substr(persistentPrefix.size());
    } else {
        path += L"\\Ephemeral\\";
        path += std::to_wstring(webviewId);
    }
    return path;
}

#ifdef _WIN32

inline std::wstring getEnvironmentVariableWide(const wchar_t* name) {
    if (!name || *name == L'\0') {
        return L"";
    }

    for (;;) {
        const DWORD required = GetEnvironmentVariableW(name, nullptr, 0);
        if (required == 0) {
            return L"";
        }

        std::vector<wchar_t> buffer(required);
        const DWORD written = GetEnvironmentVariableW(
            name, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (written == 0) {
            return L"";
        }
        if (written < buffer.size()) {
            return std::wstring(buffer.data(), written);
        }
    }
}

inline std::wstring getModuleFileNameWide(HMODULE module = nullptr) {
    std::vector<wchar_t> buffer(512);
    for (;;) {
        SetLastError(ERROR_SUCCESS);
        const DWORD written = GetModuleFileNameW(
            module, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (written == 0) {
            return L"";
        }
        if (written < buffer.size()) {
            return std::wstring(buffer.data(), written);
        }
        if (buffer.size() >= 32768) {
            return L"";
        }
        buffer.resize(buffer.size() * 2);
    }
}

#endif

} // namespace electrobun

#endif // ELECTROBUN_WINDOWS_PROFILE_PATHS_H

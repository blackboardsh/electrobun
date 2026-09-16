#ifndef ELECTROBUN_WINDOWS_PROFILE_PATHS_H
#define ELECTROBUN_WINDOWS_PROFILE_PATHS_H

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "app_paths.h"
#include "sha256.h"
#include "windows_utf.h"

#ifdef _WIN32
#include <windows.h>
#endif

namespace electrobun {

/**
 * Return a single, collision-resistant Windows directory component for a CEF
 * persistent partition name.
 *
 * Every name is byte-encoded so case variants, Unicode names, separators,
 * traversal components, Windows-reserved names, and future Chromium-owned root
 * entries cannot alias one another or escape root_cache_path.
 */
inline std::optional<std::wstring> buildWindowsCEFPartitionDirectoryName(
    std::string_view partitionName
) {
    constexpr std::string_view encodedPrefix = "__electrobun_partition_";
    constexpr size_t maxEncodedInputLength = 100;

    if (partitionName.empty() ||
        partitionName.size() > maxEncodedInputLength) {
        return std::nullopt;
    }

    static constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring encoded(encodedPrefix.begin(), encodedPrefix.end());
    encoded.reserve(encoded.size() + partitionName.size() * 2);
    for (const unsigned char ch : partitionName) {
        encoded.push_back(hex[ch >> 4]);
        encoded.push_back(hex[ch & 0x0f]);
    }
    return encoded;
}

/**
 * Keep established short lowercase ASCII profile directories. Hash other full
 * identities, including case, into a compact, reserved namespace. Hex escaping
 * was too long: Chromium appends a 36-character GUID plus .tmp when atomically
 * saving Local State, so even a valid final path can lose its cookie key.
 * No old profile is moved or removed by this mapping.
 */
inline std::wstring buildWindowsWebView2PartitionDirectoryName(
    std::wstring_view partitionName
) {
    bool plain = !partitionName.empty() && partitionName.size() <= 80;
    for (const wchar_t ch : partitionName) {
        if (!((ch >= L'a' && ch <= L'z') ||
              (ch >= L'0' && ch <= L'9') || ch == L'-' || ch == L'_')) {
            plain = false;
        }
    }
    const bool reserved = partitionName == L"con" || partitionName == L"prn" ||
        partitionName == L"aux" || partitionName == L"nul" ||
        (partitionName.size() == 4 &&
         (partitionName.substr(0, 3) == L"com" ||
          partitionName.substr(0, 3) == L"lpt") &&
         partitionName[3] >= L'1' && partitionName[3] <= L'9');
    if (plain && !reserved) {
        return std::wstring(partitionName);
    }
    // Canonical UTF-32BE code points make the identity independent of host
    // wchar_t width, byte order, locale, and Unicode normalization. Windows
    // receives valid UTF-16 from utf8ToWide; join surrogate pairs explicitly.
    std::string identity;
    for (size_t i = 0; i < partitionName.size(); ++i) {
        uint32_t value = static_cast<uint32_t>(partitionName[i]);
        if (value >= 0xd800 && value <= 0xdbff && i + 1 < partitionName.size()) {
            const uint32_t low = static_cast<uint32_t>(partitionName[i + 1]);
            if (low >= 0xdc00 && low <= 0xdfff) {
                value = 0x10000 + ((value - 0xd800) << 10) + (low - 0xdc00);
                ++i;
            }
        }
        for (int shift = 24; shift >= 0; shift -= 8) identity += static_cast<char>((value >> shift) & 0xff);
    }
    const std::string digest = sha256Hex(identity);
    // Plain names cannot contain '~', including a literal hash-looking name.
    return L"~h-" + std::wstring(digest.begin(), digest.end());
}

inline bool canPersistWebView2UserDataPath(std::wstring_view path) {
    // Include Chromium's longest critical preferences suffix and its atomic
    // write GUID.tmp suffix. Do not silently create an unusable/shared profile
    // if the OS account or application prefix itself leaves too little room.
    constexpr size_t suffixLength = std::wstring_view(L"\\EBWebView\\Default\\Secure Preferences").size() + 40;
    return !path.empty() && path.size() + suffixLength < 260;
}

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
        path += buildWindowsWebView2PartitionDirectoryName(
            std::wstring_view(partitionIdentifier).substr(persistentPrefix.size()));
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

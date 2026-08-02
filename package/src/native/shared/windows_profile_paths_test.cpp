#include <cassert>
#include <chrono>
#include <fstream>
#include <iostream>
#include <string>

#include "cache_migration.h"
#include "windows_profile_paths.h"

int main() {
    const std::wstring localAppData =
        L"C:\\Users\\\u5c71\u7530\\AppData\\Local";
    const std::wstring identifier = L"sh.blackboard.\u043f\u0440\u0438\u043c\u0435\u0440";
    const std::wstring channel = L"caf\u00e9";

    const std::wstring cefRoot = electrobun::buildAppDataPath(
        localAppData, identifier, channel, L"CEF", L'\\');
    assert(cefRoot ==
           L"C:\\Users\\\u5c71\u7530\\AppData\\Local\\"
           L"sh.blackboard.\u043f\u0440\u0438\u043c\u0435\u0440\\caf\u00e9\\CEF");

    const std::wstring cefPartition = electrobun::buildCEFPartitionPath(
        localAppData,
        identifier,
        channel,
        L"CEF",
        L"\u30d7\u30ed\u30d5\u30a1\u30a4\u30eb",
        L'\\');
    assert(cefPartition ==
           cefRoot + L"\\\u30d7\u30ed\u30d5\u30a1\u30a4\u30eb");

    const auto encodedPartition =
        electrobun::buildWindowsCEFPartitionDirectoryName("profile-a");
    assert(encodedPartition &&
           *encodedPartition ==
               L"__electrobun_partition_70726f66696c652d61");

    const auto defaultVariant =
        electrobun::buildWindowsCEFPartitionDirectoryName("Default");
    const auto exactDefault =
        electrobun::buildWindowsCEFPartitionDirectoryName("default");
    assert(defaultVariant && exactDefault);
    assert(*defaultVariant == L"__electrobun_partition_44656661756c74");
    assert(*exactDefault == L"__electrobun_partition_64656661756c74");
    assert(*defaultVariant != *exactDefault);

    const auto separatedPartition =
        electrobun::buildWindowsCEFPartitionDirectoryName("account/a\\b");
    assert(separatedPartition);
    assert(separatedPartition->find(L'/') == std::wstring::npos);
    assert(separatedPartition->find(L'\\') == std::wstring::npos);

    const auto reservedDevice =
        electrobun::buildWindowsCEFPartitionDirectoryName("con");
    const auto reservedPrefix =
        electrobun::buildWindowsCEFPartitionDirectoryName(
            "__electrobun_partition_636f6e");
    assert(reservedDevice && reservedPrefix);
    assert(*reservedDevice == L"__electrobun_partition_636f6e");
    assert(*reservedPrefix != *reservedDevice);

    assert(!electrobun::buildWindowsCEFPartitionDirectoryName(""));
    assert(electrobun::buildWindowsCEFPartitionDirectoryName(
        std::string(100, 'a')));
    assert(!electrobun::buildWindowsCEFPartitionDirectoryName(
        std::string(101, 'a')));

    const std::string linuxCefRoot = "/home/test/.cache/app/dev/CEF";
    const std::string linuxCefPartition = electrobun::buildCEFPartitionPath(
        "/home/test/.cache", "app", "dev", "CEF", "account-a");
    assert(linuxCefPartition == linuxCefRoot + "/account-a");
    assert(linuxCefPartition.find("/partitions/") == std::string::npos);

    assert(electrobun::CEF_CACHE_FORMAT_VERSION == 3);
    assert(electrobun::WINDOWS_CEF_CACHE_FORMAT_VERSION == 4);

    const auto migrationRoot = std::filesystem::temp_directory_path() /
        ("electrobun-cache-migration-" + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
    const auto migrationCache = migrationRoot / "app" / "dev" / "CEF";
    const auto migrationSentinel =
        migrationCache / electrobun::cacheSentinelFilename();
    std::filesystem::create_directories(migrationCache);

    assert(electrobun::writeCacheSentinel(migrationSentinel, 3));
    assert(electrobun::readCacheSentinel(migrationSentinel) == 3);
    assert(electrobun::migrateCacheFolderIfNeeded(
        migrationCache, electrobun::WINDOWS_CEF_CACHE_FORMAT_VERSION));
    assert(electrobun::readCacheSentinel(migrationSentinel) == 4);

    {
        std::ofstream stale(migrationCache / "stale-profile-data");
        stale << "v3";
    }
    assert(electrobun::writeCacheSentinel(migrationSentinel, 3));
    assert(electrobun::migrateCacheFolderIfNeeded(
        migrationCache, electrobun::WINDOWS_CEF_CACHE_FORMAT_VERSION));
    assert(!std::filesystem::exists(migrationCache / "stale-profile-data"));
    assert(electrobun::readCacheSentinel(migrationSentinel) == 4);

#ifdef _WIN32
    const auto lockedProfileData = migrationCache / "locked-profile-data";
    {
        std::ofstream lockedData(lockedProfileData);
        lockedData << "v3";
    }
    HANDLE lockedHandle = CreateFileW(
        lockedProfileData.c_str(),
        GENERIC_READ,
        0,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    assert(lockedHandle != INVALID_HANDLE_VALUE);
    assert(electrobun::writeCacheSentinel(migrationSentinel, 3));
    assert(!electrobun::migrateCacheFolderIfNeeded(
        migrationCache, electrobun::WINDOWS_CEF_CACHE_FORMAT_VERSION));
    assert(electrobun::readCacheSentinel(migrationSentinel) == 3);
    assert(std::filesystem::exists(lockedProfileData));
    CloseHandle(lockedHandle);

    assert(electrobun::migrateCacheFolderIfNeeded(
        migrationCache, electrobun::WINDOWS_CEF_CACHE_FORMAT_VERSION));
    assert(!std::filesystem::exists(lockedProfileData));
    assert(electrobun::readCacheSentinel(migrationSentinel) == 4);
#endif
    std::filesystem::remove_all(migrationRoot);

    const std::wstring webViewDefault =
        electrobun::buildWebView2UserDataPath(
            localAppData, identifier, channel, L"", 17);
    assert(webViewDefault ==
           localAppData + L"\\" + identifier + L"\\" + channel +
               L"\\WebView2");

    const std::wstring webViewPersistent =
        electrobun::buildWebView2UserDataPath(
            localAppData,
            identifier,
            channel,
            L"persist:\u0434\u0430\u043d\u043d\u044b\u0435",
            17);
    assert(webViewPersistent ==
           webViewDefault + L"\\Partitions\\\u0434\u0430\u043d\u043d\u044b\u0435");

    const std::wstring webViewEphemeral =
        electrobun::buildWebView2UserDataPath(
            localAppData, identifier, channel, L"private", 17);
    assert(webViewEphemeral == webViewDefault + L"\\Ephemeral\\17");

    assert(electrobun::buildAppDataPath(
               localAppData, L"", L"", L"CEF", L'\\') ==
           localAppData + L"\\Electrobun\\default\\CEF");

    const std::string portableUtf8Cache =
        "/tmp/"
        "\xE5\xB1\xB1\xE7\x94\xB0"
        "/"
        "\xD0\x98\xD0\xB2\xD0\xB0\xD0\xBD"
        "/caf\xC3\xA9/CEF";
    const std::u8string portableUtf8Path(
        reinterpret_cast<const char8_t*>(portableUtf8Cache.data()),
        portableUtf8Cache.size());
    const std::filesystem::path portableCachePath(portableUtf8Path);
    assert(electrobun::cachePathForLog(portableCachePath) ==
           portableUtf8Cache);
#ifndef _WIN32
    assert(electrobun::isCachePathSafeToWipe(portableCachePath));
#endif

#ifdef _WIN32
    const std::string utf8Path =
        "C:\\Users\\"
        "\xE5\xB1\xB1\xE7\x94\xB0"
        "\\"
        "\xD0\x98\xD0\xB2\xD0\xB0\xD0\xBD"
        "\\caf\xC3\xA9";
    const std::wstring widePath =
        L"C:\\Users\\\u5c71\u7530\\\u0418\u0432\u0430\u043d\\caf\u00e9";

    std::wstring decoded;
    assert(electrobun::utf8ToWide(utf8Path, decoded));
    assert(decoded == widePath);

    std::string encoded;
    assert(electrobun::wideToUtf8(decoded, encoded));
    assert(encoded == utf8Path);

    const std::filesystem::path nativeCachePath =
        std::filesystem::path(widePath) / L"app" / L"dev" / L"CEF";
    assert(electrobun::cachePathForLog(nativeCachePath) ==
           utf8Path + "\\app\\dev\\CEF");
    assert(electrobun::isCachePathSafeToWipe(nativeCachePath));

    assert(SetEnvironmentVariableW(
        L"ELECTROBUN_TEST_LOCALAPPDATA", widePath.c_str()));
    assert(electrobun::getEnvironmentVariableWide(
               L"ELECTROBUN_TEST_LOCALAPPDATA") == widePath);
    assert(SetEnvironmentVariableW(L"ELECTROBUN_TEST_LOCALAPPDATA", nullptr));

    assert(!electrobun::getModuleFileNameWide().empty());

    std::wstring invalidOutput = L"stale";
    assert(!electrobun::utf8ToWide(std::string("\xff", 1), invalidOutput));
    assert(invalidOutput.empty());
#endif

    std::cout << "windows profile path tests passed\n";
    return 0;
}

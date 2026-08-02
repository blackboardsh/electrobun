#include <cassert>
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

    const std::string linuxCefRoot = "/home/test/.cache/app/dev/CEF";
    const std::string linuxCefPartition = electrobun::buildCEFPartitionPath(
        "/home/test/.cache", "app", "dev", "CEF", "account-a");
    assert(linuxCefPartition == linuxCefRoot + "/account-a");
    assert(linuxCefPartition.find("/partitions/") == std::string::npos);

    assert(electrobun::CEF_CACHE_FORMAT_VERSION == 3);

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
    assert(electrobun::isCachePathSafeToWipe(portableCachePath));

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

#ifndef ELECTROBUN_APP_PATHS_H
#define ELECTROBUN_APP_PATHS_H

#include <string>

namespace electrobun {

/**
 * Build the app data path using identifier/channel structure.
 * This ensures consistent path structure across all platforms and matches
 * the CLI and updater conventions.
 *
 * @param basePath The base application support/data path (e.g., ~/Library/Application Support)
 * @param identifier The app identifier (e.g., "sh.blackboard.electrobun-kitchen")
 * @param channel The release channel (e.g., "dev", "canary", "stable")
 * @param suffix Optional suffix to append (e.g., "CEF", "WebView2")
 * @param pathSeparator The path separator to use ('/' for Unix, '\\' for Windows)
 * @return The full path: basePath/identifier/channel/suffix
 */
inline std::string buildAppDataPath(
    const std::string& basePath,
    const std::string& identifier,
    const std::string& channel,
    const std::string& suffix = "",
    char pathSeparator = '/'
) {
    std::string appId = !identifier.empty() ? identifier : "Electrobun";
    std::string channelPath = !channel.empty() ? channel : "default";

    std::string result = basePath;
    result += pathSeparator;
    result += appId;
    result += pathSeparator;
    result += channelPath;

    if (!suffix.empty()) {
        result += pathSeparator;
        result += suffix;
    }

    return result;
}

inline std::wstring buildAppDataPath(
    const std::wstring& basePath,
    const std::wstring& identifier,
    const std::wstring& channel,
    const std::wstring& suffix = L"",
    wchar_t pathSeparator = L'/'
) {
    std::wstring appId = !identifier.empty() ? identifier : L"Electrobun";
    std::wstring channelPath = !channel.empty() ? channel : L"default";

    std::wstring result = basePath;
    result += pathSeparator;
    result += appId;
    result += pathSeparator;
    result += channelPath;

    if (!suffix.empty()) {
        result += pathSeparator;
        result += suffix;
    }

    return result;
}

/**
 * Build a partition-specific path under the app data directory.
 *
 * @param basePath The base application support/data path
 * @param identifier The app identifier
 * @param channel The release channel
 * @param renderer The renderer type (e.g., "CEF", "WebView2", "WebKit")
 * @param partitionName The partition name
 * @param pathSeparator The path separator to use
 * @return The full path: basePath/identifier/channel/renderer/Partitions/partitionName
 */
inline std::string buildPartitionPath(
    const std::string& basePath,
    const std::string& identifier,
    const std::string& channel,
    const std::string& renderer,
    const std::string& partitionName,
    char pathSeparator = '/'
) {
    std::string base = buildAppDataPath(basePath, identifier, channel, renderer, pathSeparator);
    base += pathSeparator;
    base += "Partitions";
    base += pathSeparator;
    base += partitionName;
    return base;
}

inline std::wstring buildPartitionPath(
    const std::wstring& basePath,
    const std::wstring& identifier,
    const std::wstring& channel,
    const std::wstring& renderer,
    const std::wstring& partitionName,
    wchar_t pathSeparator = L'/'
) {
    std::wstring base = buildAppDataPath(
        basePath, identifier, channel, renderer, pathSeparator);
    base += pathSeparator;
    base += L"Partitions";
    base += pathSeparator;
    base += partitionName;
    return base;
}

/**
 * Build a CEF partition-specific path as a direct child of the renderer root.
 *
 * CEF's Chrome runtime requires persistent profile directories to live directly
 * under root_cache_path. The reserved `persist:default` partition is handled by
 * CEF's global request context, so named persistent partitions do not need a
 * nested directory to avoid its auto-created `Default` profile.
 *
 * @param basePath The base application support/data path
 * @param identifier The app identifier
 * @param channel The release channel
 * @param renderer The renderer type (typically "CEF")
 * @param partitionName The partition name
 * @param pathSeparator The path separator to use
 * @return The full path: basePath/identifier/channel/renderer/partitionName
 */
inline std::string buildCEFPartitionPath(
    const std::string& basePath,
    const std::string& identifier,
    const std::string& channel,
    const std::string& renderer,
    const std::string& partitionName,
    char pathSeparator = '/'
) {
    std::string base = buildAppDataPath(basePath, identifier, channel, renderer, pathSeparator);
    base += pathSeparator;
    base += partitionName;
    return base;
}

inline std::wstring buildCEFPartitionPath(
    const std::wstring& basePath,
    const std::wstring& identifier,
    const std::wstring& channel,
    const std::wstring& renderer,
    const std::wstring& partitionName,
    wchar_t pathSeparator = L'/'
) {
    std::wstring base = buildAppDataPath(
        basePath, identifier, channel, renderer, pathSeparator);
    base += pathSeparator;
    base += partitionName;
    return base;
}

} // namespace electrobun

#endif // ELECTROBUN_APP_PATHS_H

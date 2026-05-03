// cache_migration.h - One-shot CEF cache folder wipe on Electrobun upgrades.
//
// When Electrobun ships a release whose CEF cache folder layout/contents are
// incompatible with prior releases (e.g. a CEF major bump that surfaces
// "Profile error" dialogs, or an Electrobun-side change to partition layout),
// the simplest reliable recovery is to wipe the cache folder. End users will
// be logged out of sites they were logged into via the app, but the app
// starts cleanly with no dialogs.
//
// Bump CEF_CACHE_FORMAT_VERSION below MANUALLY when (and only when) such a
// breaking change ships. Independent of CEF_VERSION — bumping CEF does not
// always require a wipe.
//
// Behavior:
//   1. Reads <cacheFolder>/.electrobun_cef_cache_version on startup.
//   2. If the sentinel is missing OR its value != CEF_CACHE_FORMAT_VERSION,
//      deletes everything inside cacheFolder (preserving the folder itself)
//      and writes a fresh sentinel.
//   3. If the folder doesn't exist yet (fresh install), creates it and
//      writes the sentinel — so first real launch isn't mistaken for an
//      "old layout" that needs wiping.
//   4. If the folder exists but is effectively empty (no contents, or only
//      our sentinel), refreshes the sentinel without wiping anything.
//
// Safety guards (any failure → no-op, never wipe):
//   - empty / null / relative paths
//   - paths whose final component isn't a known Electrobun cache name
//   - paths shallower than 3 components below the filesystem root
//   - any std::filesystem exception
//
// Callers must invoke this AFTER computing the cache path and BEFORE
// CefInitialize is called for that path. Multi-process locking is NOT
// implemented: Electrobun's app process starts before any windows open,
// so concurrent first-launch races aren't a concern in practice.

#ifndef ELECTROBUN_CACHE_MIGRATION_H
#define ELECTROBUN_CACHE_MIGRATION_H

#include <cstdint>
#include <cstdio>
#include <exception>
#include <filesystem>
#include <fstream>
#include <string>
#include <system_error>

namespace electrobun {

// MANUAL bump only. Increment when a release requires that end users'
// existing CEF cache folders be wiped on first launch after upgrade.
// Reasons that justify a bump:
//   - CEF major-version jump that's known to surface profile-error dialogs
//   - Electrobun-side change to cache folder layout (e.g. partition path)
//   - Any other situation where stale state would degrade the user experience
//     in a way Chromium's own forward-migration can't handle.
// Bumping invalidates cookies/logins/site data for all users on first launch.
//   v2: partitions moved from <root>/<name> to <root>/partitions/<name> to
//       avoid case-insensitive collisions with Chromium's auto-created
//       <root>/Default profile folder.
constexpr uint32_t CEF_CACHE_FORMAT_VERSION = 2;

inline const char* cacheSentinelFilename() {
    return ".electrobun_cef_cache_version";
}

inline uint32_t readCacheSentinel(const std::filesystem::path& sentinelPath) {
    std::ifstream in(sentinelPath);
    if (!in) return 0;
    uint32_t v = 0;
    in >> v;
    return in ? v : 0;
}

inline void writeCacheSentinel(const std::filesystem::path& sentinelPath,
                               uint32_t version) {
    std::filesystem::path tmpPath = sentinelPath;
    tmpPath += ".tmp";
    {
        std::ofstream out(tmpPath, std::ios::trunc);
        if (!out) {
            fprintf(stderr,
                    "[cache_migration] warning: cannot open sentinel temp file: %s\n",
                    tmpPath.string().c_str());
            return;
        }
        out << version << "\n";
        if (!out) {
            fprintf(stderr,
                    "[cache_migration] warning: failed writing sentinel temp file\n");
            return;
        }
    }
    std::error_code ec;
    std::filesystem::rename(tmpPath, sentinelPath, ec);
    if (ec) {
        fprintf(stderr,
                "[cache_migration] warning: failed to commit sentinel: %s\n",
                ec.message().c_str());
        std::error_code rmEc;
        std::filesystem::remove(tmpPath, rmEc);
    }
}

// Refuses paths that look unsafe to wipe. Returns true only when the path
// is absolute, ends in a recognized Electrobun cache folder name, and is
// at least 3 components deep below the filesystem root.
inline bool isCachePathSafeToWipe(const std::filesystem::path& cachePath) {
    if (cachePath.empty()) return false;
    if (!cachePath.is_absolute()) return false;

    const std::string leaf = cachePath.filename().string();
    if (leaf != "CEF" && leaf != "cef_cache") return false;

    size_t depth = 0;
    for (const auto& part : cachePath.relative_path()) {
        (void)part;
        ++depth;
    }
    // Require at least: <user-dir-component>/<identifier>/<channel>/<leaf>
    // i.e. four below the root. Three is the floor; below that we refuse.
    if (depth < 3) return false;

    return true;
}

inline void migrateCacheFolderIfNeeded(const std::string& cacheFolderPath) {
    try {
        if (cacheFolderPath.empty()) {
            fprintf(stderr,
                    "[cache_migration] skipped: empty cache path\n");
            return;
        }

        const std::filesystem::path cachePath(cacheFolderPath);

        if (!isCachePathSafeToWipe(cachePath)) {
            fprintf(stderr,
                    "[cache_migration] skipped: path failed safety check: %s\n",
                    cacheFolderPath.c_str());
            return;
        }

        const std::filesystem::path sentinelPath =
            cachePath / cacheSentinelFilename();

        std::error_code ec;
        const bool cacheExists = std::filesystem::exists(cachePath, ec);

        if (!cacheExists) {
            // Fresh install: create the folder and stamp the current sentinel
            // so the next launch (when CEF has populated it) doesn't see a
            // populated folder + missing sentinel and mistake it for an old
            // layout that needs wiping.
            std::error_code mkEc;
            std::filesystem::create_directories(cachePath, mkEc);
            if (mkEc) {
                fprintf(stderr,
                        "[cache_migration] skipped: cannot create cache folder %s (%s)\n",
                        cacheFolderPath.c_str(), mkEc.message().c_str());
                return;
            }
            writeCacheSentinel(sentinelPath, CEF_CACHE_FORMAT_VERSION);
            return;
        }

        if (!std::filesystem::is_directory(cachePath, ec)) {
            fprintf(stderr,
                    "[cache_migration] skipped: path exists but is not a directory: %s\n",
                    cacheFolderPath.c_str());
            return;
        }

        // Determine if folder is effectively empty (only sentinel or nothing).
        bool effectivelyEmpty = true;
        {
            std::error_code itEc;
            std::filesystem::directory_iterator it(cachePath, itEc);
            if (itEc) {
                fprintf(stderr,
                        "[cache_migration] skipped: cannot enumerate cache folder %s (%s)\n",
                        cacheFolderPath.c_str(), itEc.message().c_str());
                return;
            }
            for (const auto& entry : it) {
                if (entry.path().filename() == sentinelPath.filename()) continue;
                effectivelyEmpty = false;
                break;
            }
        }

        if (effectivelyEmpty) {
            writeCacheSentinel(sentinelPath, CEF_CACHE_FORMAT_VERSION);
            return;
        }

        const uint32_t existingVersion =
            std::filesystem::exists(sentinelPath, ec)
                ? readCacheSentinel(sentinelPath)
                : 0;

        if (existingVersion == CEF_CACHE_FORMAT_VERSION) {
            return;
        }

        fprintf(stderr,
                "[cache_migration] wiping CEF cache folder (format %u -> %u): %s\n",
                existingVersion, CEF_CACHE_FORMAT_VERSION,
                cacheFolderPath.c_str());

        // Wipe contents but preserve the folder itself. Per-entry failures
        // are warned and skipped — a partial wipe still beats refusing to
        // start the app cleanly.
        std::error_code itEc;
        std::filesystem::directory_iterator it(cachePath, itEc);
        if (itEc) {
            fprintf(stderr,
                    "[cache_migration] warning: cannot enumerate cache folder for wipe %s (%s)\n",
                    cacheFolderPath.c_str(), itEc.message().c_str());
            return;
        }
        for (const auto& entry : it) {
            std::error_code rmEc;
            std::filesystem::remove_all(entry.path(), rmEc);
            if (rmEc) {
                fprintf(stderr,
                        "[cache_migration] warning: failed to remove %s (%s)\n",
                        entry.path().string().c_str(), rmEc.message().c_str());
            }
        }

        writeCacheSentinel(sentinelPath, CEF_CACHE_FORMAT_VERSION);
    } catch (const std::exception& e) {
        fprintf(stderr,
                "[cache_migration] aborting due to filesystem error: %s\n",
                e.what());
    } catch (...) {
        fprintf(stderr,
                "[cache_migration] aborting due to unknown error\n");
    }
}

}  // namespace electrobun

#endif  // ELECTROBUN_CACHE_MIGRATION_H

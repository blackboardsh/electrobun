// chromium_flags.h - Cross-platform Chromium CLI flag passthrough
// Reads user-defined Chromium flags from build.json and applies them
// to CEF's command line during initialization.
// Used across Windows, macOS, and Linux.
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_CHROMIUM_FLAGS_H
#define ELECTROBUN_CHROMIUM_FLAGS_H

#include <string>
#include <vector>
#include <set>
#include <fstream>
#include <filesystem>
#include <sstream>

// Forward-declare CEF types so this header can be included without
// pulling in the full CEF headers (the call sites already include them).
#include "include/cef_command_line.h"

namespace electrobun {

struct ChromiumFlag {
    std::string name;
    std::string value;
    bool hasValue;
};

struct ChromiumFlagConfig {
    std::vector<ChromiumFlag> flags;  // flags to add (true / "value")
    std::set<std::string> skip;       // default flags to skip (any user-specified flag overrides its default)
};

// Read an entire file into a string. Returns empty string on failure.
inline std::string readFileToString(const std::filesystem::path& path) {
    std::ifstream file(path);
    if (!file.is_open()) {
        return "";
    }
    std::stringstream buf;
    buf << file.rdbuf();
    return buf.str();
}

// Parse the "chromiumFlags" object from build.json content.
// Handles three value types:
//   "flag-name": true        -> add switch (hasValue = false)
//   "flag-name": "value"     -> add switch with value (hasValue = true)
//   "flag-name": false       -> skip a default flag set by Electrobun
inline ChromiumFlagConfig parseChromiumFlags(const std::string& json) {
    ChromiumFlagConfig config;

    // Find the "chromiumFlags" key
    std::string key = "\"chromiumFlags\"";
    size_t keyPos = json.find(key);
    if (keyPos == std::string::npos) {
        return config;
    }

    // Find the opening brace of the object
    size_t objStart = json.find('{', keyPos + key.length());
    if (objStart == std::string::npos) {
        return config;
    }

    // Find the matching closing brace (handles nested depth = 0 since
    // chromiumFlags values are only primitives, not nested objects)
    int depth = 1;
    size_t objEnd = objStart + 1;
    while (objEnd < json.size() && depth > 0) {
        if (json[objEnd] == '{') depth++;
        else if (json[objEnd] == '}') depth--;
        objEnd++;
    }

    std::string objContent = json.substr(objStart + 1, objEnd - objStart - 2);

    // Iterate over key-value pairs inside the object
    size_t pos = 0;
    while (pos < objContent.size()) {
        // Find next quoted key
        size_t nameStart = objContent.find('"', pos);
        if (nameStart == std::string::npos) break;
        nameStart++;
        size_t nameEnd = objContent.find('"', nameStart);
        if (nameEnd == std::string::npos) break;

        std::string flagName = objContent.substr(nameStart, nameEnd - nameStart);

        // Skip past the colon
        size_t colon = objContent.find(':', nameEnd + 1);
        if (colon == std::string::npos) break;

        // Skip whitespace after colon
        size_t valStart = colon + 1;
        while (valStart < objContent.size() &&
               (objContent[valStart] == ' ' || objContent[valStart] == '\t' ||
                objContent[valStart] == '\n' || objContent[valStart] == '\r')) {
            valStart++;
        }

        if (valStart >= objContent.size()) break;

        // Any user-specified flag overrides the corresponding default
        config.skip.insert(flagName);

        if (objContent[valStart] == '"') {
            // String value — add flag with value
            valStart++;
            size_t valEnd = objContent.find('"', valStart);
            if (valEnd == std::string::npos) break;
            ChromiumFlag flag;
            flag.name = flagName;
            flag.value = objContent.substr(valStart, valEnd - valStart);
            flag.hasValue = true;
            config.flags.push_back(flag);
            pos = valEnd + 1;
        } else {
            // Boolean token — "false" means skip only, "true" means add
            size_t tokenEnd = valStart;
            while (tokenEnd < objContent.size() &&
                   objContent[tokenEnd] != ',' && objContent[tokenEnd] != '}' &&
                   objContent[tokenEnd] != '\n') {
                tokenEnd++;
            }
            std::string token = objContent.substr(valStart, tokenEnd - valStart);
            // Trim whitespace from token
            while (!token.empty() && (token.back() == ' ' || token.back() == '\t' || token.back() == '\r')) {
                token.pop_back();
            }

            if (token != "false") {
                // true or any other value — add as switch-only
                ChromiumFlag flag;
                flag.name = flagName;
                flag.hasValue = false;
                config.flags.push_back(flag);
            }
            pos = tokenEnd;
        }
    }

    return config;
}

constexpr int kDefaultRemoteDebuggingPort = 9222;
constexpr int kLastAutomaticRemoteDebuggingPort = 9232;
constexpr int kMinimumRemoteDebuggingPort = 1024;
constexpr int kMaximumRemoteDebuggingPort = 65535;
constexpr const char* kRemoteDebuggingPortFlag = "remote-debugging-port";
constexpr const char* kRemoteDebuggingPortEnvironment =
    "ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT";

enum class RemoteDebuggingSource {
    disabled_by_default,
    development_default,
    configuration,
    environment,
    explicit_disable,
    invalid_configuration,
    invalid_environment,
};

struct RemoteDebuggingDecision {
    int requestedPort = 0;
    bool scanForAvailablePort = false;
    RemoteDebuggingSource source = RemoteDebuggingSource::disabled_by_default;

    bool enabled() const {
        return requestedPort != 0;
    }
};

inline bool equalsAsciiIgnoreCase(const std::string& left, const char* right) {
    size_t rightLength = 0;
    while (right[rightLength] != '\0') rightLength++;
    if (left.size() != rightLength) return false;

    for (size_t index = 0; index < left.size(); index++) {
        char leftChar = left[index];
        char rightChar = right[index];
        if (leftChar >= 'A' && leftChar <= 'Z') leftChar += 'a' - 'A';
        if (rightChar >= 'A' && rightChar <= 'Z') rightChar += 'a' - 'A';
        if (leftChar != rightChar) return false;
    }
    return true;
}

inline std::string trimAsciiWhitespace(const std::string& value) {
    size_t start = 0;
    while (start < value.size() &&
           (value[start] == ' ' || value[start] == '\t' ||
            value[start] == '\n' || value[start] == '\r')) {
        start++;
    }

    size_t end = value.size();
    while (end > start &&
           (value[end - 1] == ' ' || value[end - 1] == '\t' ||
            value[end - 1] == '\n' || value[end - 1] == '\r')) {
        end--;
    }
    return value.substr(start, end - start);
}

inline bool parseRemoteDebuggingPort(const std::string& rawValue, int* port) {
    const std::string value = trimAsciiWhitespace(rawValue);
    if (value.empty()) return false;

    int parsed = 0;
    for (char character : value) {
        if (character < '0' || character > '9') return false;
        const int digit = character - '0';
        if (parsed > (kMaximumRemoteDebuggingPort - digit) / 10) return false;
        parsed = parsed * 10 + digit;
    }

    if (parsed < kMinimumRemoteDebuggingPort ||
        parsed > kMaximumRemoteDebuggingPort) {
        return false;
    }
    *port = parsed;
    return true;
}

inline bool parseJsonStringField(const std::string& json,
                                 const std::string& field,
                                 std::string* value) {
    const std::string key = "\"" + field + "\"";
    const size_t keyPosition = json.find(key);
    if (keyPosition == std::string::npos) return false;

    const size_t colon = json.find(':', keyPosition + key.size());
    if (colon == std::string::npos) return false;

    size_t start = colon + 1;
    while (start < json.size() &&
           (json[start] == ' ' || json[start] == '\t' ||
            json[start] == '\n' || json[start] == '\r')) {
        start++;
    }
    if (start >= json.size() || json[start] != '"') return false;
    start++;

    size_t end = start;
    while (end < json.size()) {
        if (json[end] == '\\') {
            // Build environments are generated by Hutch and never need escapes.
            return false;
        }
        if (json[end] == '"') {
            *value = json.substr(start, end - start);
            return true;
        }
        end++;
    }
    return false;
}

inline RemoteDebuggingDecision resolveRemoteDebugging(
    const std::string& buildJson,
    const ChromiumFlagConfig& chromiumFlags,
    const char* environmentOverride) {
    if (environmentOverride != nullptr) {
        const std::string overrideValue = trimAsciiWhitespace(environmentOverride);
        if (overrideValue == "0" || equalsAsciiIgnoreCase(overrideValue, "off") ||
            equalsAsciiIgnoreCase(overrideValue, "false")) {
            return {0, false, RemoteDebuggingSource::explicit_disable};
        }

        int port = 0;
        if (parseRemoteDebuggingPort(overrideValue, &port)) {
            return {port, false, RemoteDebuggingSource::environment};
        }
        return {0, false, RemoteDebuggingSource::invalid_environment};
    }

    if (chromiumFlags.skip.count(kRemoteDebuggingPortFlag) > 0) {
        for (const auto& flag : chromiumFlags.flags) {
            if (flag.name != kRemoteDebuggingPortFlag) continue;
            if (!flag.hasValue) {
                return {0, false, RemoteDebuggingSource::invalid_configuration};
            }

            int port = 0;
            if (parseRemoteDebuggingPort(flag.value, &port)) {
                return {port, false, RemoteDebuggingSource::configuration};
            }
            return {0, false, RemoteDebuggingSource::invalid_configuration};
        }
        return {0, false, RemoteDebuggingSource::explicit_disable};
    }

    std::string buildEnvironment;
    if (parseJsonStringField(buildJson, "buildEnvironment", &buildEnvironment) &&
        buildEnvironment == "dev") {
        return {
            kDefaultRemoteDebuggingPort,
            true,
            RemoteDebuggingSource::development_default,
        };
    }

    return {0, false, RemoteDebuggingSource::disabled_by_default};
}

template <typename PortAvailable>
inline int selectRemoteDebuggingPort(const RemoteDebuggingDecision& decision,
                                     PortAvailable portAvailable) {
    if (!decision.enabled()) return 0;
    if (!decision.scanForAvailablePort) return decision.requestedPort;

    for (int port = decision.requestedPort;
         port <= kLastAutomaticRemoteDebuggingPort;
         port++) {
        if (portAvailable(port)) return port;
    }
    return 0;
}

inline const char* remoteDebuggingSourceName(RemoteDebuggingSource source) {
    switch (source) {
        case RemoteDebuggingSource::disabled_by_default: return "packaged-build default";
        case RemoteDebuggingSource::development_default: return "development default";
        case RemoteDebuggingSource::configuration: return "chromiumFlags";
        case RemoteDebuggingSource::environment: return kRemoteDebuggingPortEnvironment;
        case RemoteDebuggingSource::explicit_disable: return "explicit disable";
        case RemoteDebuggingSource::invalid_configuration: return "invalid chromiumFlags value";
        case RemoteDebuggingSource::invalid_environment: return "invalid environment value";
    }
    return "unknown";
}

// A default flag: either a switch-only or a switch with a value.
struct DefaultFlag {
    std::string name;
    std::string value;  // empty = switch-only
};

// Apply a list of default flags, skipping any that the user overrode.
inline void applyDefaultFlags(const std::vector<DefaultFlag>& defaults,
                              const std::set<std::string>& skip,
                              CefRefPtr<CefCommandLine> command_line) {
    for (const auto& def : defaults) {
        if (skip.count(def.name) > 0) continue;
        if (def.value.empty()) {
            command_line->AppendSwitch(def.name);
        } else {
            command_line->AppendSwitchWithValue(def.name, def.value);
        }
    }
}

// Apply user-defined flags to a CefCommandLine. Call this from
// OnBeforeCommandLineProcessing after default flags.
inline void applyChromiumFlags(const ChromiumFlagConfig& config,
                               CefRefPtr<CefCommandLine> command_line) {
    for (const auto& flag : config.flags) {
        // This flag maps to CefSettings.remote_debugging_port and is validated
        // by resolveRemoteDebugging instead of being forwarded unchecked.
        if (flag.name == kRemoteDebuggingPortFlag) continue;
        if (flag.hasValue) {
            command_line->AppendSwitchWithValue(flag.name, flag.value);
        } else {
            command_line->AppendSwitch(flag.name);
        }
    }
}

} // namespace electrobun

#endif // ELECTROBUN_CHROMIUM_FLAGS_H

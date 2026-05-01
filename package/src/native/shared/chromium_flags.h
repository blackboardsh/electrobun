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
inline std::string readFileToString(const std::string& path) {
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
        if (flag.hasValue) {
            command_line->AppendSwitchWithValue(flag.name, flag.value);
        } else {
            command_line->AppendSwitch(flag.name);
        }
    }
}

} // namespace electrobun

#endif // ELECTROBUN_CHROMIUM_FLAGS_H

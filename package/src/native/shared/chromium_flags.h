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
#include <fstream>
#include <sstream>
#include <iostream>

// Forward-declare CEF types so this header can be included without
// pulling in the full CEF headers (the call sites already include them).
#include "include/cef_command_line.h"

namespace electrobun {

struct ChromiumFlag {
    std::string name;
    std::string value;
    bool hasValue;
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
// Handles two value types:
//   "flag-name": true        -> switch only (hasValue = false)
//   "flag-name": "value"     -> switch with value (hasValue = true)
inline std::vector<ChromiumFlag> parseChromiumFlags(const std::string& json) {
    std::vector<ChromiumFlag> flags;

    // Find the "chromiumFlags" key
    std::string key = "\"chromiumFlags\"";
    size_t keyPos = json.find(key);
    if (keyPos == std::string::npos) {
        return flags;
    }

    // Find the opening brace of the object
    size_t objStart = json.find('{', keyPos + key.length());
    if (objStart == std::string::npos) {
        return flags;
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

        ChromiumFlag flag;
        flag.name = flagName;

        if (objContent[valStart] == '"') {
            // String value
            valStart++;
            size_t valEnd = objContent.find('"', valStart);
            if (valEnd == std::string::npos) break;
            flag.value = objContent.substr(valStart, valEnd - valStart);
            flag.hasValue = true;
            pos = valEnd + 1;
        } else {
            // Boolean true (or any non-string → treat as switch-only)
            flag.hasValue = false;
            // Skip past the value token (e.g. "true")
            size_t tokenEnd = valStart;
            while (tokenEnd < objContent.size() &&
                   objContent[tokenEnd] != ',' && objContent[tokenEnd] != '}' &&
                   objContent[tokenEnd] != '\n') {
                tokenEnd++;
            }
            pos = tokenEnd;
        }

        flags.push_back(flag);
    }

    return flags;
}

// Apply parsed flags to a CefCommandLine. Call this from
// OnBeforeCommandLineProcessing after Electrobun's own switches.
inline void applyChromiumFlags(const std::vector<ChromiumFlag>& flags,
                               CefRefPtr<CefCommandLine> command_line) {
    for (const auto& flag : flags) {
        if (flag.hasValue) {
            std::cout << "[CEF] Applying user chromium flag: "
                      << flag.name << "=" << flag.value << std::endl;
            command_line->AppendSwitchWithValue(flag.name, flag.value);
        } else {
            std::cout << "[CEF] Applying user chromium flag: "
                      << flag.name << std::endl;
            command_line->AppendSwitch(flag.name);
        }
    }
}

} // namespace electrobun

#endif // ELECTROBUN_CHROMIUM_FLAGS_H

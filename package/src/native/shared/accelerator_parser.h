// accelerator_parser.h - Cross-platform Electron-style accelerator string parser
// Parses strings like "CommandOrControl+Shift+T" into modifier flags and a key.
// Header-only to match the pattern of json_menu_parser.h.

#ifndef ELECTROBUN_ACCELERATOR_PARSER_H
#define ELECTROBUN_ACCELERATOR_PARSER_H

#include <string>
#include <vector>
#include <algorithm>

namespace electrobun {

struct AcceleratorParts {
    std::string key;                // The key, lowercased (e.g. "t", "f1", "space")
    bool commandOrControl = false;  // "commandorcontrol" or "cmdorctrl"
    bool command = false;           // "command" or "cmd"
    bool control = false;           // "control" or "ctrl"
    bool alt = false;               // "alt" or "option"
    bool shift = false;             // "shift"
    bool super = false;             // "super", "meta", or "win"

    // True when the accelerator was a bare key with no modifier prefix.
    bool isBareKey = false;
};

// Parse an Electron-style accelerator string into its component parts.
// Modifier names are case-insensitive. The key is always lowercased.
inline AcceleratorParts parseAccelerator(const std::string& accelerator) {
    AcceleratorParts result;
    std::vector<std::string> parts;

    // Split by '+'
    size_t start = 0, end;
    while ((end = accelerator.find('+', start)) != std::string::npos) {
        parts.push_back(accelerator.substr(start, end - start));
        start = end + 1;
    }
    parts.push_back(accelerator.substr(start));

    // Last component is the key
    result.key = parts.back();
    std::transform(result.key.begin(), result.key.end(), result.key.begin(), ::tolower);
    parts.pop_back();

    result.isBareKey = parts.empty();

    for (const auto& part : parts) {
        std::string lower = part;
        std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);

        if (lower == "commandorcontrol" || lower == "cmdorctrl") {
            result.commandOrControl = true;
        } else if (lower == "command" || lower == "cmd") {
            result.command = true;
        } else if (lower == "control" || lower == "ctrl") {
            result.control = true;
        } else if (lower == "alt" || lower == "option") {
            result.alt = true;
        } else if (lower == "shift") {
            result.shift = true;
        } else if (lower == "super" || lower == "meta" || lower == "win") {
            result.super = true;
        }
    }

    return result;
}

} // namespace electrobun

#endif // ELECTROBUN_ACCELERATOR_PARSER_H

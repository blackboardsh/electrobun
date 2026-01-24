// json_menu_parser.h - Cross-platform simple JSON menu parser
// Lightweight JSON parsing for menu configurations
// Used across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.
// For complex JSON needs, use a proper JSON library instead.

#ifndef ELECTROBUN_JSON_MENU_PARSER_H
#define ELECTROBUN_JSON_MENU_PARSER_H

#include <string>
#include <vector>

namespace electrobun {

// Represents a parsed menu item from JSON
struct MenuItemJson {
    std::string type;       // "normal", "separator", "checkbox", "submenu"
    std::string label;
    std::string action;     // Action identifier for callbacks
    std::string role;       // System role (e.g., "quit", "copy", "paste")
    std::string tooltip;
    std::string accelerator; // Keyboard shortcut
    bool enabled = true;
    bool checked = false;
    bool hidden = false;
    std::vector<MenuItemJson> submenu;
};

// Simple JSON string value extractor
// Finds "key": "value" patterns and extracts the value
inline std::string extractJsonStringValue(const std::string& json,
                                          const std::string& key,
                                          size_t startPos,
                                          size_t endPos) {
    std::string searchKey = "\"" + key + "\":";
    size_t keyPos = json.find(searchKey, startPos);

    if (keyPos == std::string::npos || keyPos >= endPos) {
        return "";
    }

    // Skip whitespace after colon
    size_t valueStart = keyPos + searchKey.length();
    while (valueStart < endPos && (json[valueStart] == ' ' || json[valueStart] == '\t')) {
        valueStart++;
    }

    if (valueStart >= endPos) return "";

    // Check if it's a string value (starts with quote)
    if (json[valueStart] == '"') {
        valueStart++;
        size_t valueEnd = json.find('"', valueStart);
        if (valueEnd != std::string::npos && valueEnd < endPos) {
            return json.substr(valueStart, valueEnd - valueStart);
        }
    }

    return "";
}

// Simple JSON boolean value extractor
inline bool extractJsonBoolValue(const std::string& json,
                                 const std::string& key,
                                 size_t startPos,
                                 size_t endPos,
                                 bool defaultValue = false) {
    std::string searchKey = "\"" + key + "\":";
    size_t keyPos = json.find(searchKey, startPos);

    if (keyPos == std::string::npos || keyPos >= endPos) {
        return defaultValue;
    }

    size_t valueStart = keyPos + searchKey.length();
    while (valueStart < endPos && (json[valueStart] == ' ' || json[valueStart] == '\t')) {
        valueStart++;
    }

    if (valueStart >= endPos) return defaultValue;

    if (json.substr(valueStart, 4) == "true") {
        return true;
    } else if (json.substr(valueStart, 5) == "false") {
        return false;
    }

    return defaultValue;
}

// Find the end of a JSON object starting at the given position
// Returns the position of the closing brace
inline size_t findObjectEnd(const std::string& json, size_t startPos) {
    if (startPos >= json.length() || json[startPos] != '{') {
        return std::string::npos;
    }

    int braceCount = 1;
    size_t pos = startPos + 1;

    while (pos < json.length() && braceCount > 0) {
        if (json[pos] == '{') braceCount++;
        else if (json[pos] == '}') braceCount--;
        pos++;
    }

    return braceCount == 0 ? pos - 1 : std::string::npos;
}

// Find the end of a JSON array starting at the given position
inline size_t findArrayEnd(const std::string& json, size_t startPos) {
    if (startPos >= json.length() || json[startPos] != '[') {
        return std::string::npos;
    }

    int bracketCount = 1;
    size_t pos = startPos + 1;

    while (pos < json.length() && bracketCount > 0) {
        if (json[pos] == '[') bracketCount++;
        else if (json[pos] == ']') bracketCount--;
        pos++;
    }

    return bracketCount == 0 ? pos - 1 : std::string::npos;
}

// Parse a single menu item from JSON object boundaries
inline MenuItemJson parseMenuItem(const std::string& json, size_t startPos, size_t endPos) {
    MenuItemJson item;

    item.label = extractJsonStringValue(json, "label", startPos, endPos);
    item.type = extractJsonStringValue(json, "type", startPos, endPos);
    item.action = extractJsonStringValue(json, "action", startPos, endPos);
    item.role = extractJsonStringValue(json, "role", startPos, endPos);
    item.tooltip = extractJsonStringValue(json, "tooltip", startPos, endPos);
    item.accelerator = extractJsonStringValue(json, "accelerator", startPos, endPos);
    item.enabled = extractJsonBoolValue(json, "enabled", startPos, endPos, true);
    item.checked = extractJsonBoolValue(json, "checked", startPos, endPos, false);
    item.hidden = extractJsonBoolValue(json, "hidden", startPos, endPos, false);

    // Look for submenu array
    std::string submenuKey = "\"submenu\":";
    size_t submenuPos = json.find(submenuKey, startPos);
    if (submenuPos != std::string::npos && submenuPos < endPos) {
        size_t arrayStart = json.find('[', submenuPos);
        if (arrayStart != std::string::npos && arrayStart < endPos) {
            size_t arrayEnd = findArrayEnd(json, arrayStart);
            if (arrayEnd != std::string::npos) {
                // Recursively parse submenu items
                size_t itemStart = json.find('{', arrayStart);
                while (itemStart != std::string::npos && itemStart < arrayEnd) {
                    size_t itemEnd = findObjectEnd(json, itemStart);
                    if (itemEnd != std::string::npos && itemEnd <= arrayEnd) {
                        item.submenu.push_back(parseMenuItem(json, itemStart, itemEnd));
                        itemStart = json.find('{', itemEnd + 1);
                    } else {
                        break;
                    }
                }
            }
        }
    }

    // Set default type based on content
    if (item.type.empty()) {
        if (item.label == "-" || item.label.empty()) {
            item.type = "separator";
        } else if (!item.submenu.empty()) {
            item.type = "submenu";
        } else {
            item.type = "normal";
        }
    }

    return item;
}

// Parse a JSON array of menu items
inline std::vector<MenuItemJson> parseMenuJson(const std::string& jsonStr) {
    std::vector<MenuItemJson> items;

    if (jsonStr.empty()) return items;

    // Find the start of the array
    size_t arrayStart = jsonStr.find('[');
    if (arrayStart == std::string::npos) {
        // Try parsing as a single object
        size_t objStart = jsonStr.find('{');
        if (objStart != std::string::npos) {
            size_t objEnd = findObjectEnd(jsonStr, objStart);
            if (objEnd != std::string::npos) {
                items.push_back(parseMenuItem(jsonStr, objStart, objEnd));
            }
        }
        return items;
    }

    size_t arrayEnd = findArrayEnd(jsonStr, arrayStart);
    if (arrayEnd == std::string::npos) {
        arrayEnd = jsonStr.length();
    }

    // Find and parse each menu item object
    size_t pos = arrayStart + 1;
    while (pos < arrayEnd) {
        size_t objStart = jsonStr.find('{', pos);
        if (objStart == std::string::npos || objStart >= arrayEnd) break;

        size_t objEnd = findObjectEnd(jsonStr, objStart);
        if (objEnd == std::string::npos || objEnd > arrayEnd) break;

        items.push_back(parseMenuItem(jsonStr, objStart, objEnd));
        pos = objEnd + 1;
    }

    return items;
}

} // namespace electrobun

#endif // ELECTROBUN_JSON_MENU_PARSER_H

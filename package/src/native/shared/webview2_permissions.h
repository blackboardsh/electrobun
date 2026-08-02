// webview2_permissions.h - Parse Windows WebView2 permission policy from build.json.
//
// This is deliberately independent of WebView2.h so the parser and its
// fail-closed behavior can be tested on every build host.

#ifndef ELECTROBUN_WEBVIEW2_PERMISSIONS_H
#define ELECTROBUN_WEBVIEW2_PERMISSIONS_H

#include <cctype>
#include <set>
#include <string>
#include <utility>

namespace electrobun {

enum class AutoGrantPermission {
    camera,
    microphone,
    geolocation,
    notifications,
};

using AutoGrantPermissionSet = std::set<AutoGrantPermission>;

namespace webview2_permission_detail {

inline void skipWhitespace(const std::string& json, size_t& position) {
    while (position < json.size() &&
           std::isspace(static_cast<unsigned char>(json[position]))) {
        ++position;
    }
}

inline bool parseJsonString(
    const std::string& json,
    size_t& position,
    std::string* output) {
    if (position >= json.size() || json[position] != '"') return false;
    ++position;

    std::string value;
    while (position < json.size()) {
        const unsigned char character =
            static_cast<unsigned char>(json[position++]);
        if (character == '"') {
            if (output) *output = std::move(value);
            return true;
        }
        if (character < 0x20) return false;
        if (character != '\\') {
            value.push_back(static_cast<char>(character));
            continue;
        }

        if (position >= json.size()) return false;
        const char escape = json[position++];
        switch (escape) {
            case '"': value.push_back('"'); break;
            case '\\': value.push_back('\\'); break;
            case '/': value.push_back('/'); break;
            case 'b': value.push_back('\b'); break;
            case 'f': value.push_back('\f'); break;
            case 'n': value.push_back('\n'); break;
            case 'r': value.push_back('\r'); break;
            case 't': value.push_back('\t'); break;
            case 'u': {
                // Permission names are ASCII. Decode ASCII \u escapes so a
                // standards-compliant JSON producer still receives exact-match
                // behavior, and use a non-matching marker for other codepoints.
                if (position + 4 > json.size()) return false;
                unsigned int codepoint = 0;
                for (int index = 0; index < 4; ++index) {
                    const char digit = json[position++];
                    codepoint <<= 4;
                    if (digit >= '0' && digit <= '9') codepoint += digit - '0';
                    else if (digit >= 'a' && digit <= 'f') codepoint += digit - 'a' + 10;
                    else if (digit >= 'A' && digit <= 'F') codepoint += digit - 'A' + 10;
                    else return false;
                }
                value.push_back(codepoint <= 0x7f
                    ? static_cast<char>(codepoint)
                    : '?');
                break;
            }
            default: return false;
        }
    }
    return false;
}

inline bool skipJsonValue(const std::string& json, size_t& position) {
    skipWhitespace(json, position);
    if (position >= json.size()) return false;

    if (json[position] == '"') {
        return parseJsonString(json, position, nullptr);
    }

    if (json[position] == '{') {
        ++position;
        skipWhitespace(json, position);
        if (position < json.size() && json[position] == '}') {
            ++position;
            return true;
        }
        while (position < json.size()) {
            if (!parseJsonString(json, position, nullptr)) return false;
            skipWhitespace(json, position);
            if (position >= json.size() || json[position++] != ':') return false;
            if (!skipJsonValue(json, position)) return false;
            skipWhitespace(json, position);
            if (position >= json.size()) return false;
            if (json[position] == '}') {
                ++position;
                return true;
            }
            if (json[position++] != ',') return false;
            skipWhitespace(json, position);
        }
        return false;
    }

    if (json[position] == '[') {
        ++position;
        skipWhitespace(json, position);
        if (position < json.size() && json[position] == ']') {
            ++position;
            return true;
        }
        while (position < json.size()) {
            if (!skipJsonValue(json, position)) return false;
            skipWhitespace(json, position);
            if (position >= json.size()) return false;
            if (json[position] == ']') {
                ++position;
                return true;
            }
            if (json[position++] != ',') return false;
            skipWhitespace(json, position);
        }
        return false;
    }

    const size_t tokenStart = position;
    while (position < json.size() && json[position] != ',' &&
           json[position] != ']' && json[position] != '}') {
        ++position;
    }
    size_t tokenEnd = position;
    while (tokenEnd > tokenStart &&
           std::isspace(static_cast<unsigned char>(json[tokenEnd - 1]))) {
        --tokenEnd;
    }
    return tokenEnd > tokenStart;
}

inline bool permissionFromName(
    const std::string& name,
    AutoGrantPermission& permission) {
    if (name == "camera") permission = AutoGrantPermission::camera;
    else if (name == "microphone") permission = AutoGrantPermission::microphone;
    else if (name == "geolocation") permission = AutoGrantPermission::geolocation;
    else if (name == "notifications") permission = AutoGrantPermission::notifications;
    else return false;
    return true;
}

inline bool parsePermissionArray(
    const std::string& json,
    size_t& position,
    AutoGrantPermissionSet& permissions) {
    skipWhitespace(json, position);
    if (position >= json.size() || json[position++] != '[') return false;
    skipWhitespace(json, position);
    if (position < json.size() && json[position] == ']') {
        ++position;
        return true;
    }

    while (position < json.size()) {
        std::string name;
        if (!parseJsonString(json, position, &name)) return false;
        AutoGrantPermission permission;
        if (permissionFromName(name, permission)) permissions.insert(permission);

        skipWhitespace(json, position);
        if (position >= json.size()) return false;
        if (json[position] == ']') {
            ++position;
            return true;
        }
        if (json[position++] != ',') return false;
        skipWhitespace(json, position);
    }
    return false;
}

} // namespace webview2_permission_detail

inline AutoGrantPermissionSet parseAutoGrantPermissions(
    const std::string& buildJson) {
    using namespace webview2_permission_detail;

    size_t position = 0;
    AutoGrantPermissionSet parsedPermissions;
    bool foundPermissions = false;
    skipWhitespace(buildJson, position);
    if (position >= buildJson.size() || buildJson[position++] != '{') return {};

    skipWhitespace(buildJson, position);
    if (position < buildJson.size() && buildJson[position] == '}') {
        ++position;
        skipWhitespace(buildJson, position);
        return position == buildJson.size() ? parsedPermissions
                                            : AutoGrantPermissionSet{};
    }

    while (position < buildJson.size()) {
        std::string key;
        if (!parseJsonString(buildJson, position, &key)) return {};
        skipWhitespace(buildJson, position);
        if (position >= buildJson.size() || buildJson[position++] != ':') return {};

        if (key == "autoGrantPermissions") {
            // Duplicate security policy fields are ambiguous; reject them.
            if (foundPermissions ||
                !parsePermissionArray(
                    buildJson, position, parsedPermissions)) {
                return {};
            }
            foundPermissions = true;
        } else if (!skipJsonValue(buildJson, position)) {
            return {};
        }

        skipWhitespace(buildJson, position);
        if (position >= buildJson.size()) return {};
        if (buildJson[position] == '}') {
            ++position;
            skipWhitespace(buildJson, position);
            return position == buildJson.size()
                ? parsedPermissions
                : AutoGrantPermissionSet{};
        }
        if (buildJson[position++] != ',') return {};
        skipWhitespace(buildJson, position);
    }

    return {};
}

inline bool hasAutoGrantPermission(
    const AutoGrantPermissionSet& permissions,
    AutoGrantPermission permission) {
    return permissions.find(permission) != permissions.end();
}

} // namespace electrobun

#endif // ELECTROBUN_WEBVIEW2_PERMISSIONS_H

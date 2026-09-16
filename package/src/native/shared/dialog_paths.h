// Structured serialization for file-dialog results crossing the C ABI.

#ifndef ELECTROBUN_DIALOG_PATHS_H
#define ELECTROBUN_DIALOG_PATHS_H

#include <string>
#include <vector>

namespace electrobun {

inline void appendDialogPathJsonString(std::string& output, const std::string& value) {
    static constexpr char hex[] = "0123456789abcdef";

    output.push_back('"');
    for (const unsigned char byte : value) {
        switch (byte) {
            case '"': output += "\\\""; break;
            case '\\': output += "\\\\"; break;
            case '\b': output += "\\b"; break;
            case '\f': output += "\\f"; break;
            case '\n': output += "\\n"; break;
            case '\r': output += "\\r"; break;
            case '\t': output += "\\t"; break;
            default:
                if (byte < 0x20) {
                    output += "\\u00";
                    output.push_back(hex[(byte >> 4) & 0x0f]);
                    output.push_back(hex[byte & 0x0f]);
                } else {
                    output.push_back(static_cast<char>(byte));
                }
                break;
        }
    }
    output.push_back('"');
}

inline std::string serializeDialogPaths(const std::vector<std::string>& paths) {
    std::string output;
    output.push_back('[');
    for (size_t index = 0; index < paths.size(); ++index) {
        if (index != 0) {
            output.push_back(',');
        }
        appendDialogPathJsonString(output, paths[index]);
    }
    output.push_back(']');
    return output;
}

} // namespace electrobun

#endif // ELECTROBUN_DIALOG_PATHS_H

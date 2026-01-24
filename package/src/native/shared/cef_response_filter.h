// cef_response_filter.h - Cross-platform CEF response filter for preload script injection
// Injects preload scripts into HTML responses before any page scripts execute
// Used across Windows, macOS, and Linux CEF implementations
//
// This is a header-only implementation to avoid build complexity.
// Requires CEF headers to be included before this file.

#ifndef ELECTROBUN_CEF_RESPONSE_FILTER_H
#define ELECTROBUN_CEF_RESPONSE_FILTER_H

#include <string>
#include <algorithm>
#include <cstring>
#include "preload_script.h"

namespace electrobun {

// CEF Response Filter that injects preload scripts into HTML responses
// Injection happens right after <head> tag to ensure scripts run before page scripts
class ElectrobunResponseFilter : public CefResponseFilter {
private:
    std::string buffer_;
    bool injected_;
    PreloadScript electrobun_script_;
    PreloadScript custom_script_;

public:
    // Constructor with PreloadScript structs (preferred)
    ElectrobunResponseFilter(const PreloadScript& electrobunScript,
                            const PreloadScript& customScript)
        : injected_(false),
          electrobun_script_(electrobunScript),
          custom_script_(customScript) {}

    // Constructor with raw strings (for compatibility)
    ElectrobunResponseFilter(const std::string& electrobunScript,
                            const std::string& customScript = "")
        : injected_(false),
          electrobun_script_(electrobunScript),
          custom_script_(customScript) {}

    // Single script constructor (for simpler use cases)
    explicit ElectrobunResponseFilter(const std::string& script)
        : injected_(false),
          electrobun_script_(script) {}

    bool InitFilter() override {
        buffer_.clear();
        injected_ = false;
        return true;
    }

    FilterStatus Filter(void* data_in,
                       size_t data_in_size,
                       size_t& data_in_read,
                       void* data_out,
                       size_t data_out_size,
                       size_t& data_out_written) override {

        // If no scripts to inject, pass through directly
        if (electrobun_script_.empty() && custom_script_.empty()) {
            size_t copy_size = std::min(data_in_size, data_out_size);
            std::memcpy(data_out, data_in, copy_size);
            data_in_read = copy_size;
            data_out_written = copy_size;
            return RESPONSE_FILTER_DONE;
        }

        // Append incoming data to buffer
        if (data_in_size > 0) {
            buffer_.append(static_cast<char*>(data_in), data_in_size);
            data_in_read = data_in_size;
        } else {
            data_in_read = 0;
        }

        // If already injected, just output buffered data
        if (injected_) {
            return OutputBufferedData(data_out, data_out_size, data_out_written);
        }

        // Try to inject scripts
        TryInjectScripts();

        // Output buffered data
        return OutputBufferedData(data_out, data_out_size, data_out_written);
    }

private:
    void TryInjectScripts() {
        if (injected_) return;

        std::string script_tag = BuildScriptTag();
        if (script_tag.empty()) return;

        // Strategy 1: Look for <head> tag (most common case)
        size_t head_pos = FindTagCaseInsensitive("<head>");
        if (head_pos != std::string::npos) {
            // Find the end of <head> or <head ...>
            size_t insert_pos = buffer_.find('>', head_pos);
            if (insert_pos != std::string::npos) {
                buffer_.insert(insert_pos + 1, script_tag);
                injected_ = true;
                return;
            }
        }

        // Strategy 2: Look for <head with attributes (e.g., <head class="...">)
        head_pos = FindTagCaseInsensitive("<head ");
        if (head_pos != std::string::npos) {
            size_t insert_pos = buffer_.find('>', head_pos);
            if (insert_pos != std::string::npos) {
                buffer_.insert(insert_pos + 1, script_tag);
                injected_ = true;
                return;
            }
        }

        // If buffer is large enough, try fallback strategies
        if (buffer_.size() > 1024) {
            // Strategy 3: Look for <html> and create a <head> section
            size_t html_pos = FindTagCaseInsensitive("<html");
            if (html_pos != std::string::npos) {
                size_t insert_pos = buffer_.find('>', html_pos);
                if (insert_pos != std::string::npos) {
                    std::string head_with_script = "<head>" + script_tag + "</head>";
                    buffer_.insert(insert_pos + 1, head_with_script);
                    injected_ = true;
                    return;
                }
            }

            // Strategy 4: Last resort - inject at the very beginning
            buffer_.insert(0, script_tag);
            injected_ = true;
        }
    }

    std::string BuildScriptTag() const {
        if (electrobun_script_.empty() && custom_script_.empty()) {
            return "";
        }

        std::string result = "<script>\n";

        if (!electrobun_script_.empty()) {
            result += electrobun_script_.code;
            result += "\n";
        }

        if (!custom_script_.empty()) {
            result += custom_script_.code;
            result += "\n";
        }

        result += "</script>\n";
        return result;
    }

    // Case-insensitive tag search
    size_t FindTagCaseInsensitive(const std::string& tag) const {
        std::string lower_buffer = buffer_;
        std::string lower_tag = tag;

        std::transform(lower_buffer.begin(), lower_buffer.end(), lower_buffer.begin(),
                      [](unsigned char c) { return std::tolower(c); });
        std::transform(lower_tag.begin(), lower_tag.end(), lower_tag.begin(),
                      [](unsigned char c) { return std::tolower(c); });

        return lower_buffer.find(lower_tag);
    }

    FilterStatus OutputBufferedData(void* data_out, size_t data_out_size, size_t& data_out_written) {
        size_t copy_size = std::min(buffer_.size(), data_out_size);
        if (copy_size > 0) {
            std::memcpy(data_out, buffer_.c_str(), copy_size);
            buffer_.erase(0, copy_size);
        }
        data_out_written = copy_size;

        return buffer_.empty() ? RESPONSE_FILTER_DONE : RESPONSE_FILTER_NEED_MORE_DATA;
    }

    IMPLEMENT_REFCOUNTING(ElectrobunResponseFilter);
};

} // namespace electrobun

#endif // ELECTROBUN_CEF_RESPONSE_FILTER_H

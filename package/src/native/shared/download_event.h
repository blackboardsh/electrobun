// download_event.h - Cross-platform download event structures
// Common data structures for download events
// Used across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_DOWNLOAD_EVENT_H
#define ELECTROBUN_DOWNLOAD_EVENT_H

#include <string>
#include <cstdint>
#include <sstream>

namespace electrobun {

// Download event types
enum class DownloadEventType {
    STARTED,
    PROGRESS,
    COMPLETED,
    CANCELLED,
    FAILED
};

// Convert event type to string
inline const char* downloadEventTypeToString(DownloadEventType type) {
    switch (type) {
        case DownloadEventType::STARTED:   return "download-started";
        case DownloadEventType::PROGRESS:  return "download-progress";
        case DownloadEventType::COMPLETED: return "download-completed";
        case DownloadEventType::CANCELLED: return "download-cancelled";
        case DownloadEventType::FAILED:    return "download-failed";
        default: return "download-unknown";
    }
}

// Download event data structure
struct DownloadEvent {
    uint32_t downloadId = 0;
    std::string url;
    std::string filename;
    std::string mimeType;
    std::string destinationPath;
    int64_t totalBytes = -1;      // -1 if unknown
    int64_t receivedBytes = 0;
    int percentComplete = 0;
    bool canResume = false;
    std::string errorMessage;

    // Serialize to JSON string for FFI callbacks
    std::string toJson() const {
        std::ostringstream ss;
        ss << "{";
        ss << "\"downloadId\":" << downloadId;

        if (!url.empty()) {
            ss << ",\"url\":\"" << escapeJson(url) << "\"";
        }
        if (!filename.empty()) {
            ss << ",\"filename\":\"" << escapeJson(filename) << "\"";
        }
        if (!mimeType.empty()) {
            ss << ",\"mimeType\":\"" << escapeJson(mimeType) << "\"";
        }
        if (!destinationPath.empty()) {
            ss << ",\"destinationPath\":\"" << escapeJson(destinationPath) << "\"";
        }

        ss << ",\"totalBytes\":" << totalBytes;
        ss << ",\"receivedBytes\":" << receivedBytes;
        ss << ",\"percentComplete\":" << percentComplete;
        ss << ",\"canResume\":" << (canResume ? "true" : "false");

        if (!errorMessage.empty()) {
            ss << ",\"errorMessage\":\"" << escapeJson(errorMessage) << "\"";
        }

        ss << "}";
        return ss.str();
    }

    // Serialize to simple key=value format (legacy format)
    std::string toKeyValue() const {
        std::ostringstream ss;
        ss << "downloadId=" << downloadId;

        if (!url.empty()) {
            ss << "&url=" << url;
        }
        if (!filename.empty()) {
            ss << "&filename=" << filename;
        }
        if (!mimeType.empty()) {
            ss << "&mimeType=" << mimeType;
        }
        if (!destinationPath.empty()) {
            ss << "&destinationPath=" << destinationPath;
        }

        ss << "&totalBytes=" << totalBytes;
        ss << "&receivedBytes=" << receivedBytes;
        ss << "&percentComplete=" << percentComplete;

        return ss.str();
    }

private:
    // Simple JSON string escaping
    static std::string escapeJson(const std::string& str) {
        std::string result;
        result.reserve(str.length() * 2);

        for (char c : str) {
            switch (c) {
                case '"':  result += "\\\""; break;
                case '\\': result += "\\\\"; break;
                case '\b': result += "\\b";  break;
                case '\f': result += "\\f";  break;
                case '\n': result += "\\n";  break;
                case '\r': result += "\\r";  break;
                case '\t': result += "\\t";  break;
                default:   result += c;      break;
            }
        }

        return result;
    }
};

// Builder pattern for download events
class DownloadEventBuilder {
public:
    DownloadEventBuilder& setDownloadId(uint32_t id) {
        event_.downloadId = id;
        return *this;
    }

    DownloadEventBuilder& setUrl(const std::string& url) {
        event_.url = url;
        return *this;
    }

    DownloadEventBuilder& setFilename(const std::string& filename) {
        event_.filename = filename;
        return *this;
    }

    DownloadEventBuilder& setMimeType(const std::string& mimeType) {
        event_.mimeType = mimeType;
        return *this;
    }

    DownloadEventBuilder& setDestinationPath(const std::string& path) {
        event_.destinationPath = path;
        return *this;
    }

    DownloadEventBuilder& setTotalBytes(int64_t bytes) {
        event_.totalBytes = bytes;
        return *this;
    }

    DownloadEventBuilder& setReceivedBytes(int64_t bytes) {
        event_.receivedBytes = bytes;
        return *this;
    }

    DownloadEventBuilder& setPercentComplete(int percent) {
        event_.percentComplete = percent;
        return *this;
    }

    DownloadEventBuilder& setCanResume(bool canResume) {
        event_.canResume = canResume;
        return *this;
    }

    DownloadEventBuilder& setErrorMessage(const std::string& msg) {
        event_.errorMessage = msg;
        return *this;
    }

    DownloadEvent build() const {
        return event_;
    }

    std::string toJson() const {
        return event_.toJson();
    }

private:
    DownloadEvent event_;
};

} // namespace electrobun

#endif // ELECTROBUN_DOWNLOAD_EVENT_H

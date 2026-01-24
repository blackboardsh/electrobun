// preload_script.h - Cross-platform preload script management
// Used for storing and managing preload scripts across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_PRELOAD_SCRIPT_H
#define ELECTROBUN_PRELOAD_SCRIPT_H

#include <string>
#include <map>
#include <mutex>

namespace electrobun {

// Represents a preload script to be injected into webviews
struct PreloadScript {
    std::string code;
    bool mainFrameOnly = true;

    PreloadScript() = default;

    PreloadScript(const std::string& scriptCode, bool mainOnly = true)
        : code(scriptCode), mainFrameOnly(mainOnly) {}

    bool empty() const { return code.empty(); }
};

// Thread-safe storage for preload scripts by browser/webview ID
class PreloadScriptStorage {
public:
    static PreloadScriptStorage& getInstance() {
        static PreloadScriptStorage instance;
        return instance;
    }

    void set(int browserId, const std::string& script) {
        std::lock_guard<std::mutex> lock(mutex_);
        scripts_[browserId] = script;
    }

    std::string get(int browserId) const {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = scripts_.find(browserId);
        if (it != scripts_.end()) {
            return it->second;
        }
        return "";
    }

    void remove(int browserId) {
        std::lock_guard<std::mutex> lock(mutex_);
        scripts_.erase(browserId);
    }

    void clear() {
        std::lock_guard<std::mutex> lock(mutex_);
        scripts_.clear();
    }

private:
    PreloadScriptStorage() = default;
    PreloadScriptStorage(const PreloadScriptStorage&) = delete;
    PreloadScriptStorage& operator=(const PreloadScriptStorage&) = delete;

    mutable std::mutex mutex_;
    std::map<int, std::string> scripts_;
};

} // namespace electrobun

#endif // ELECTROBUN_PRELOAD_SCRIPT_H

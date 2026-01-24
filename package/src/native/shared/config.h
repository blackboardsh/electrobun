// config.h - Cross-platform global configuration
// Used for CEF cache path isolation and app identification
// across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_CONFIG_H
#define ELECTROBUN_CONFIG_H

#include <string>
#include <mutex>

namespace electrobun {

// Thread-safe configuration singleton
class Config {
public:
    static Config& getInstance() {
        static Config instance;
        return instance;
    }

    void setChannel(const std::string& channel) {
        std::lock_guard<std::mutex> lock(mutex_);
        channel_ = channel;
    }

    std::string getChannel() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return channel_;
    }

    void setIdentifier(const std::string& identifier) {
        std::lock_guard<std::mutex> lock(mutex_);
        identifier_ = identifier;
    }

    std::string getIdentifier() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return identifier_;
    }

    void setName(const std::string& name) {
        std::lock_guard<std::mutex> lock(mutex_);
        name_ = name;
    }

    std::string getName() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return name_;
    }

private:
    Config() = default;
    Config(const Config&) = delete;
    Config& operator=(const Config&) = delete;

    mutable std::mutex mutex_;
    std::string channel_;
    std::string identifier_;
    std::string name_;
};

} // namespace electrobun

#endif // ELECTROBUN_CONFIG_H

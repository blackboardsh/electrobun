#pragma once

#include <cstdint>
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <utility>

namespace electrobun {

// All methods and posted actions run on the browser UI thread. The shared
// state lets queued actions safely outlive a detached/destroyed view.
class DeferredNavigation {
public:
    using Action = std::function<void()>;
    using Post = std::function<bool(Action)>;
    using Navigate = std::function<void(const std::string&)>;

    DeferredNavigation() = default;
    DeferredNavigation(const DeferredNavigation&) = delete;
    DeferredNavigation& operator=(const DeferredNavigation&) = delete;

    bool request(std::string url, const Post& post, Navigate navigate) {
        if (state_->cancelled) return false;
        const uint64_t generation = ++state_->generation;
        return post([state = state_, generation, url = std::move(url),
                     navigate = std::move(navigate)] {
            if (!state->cancelled && state->generation == generation) {
                navigate(url);
            }
        });
    }

    void cancel() { state_->cancelled = true; }
    ~DeferredNavigation() { cancel(); }

private:
    struct State {
        uint64_t generation = 0;
        std::atomic<bool> cancelled{false};
    };
    std::shared_ptr<State> state_ = std::make_shared<State>();
};

} // namespace electrobun

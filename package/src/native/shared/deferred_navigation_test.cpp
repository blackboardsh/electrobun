#include "deferred_navigation.h"

#include <cassert>
#include <deque>
#include <vector>

int main() {
    using electrobun::DeferredNavigation;
    std::deque<DeferredNavigation::Action> tasks;
    std::vector<std::string> loaded;
    const auto post = [&](DeferredNavigation::Action action) {
        tasks.push_back(std::move(action));
        return true;
    };
    const auto navigate = [&](const std::string& url) { loaded.push_back(url); };
    const auto drain = [&] {
        while (!tasks.empty()) {
            auto action = std::move(tasks.front());
            tasks.pop_front();
            action();
        }
    };

    {
        DeferredNavigation navigation;
        // OnAfterCreated queues the constructor URL. Before CEF next drains
        // its queue, GLib dispatches the application's immediate loadURL.
        assert(navigation.request("views://initial", post, navigate));
        assert(navigation.request("views://replacement", post, navigate));
        assert(loaded.empty()); // Neither path executes inline.
        drain();
        assert((loaded == std::vector<std::string>{"views://replacement"}));

        // Requests are owned, including data URLs originating in temporary
        // SDK strings. A later request still executes after prior work drained.
        std::string html = "data:text/html;charset=utf-8,<h1>✓</h1>";
        assert(navigation.request(html, post, navigate));
        html.assign("overwritten SDK buffer");
        drain();
        assert(loaded.back() == "data:text/html;charset=utf-8,<h1>✓</h1>");

        // Superseded callbacks cannot run even if dispatched out of order.
        assert(navigation.request("views://stale", post, navigate));
        assert(navigation.request("views://latest", post, navigate));
        auto latest = std::move(tasks.back());
        tasks.pop_back();
        latest();
        const auto count = loaded.size();
        drain();
        assert(loaded.size() == count && loaded.back() == "views://latest");

        // A native close may happen while tasks are still pending.
        assert(navigation.request("views://closed", post, navigate));
        navigation.cancel();
        drain();
        assert(loaded.size() == count);
        assert(!navigation.request("views://after-close", post, navigate));
    }

    const auto count = loaded.size();
    {
        DeferredNavigation navigation;
        assert(navigation.request("views://destroyed", post, navigate));
    }
    drain();
    assert(loaded.size() == count); // Queued state outlives destruction safely.
}

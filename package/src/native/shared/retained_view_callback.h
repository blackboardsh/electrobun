#pragma once

#include <memory>
#include <utility>

namespace electrobun {

// Queued UI work must own its target until dispatch and ignore targets removed
// while it waited. Holding the owner also prevents an address from being reused
// for a different view before the current-registration check.
template <typename View, typename IsCurrent, typename Operation, typename OnRemoved>
auto retainedViewCallback(std::shared_ptr<View> owner, IsCurrent isCurrent,
                          Operation operation, OnRemoved onRemoved) {
    return [owner = std::move(owner), isCurrent = std::move(isCurrent),
            operation = std::move(operation), onRemoved = std::move(onRemoved)]() {
        if (!owner || !isCurrent(owner.get())) return onRemoved();
        return operation(owner.get());
    };
}

} // namespace electrobun

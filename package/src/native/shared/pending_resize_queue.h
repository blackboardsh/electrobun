#pragma once

#include <mutex>
#include <unordered_set>
#include <vector>

// Thread-safe queue that stores a set of dirty view pointers.
// Enqueue is idempotent per drain cycle.
class PendingResizeQueue {
public:
	void enqueue(void* view) {
		if (!view) return;
		std::lock_guard<std::mutex> lock(mutex_);
		if (set_.insert(view).second) {
			queue_.push_back(view);
		}
	}

	std::vector<void*> drain() {
		std::lock_guard<std::mutex> lock(mutex_);
		std::vector<void*> out;
		out.swap(queue_);
		set_.clear();
		return out;
	}

	bool empty() const {
		std::lock_guard<std::mutex> lock(mutex_);
		return queue_.empty();
	}

private:
	mutable std::mutex mutex_;
	std::unordered_set<void*> set_;
	std::vector<void*> queue_;
};

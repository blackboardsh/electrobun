// shutdown_guard.h - Cross-platform shutdown state management
// Prevents race conditions during application cleanup
// Used across Windows, macOS, and Linux
//
// This is a header-only implementation to avoid build complexity.

#ifndef ELECTROBUN_SHUTDOWN_GUARD_H
#define ELECTROBUN_SHUTDOWN_GUARD_H

#include <atomic>
#include <mutex>
#include <thread>
#include <chrono>

namespace electrobun {

// Singleton for managing global shutdown state
// Allows code to check if shutdown is in progress and avoid race conditions
class ShutdownManager {
public:
    static ShutdownManager& getInstance() {
        static ShutdownManager instance;
        return instance;
    }

    // Signal that shutdown has begun
    void initiateShutdown() {
        shuttingDown_.store(true);
    }

    // Check if shutdown is in progress
    bool isShuttingDown() const {
        return shuttingDown_.load();
    }

    // Reset shutdown state (use with caution, mainly for testing)
    void reset() {
        shuttingDown_.store(false);
        activeOperations_.store(0);
    }

    // Increment active operations counter
    void beginOperation() {
        activeOperations_.fetch_add(1);
    }

    // Decrement active operations counter
    void endOperation() {
        activeOperations_.fetch_sub(1);
    }

    // Get count of active operations
    int getActiveOperations() const {
        return activeOperations_.load();
    }

    // Wait for all operations to complete (with timeout)
    // Returns true if all operations completed, false if timeout
    bool waitForOperationsToComplete(int maxWaitMs = 5000) {
        int waited = 0;
        const int sleepMs = 10;
        while (activeOperations_.load() > 0 && waited < maxWaitMs) {
            std::this_thread::sleep_for(std::chrono::milliseconds(sleepMs));
            waited += sleepMs;
        }
        return activeOperations_.load() == 0;
    }

private:
    ShutdownManager() : shuttingDown_(false), activeOperations_(0) {}
    ShutdownManager(const ShutdownManager&) = delete;
    ShutdownManager& operator=(const ShutdownManager&) = delete;

    std::atomic<bool> shuttingDown_;
    std::atomic<int> activeOperations_;
};

// RAII guard for operations that shouldn't run during shutdown
// Automatically checks shutdown state and tracks operation lifetime
class OperationGuard {
public:
    OperationGuard() : valid_(!ShutdownManager::getInstance().isShuttingDown()) {
        if (valid_) {
            ShutdownManager::getInstance().beginOperation();
        }
    }

    ~OperationGuard() {
        if (valid_) {
            ShutdownManager::getInstance().endOperation();
        }
    }

    // Check if the operation is valid (not during shutdown)
    bool isValid() const { return valid_; }

    // Implicit conversion to bool for easy use in if statements
    explicit operator bool() const { return valid_; }

    // Non-copyable, non-movable
    OperationGuard(const OperationGuard&) = delete;
    OperationGuard& operator=(const OperationGuard&) = delete;
    OperationGuard(OperationGuard&&) = delete;
    OperationGuard& operator=(OperationGuard&&) = delete;

private:
    bool valid_;
};

// Lightweight guard that only checks shutdown state without tracking
// Use when you don't need operation tracking, just shutdown checking
class ShutdownCheckGuard {
public:
    ShutdownCheckGuard() : valid_(!ShutdownManager::getInstance().isShuttingDown()) {}

    bool isValid() const { return valid_; }
    explicit operator bool() const { return valid_; }

private:
    bool valid_;
};

// Convenience functions
inline bool isShuttingDown() {
    return ShutdownManager::getInstance().isShuttingDown();
}

inline void initiateShutdown() {
    ShutdownManager::getInstance().initiateShutdown();
}

} // namespace electrobun

#endif // ELECTROBUN_SHUTDOWN_GUARD_H

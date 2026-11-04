//! A recursive lock that serves outermost acquisitions in ticket order.
//! A rendering thread cannot repeatedly reacquire ahead of queued app work.
//! Acquisition is non-cancellable: every reserved ticket must be served.
const std = @import("std");
const Atomic = std.atomic.Value;

pub const ReentrantLock = struct {
    next: Atomic(u64) = .init(0),
    serving: Atomic(u64) = .init(0),
    owner: Atomic(u64) = .init(0),
    depth: u32 = 0,

    fn threadId() u64 {
        return @as(u64, std.Thread.getCurrentId()) + 1;
    }

    pub fn isOwnedByCurrentThread(self: *const ReentrantLock) bool {
        return self.owner.load(.acquire) == threadId();
    }

    /// True only for the owner's final unmatched acquisition. Hosts can run
    /// before-release callbacks at this depth without making reentry look like
    /// a new outermost acquisition.
    pub fn isOutermost(self: *const ReentrantLock) bool {
        std.debug.assert(self.isOwnedByCurrentThread());
        std.debug.assert(self.depth > 0);
        return self.depth == 1;
    }

    /// Returns true for an outermost acquisition, false for recursive entry.
    pub fn lock(self: *ReentrantLock) bool {
        const me = threadId();
        if (self.owner.load(.acquire) == me) {
            self.depth += 1;
            return false;
        }
        // Atomic addition wraps. This remains unambiguous across wraparound
        // provided fewer than 2^64 acquisitions are outstanding at once.
        const ticket = self.next.fetchAdd(1, .monotonic);
        var spins: u8 = 0;
        while (self.serving.load(.acquire) != ticket) {
            if (spins < 64) {
                spins += 1;
                std.atomic.spinLoopHint();
            } else {
                std.Thread.yield() catch {};
            }
        }
        self.owner.store(me, .monotonic);
        self.depth = 1;
        return true;
    }

    pub fn unlock(self: *ReentrantLock) void {
        std.debug.assert(self.isOwnedByCurrentThread());
        std.debug.assert(self.depth > 0);
        self.depth -= 1;
        if (self.depth != 0) return;
        self.owner.store(0, .monotonic);
        // Publish all protected state before handing ownership to the next
        // reserved ticket. The next holder acquires from this release.
        _ = self.serving.fetchAdd(1, .release);
    }
};

fn yieldThread() void {
    std.Thread.yield() catch {};
}

// Test ordering uses actual ticket registration. This watchdog only bounds a
// broken implementation; its sleep never decides which thread should acquire.
const TestWatchdog = struct {
    done: Atomic(bool) = .init(false),
    thread: ?std.Thread = null,

    fn start(self: *TestWatchdog) !void {
        self.thread = try std.Thread.spawn(.{}, run, .{self});
    }
    fn stop(self: *TestWatchdog) void {
        self.done.store(true, .release);
        self.thread.?.join();
    }
    fn run(self: *TestWatchdog) void {
        const start_time = std.Io.Clock.awake.now(std.testing.io);
        while (!self.done.load(.acquire)) {
            if (start_time.durationTo(std.Io.Clock.awake.now(std.testing.io)).toMilliseconds() > 30_000)
                @panic("recursive lock regression exceeded its 30-second watchdog");
            std.Io.sleep(std.testing.io, .fromMilliseconds(10), .awake) catch {};
        }
    }
};

test "fair recursive lock serves queued work before owner reacquisition" {
    var watchdog: TestWatchdog = .{};
    try watchdog.start();
    defer watchdog.stop();
    const Harness = struct {
        mutex: ReentrantLock = .{},
        value: u32 = 0,
        fn waiter(self: *@This()) void {
            _ = self.mutex.lock();
            defer self.mutex.unlock();
            std.debug.assert(self.value == 0);
            self.value = 1;
        }
    };
    var h: Harness = .{};
    _ = h.mutex.lock();
    const waiter = std.Thread.spawn(.{}, Harness.waiter, .{&h}) catch |err| {
        h.mutex.unlock();
        return err;
    };
    // Wait for actual queue registration, not a delay or an assumption that
    // thread creation means it has reached the lock.
    while (h.mutex.next.load(.acquire) != 2) yieldThread();
    const nested = h.mutex.lock();
    h.mutex.unlock();
    const still_owned = h.mutex.isOutermost();
    h.mutex.unlock();
    _ = h.mutex.lock();
    const value = h.value;
    h.mutex.unlock();
    waiter.join();
    try std.testing.expect(!nested);
    try std.testing.expect(still_owned);
    try std.testing.expectEqual(@as(u32, 1), value);
}

test "fair recursive lock preserves FIFO order across ticket wraparound" {
    var watchdog: TestWatchdog = .{};
    try watchdog.start();
    defer watchdog.stop();
    const Harness = struct {
        mutex: ReentrantLock = .{
            .next = .init(std.math.maxInt(u64) - 1),
            .serving = .init(std.math.maxInt(u64) - 1),
        },
        order: [3]u8 = undefined,
        count: usize = 0,
        fn record(self: *@This(), value: u8) void {
            _ = self.mutex.lock();
            defer self.mutex.unlock();
            self.order[self.count] = value;
            self.count += 1;
        }
    };
    var h: Harness = .{};
    _ = h.mutex.lock();
    const first = std.Thread.spawn(.{}, Harness.record, .{ &h, 1 }) catch |err| {
        h.mutex.unlock();
        return err;
    };
    while (h.mutex.next.load(.acquire) != 0) yieldThread();
    const second = std.Thread.spawn(.{}, Harness.record, .{ &h, 2 }) catch |err| {
        h.mutex.unlock();
        first.join();
        return err;
    };
    while (h.mutex.next.load(.acquire) != 1) yieldThread();
    h.mutex.unlock();
    h.record(3);
    first.join();
    second.join();
    try std.testing.expectEqual(@as(usize, 3), h.count);
    try std.testing.expectEqualSlices(u8, &.{ 1, 2, 3 }, &h.order);
}

test "fair recursive lock publishes state and excludes concurrent recursive writers" {
    var watchdog: TestWatchdog = .{};
    try watchdog.start();
    defer watchdog.stop();
    const Harness = struct {
        mutex: ReentrantLock = .{},
        value: usize = 0,
        inverse: usize = ~@as(usize, 0),
        consistent: bool = true,
        fn worker(self: *@This()) void {
            for (0..2_000) |_| {
                _ = self.mutex.lock();
                self.consistent = self.consistent and self.inverse == ~self.value;
                self.value += 1;
                _ = self.mutex.lock();
                self.value += 1;
                self.inverse = ~self.value;
                self.mutex.unlock();
                self.mutex.unlock();
            }
        }
    };
    var h: Harness = .{};
    var workers: [8]std.Thread = undefined;
    var spawned: usize = 0;
    defer for (workers[0..spawned]) |worker| worker.join();
    for (&workers) |*worker| {
        worker.* = try std.Thread.spawn(.{}, Harness.worker, .{&h});
        spawned += 1;
    }
    for (workers) |worker| worker.join();
    spawned = 0;
    try std.testing.expect(h.consistent);
    try std.testing.expectEqual(@as(usize, 32_000), h.value);
    try std.testing.expectEqual(~h.value, h.inverse);
}

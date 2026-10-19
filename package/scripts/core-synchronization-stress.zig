const std = @import("std");
const sync = @import("core_synchronization");

const thread_count = 4;
const increments_per_thread = 2_000_000;
const queue_rounds = 1_000;

const Counter = struct {
    mutex: sync.Mutex = .init,
    value: usize = 0,

    fn increment(io: std.Io, self: *Counter) void {
        for (0..increments_per_thread) |_| {
            self.mutex.lockUncancelable(io);
            self.value += 1;
            for (0..3) |_| std.atomic.spinLoopHint();
            self.mutex.unlock(io);
        }
    }
};

fn contention(io: std.Io) !void {
    var counter: Counter = .{};
    var threads: [thread_count]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Counter.increment, .{ io, &counter });
    for (threads) |thread| thread.join();
    if (counter.value != thread_count * increments_per_thread) return error.IncorrectCounter;
}

const Broadcast = struct {
    mutex: sync.Mutex = .init,
    gate: sync.Condition = .init,
    progress: sync.Condition = .init,
    waiting: usize = 0,
    complete: usize = 0,
    released: bool = false,

    fn wait(io: std.Io, self: *Broadcast) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.waiting += 1;
        self.progress.signal(io);
        while (!self.released) self.gate.waitUncancelable(io, &self.mutex);
        self.complete += 1;
        self.progress.signal(io);
    }
};

fn broadcast(io: std.Io) !void {
    var state: Broadcast = .{};
    var threads: [thread_count]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Broadcast.wait, .{ io, &state });
    state.mutex.lockUncancelable(io);
    // Acquiring the same mutex after all workers announce themselves forces
    // their wait to release it before this broadcast can run.
    while (state.waiting != thread_count) state.progress.waitUncancelable(io, &state.mutex);
    state.released = true;
    state.gate.broadcast(io);
    while (state.complete != thread_count) state.progress.waitUncancelable(io, &state.mutex);
    state.mutex.unlock(io);
    for (threads) |thread| thread.join();
}

const Queue = struct {
    mutex: sync.Mutex = .init,
    work: sync.Condition = .init,
    progress: sync.Condition = .init,
    waiting: bool = false,
    pending: usize = 0,
    complete: usize = 0,
    stop: bool = false,

    fn consume(io: std.Io, self: *Queue) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        while (true) {
            while (self.pending == 0 and !self.stop) {
                self.waiting = true;
                self.progress.signal(io);
                self.work.waitUncancelable(io, &self.mutex);
            }
            self.waiting = false;
            if (self.stop) return;
            self.complete = self.pending;
            self.pending = 0;
            self.progress.signal(io);
        }
    }
};

fn idleQueue(io: std.Io) !void {
    var state: Queue = .{};
    const thread = try std.Thread.spawn(.{}, Queue.consume, .{ io, &state });
    state.mutex.lockUncancelable(io);
    for (1..queue_rounds + 1) |round| {
        while (!state.waiting) state.progress.waitUncancelable(io, &state.mutex);
        state.pending = round;
        state.waiting = false;
        state.work.signal(io);
        while (state.complete != round) state.progress.waitUncancelable(io, &state.mutex);
    }
    while (!state.waiting) state.progress.waitUncancelable(io, &state.mutex);
    state.stop = true;
    state.work.signal(io);
    state.mutex.unlock(io);
    thread.join();
    if (state.complete != queue_rounds or state.pending != 0) return error.IncorrectQueue;
}

pub fn main(init: std.process.Init) !void {
    std.debug.print("BEGIN contention\n", .{});
    try contention(init.io);
    std.debug.print("PASS contention\nBEGIN broadcast\n", .{});
    try broadcast(init.io);
    std.debug.print("PASS broadcast\nBEGIN idle-queue\n", .{});
    try idleQueue(init.io);
    std.debug.print("PASS idle-queue\n", .{});
    std.debug.print("PASS: contention=8000000 broadcast=4 idle-queue=1000\n", .{});
}

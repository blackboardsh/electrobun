const std = @import("std");

pub const Snapshot = struct {
    fullscreen: bool,
    frame: [4]f64,
    work_area: [4]f64,

    fn restored(self: Snapshot, before: Snapshot) bool {
        if (self.fullscreen) return false;
        for (self.frame, before.frame, self.work_area, before.work_area) |value, expected, work, original_work| {
            if (!std.math.isFinite(value) or !std.math.isFinite(expected) or @abs(value - expected) > 1 or
                !std.math.isFinite(work) or work != original_work) return false;
        }
        return true;
    }
};

// A cleared style bit alone does not mean AppKit finished restoring the Space.
pub const Observation = struct {
    original: Snapshot,
    timeout_ns: u64,
    first: ?Snapshot = null,
    last: ?Snapshot = null,

    pub fn observe(self: *Observation, snapshot: Snapshot, elapsed_ns: u64) enum { waiting, restored, timed_out } {
        if (self.first == null) self.first = snapshot;
        self.last = snapshot;
        if (elapsed_ns <= self.timeout_ns and snapshot.restored(self.original)) return .restored;
        return if (elapsed_ns >= self.timeout_ns) .timed_out else .waiting;
    }
};

const original: Snapshot = .{ .fullscreen = false, .frame = .{ 140, 100, 640, 448 }, .work_area = .{ 0, 24, 1920, 1056 } };

test "cleared style and restored frame still wait for original work area" {
    var observed: Observation = .{ .original = original, .timeout_ns = 5000 * std.time.ns_per_ms };
    var snapshot = original;
    snapshot.work_area[1] = 0;
    try std.testing.expectEqual(.waiting, observed.observe(snapshot, 100 * std.time.ns_per_ms));
    try std.testing.expectEqual(.restored, observed.observe(original, 200 * std.time.ns_per_ms));
}

test "requires false state complete frame within one pixel and exact work area" {
    var snapshot = original;
    snapshot.fullscreen = true;
    try std.testing.expect(!snapshot.restored(original));
    for (0..4) |index| {
        snapshot = original;
        snapshot.frame[index] += 1;
        try std.testing.expect(snapshot.restored(original));
        snapshot.frame[index] += 0.01;
        try std.testing.expect(!snapshot.restored(original));
        snapshot = original;
        snapshot.work_area[index] += 0.01;
        try std.testing.expect(!snapshot.restored(original));
    }
}

test "missing or late restoration fails at the deadline" {
    var observed: Observation = .{ .original = original, .timeout_ns = 5000 * std.time.ns_per_ms };
    var snapshot = original;
    snapshot.work_area[1] = 0;
    try std.testing.expectEqual(.timed_out, observed.observe(snapshot, observed.timeout_ns));
    try std.testing.expectEqual(.timed_out, observed.observe(original, observed.timeout_ns + 1));
}

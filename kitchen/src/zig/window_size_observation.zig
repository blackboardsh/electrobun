const std = @import("std");

pub const Size = struct { width: f64, height: f64 };
pub const Result = enum { waiting, reached, timed_out };

// The caller submits one resize, then observes it. In particular, seeing an
// intermediate frame must not cause the resize command to be resubmitted.
pub const Observation = struct {
    target: Size,
    tolerance: f64,
    timeout_ns: u64,
    first: ?Size = null,
    last: ?Size = null,

    pub fn observe(self: *Observation, size: Size, elapsed_ns: u64) Result {
        if (self.first == null) self.first = size;
        self.last = size;
        // Check the time after reading the frame: a slow read must not turn a
        // result arriving after the deadline into a passing assertion.
        if (elapsed_ns <= self.timeout_ns and
            @abs(size.width - self.target.width) <= self.tolerance and
            @abs(size.height - self.target.height) <= self.tolerance)
        {
            return .reached;
        }
        return if (elapsed_ns >= self.timeout_ns) .timed_out else .waiting;
    }
};

test "resize may retain its initial frame beyond the old 150ms sleep" {
    var observed: Observation = .{ .target = .{ .width = 600, .height = 500 }, .tolerance = 24, .timeout_ns = 3000 * std.time.ns_per_ms };
    try std.testing.expectEqual(.waiting, observed.observe(.{ .width = 420, .height = 308 }, 150 * std.time.ns_per_ms));
    try std.testing.expectEqual(.waiting, observed.observe(.{ .width = 510, .height = 410 }, 175 * std.time.ns_per_ms));
    try std.testing.expectEqual(.reached, observed.observe(.{ .width = 600, .height = 500 }, 200 * std.time.ns_per_ms));
    try std.testing.expectEqual(@as(f64, 420), observed.first.?.width);
    try std.testing.expectEqual(@as(f64, 500), observed.last.?.height);
}

test "unchanged or partially matching size still fails at deadline" {
    var observed: Observation = .{ .target = .{ .width = 600, .height = 500 }, .tolerance = 24, .timeout_ns = 3000 * std.time.ns_per_ms };
    try std.testing.expectEqual(.waiting, observed.observe(.{ .width = 420, .height = 308 }, 0));
    try std.testing.expectEqual(.waiting, observed.observe(.{ .width = 600, .height = 308 }, 2999 * std.time.ns_per_ms));
    try std.testing.expectEqual(.timed_out, observed.observe(.{ .width = 600, .height = 308 }, 3000 * std.time.ns_per_ms));
}

test "matching read returning after deadline is not accepted" {
    var observed: Observation = .{ .target = .{ .width = 600, .height = 500 }, .tolerance = 24, .timeout_ns = 3000 * std.time.ns_per_ms };
    try std.testing.expectEqual(.timed_out, observed.observe(.{ .width = 600, .height = 500 }, observed.timeout_ns + 1));
}

test "shrink keeps tolerance and setFrame keeps exact matching" {
    var shrink: Observation = .{ .target = .{ .width = 320, .height = 240 }, .tolerance = 24, .timeout_ns = 3000 * std.time.ns_per_ms };
    try std.testing.expectEqual(.waiting, shrink.observe(.{ .width = 600, .height = 500 }, 0));
    try std.testing.expectEqual(.waiting, shrink.observe(.{ .width = 345, .height = 240 }, 100 * std.time.ns_per_ms));
    try std.testing.expectEqual(.reached, shrink.observe(.{ .width = 344, .height = 264 }, 200 * std.time.ns_per_ms));
    var frame: Observation = .{ .target = .{ .width = 640, .height = 480 }, .tolerance = 0, .timeout_ns = 3000 * std.time.ns_per_ms };
    try std.testing.expectEqual(.waiting, frame.observe(.{ .width = 639, .height = 480 }, 0));
    try std.testing.expectEqual(.reached, frame.observe(.{ .width = 640, .height = 480 }, 250 * std.time.ns_per_ms));
}

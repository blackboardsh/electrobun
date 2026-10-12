const std = @import("std");

// The caller serializes record/clear/contains. Late callbacks from a closed
// view or an older document must not replace another navigation's evidence.
pub const WebviewObservations = struct {
    const Event = struct { webview_id: u32, name: []const u8, detail: []const u8 };
    events: std.ArrayList(Event) = .empty,

    pub fn clear(self: *WebviewObservations, allocator: std.mem.Allocator) void {
        for (self.events.items) |event| {
            allocator.free(event.name);
            allocator.free(event.detail);
        }
        self.events.clearRetainingCapacity();
    }

    pub fn deinit(self: *WebviewObservations, allocator: std.mem.Allocator) void {
        self.clear(allocator);
        self.events.deinit(allocator);
    }

    pub fn record(self: *WebviewObservations, allocator: std.mem.Allocator, webview_id: u32, name: []const u8, detail: []const u8) !void {
        for (self.events.items) |event| {
            if (event.webview_id == webview_id and std.mem.eql(u8, event.name, name) and std.mem.eql(u8, event.detail, detail)) return;
        }
        const owned_name = try allocator.dupe(u8, name);
        errdefer allocator.free(owned_name);
        const owned_detail = try allocator.dupe(u8, detail);
        errdefer allocator.free(owned_detail);
        try self.events.append(allocator, .{ .webview_id = webview_id, .name = owned_name, .detail = owned_detail });
    }

    pub fn contains(self: *const WebviewObservations, webview_id: u32, name: []const u8, detail: ?[]const u8) bool {
        for (self.events.items) |event| {
            if (event.webview_id == webview_id and std.mem.eql(u8, event.name, name) and
                (detail == null or std.mem.indexOf(u8, event.detail, detail.?) != null)) return true;
        }
        return false;
    }
};

test "an old view's late callback cannot complete the next test" {
    const allocator = std.testing.allocator;
    var observations: WebviewObservations = .{};
    defer observations.deinit(allocator);
    try observations.record(allocator, 15, "will-navigate", "about:blank");
    observations.clear(allocator);
    try observations.record(allocator, 15, "dom-ready", "about:blank");
    try std.testing.expect(!observations.contains(16, "dom-ready", null));
    try observations.record(allocator, 16, "dom-ready", "views://test-harness/index.html");
    try std.testing.expect(observations.contains(16, "dom-ready", null));
}

test "later events and other views cannot erase the navigation URL" {
    const allocator = std.testing.allocator;
    var observations: WebviewObservations = .{};
    defer observations.deinit(allocator);
    try observations.record(allocator, 18, "did-commit-navigation", "views://test-runner/index.html");
    try observations.record(allocator, 18, "dom-ready", "views://test-harness/index.html");
    try observations.record(allocator, 17, "did-commit-navigation", "views://test-harness/index.html");
    try std.testing.expect(observations.contains(18, "did-commit-navigation", "test-runner"));
    try std.testing.expect(!observations.contains(17, "did-commit-navigation", "test-runner"));
}

test "late same-event callbacks from old documents preserve history and duplicates are deduplicated" {
    const allocator = std.testing.allocator;
    var observations: WebviewObservations = .{};
    defer observations.deinit(allocator);
    try observations.record(allocator, 18, "did-commit-navigation", "views://test-runner/index.html");
    try observations.record(allocator, 18, "did-commit-navigation", "views://test-harness/index.html");
    try std.testing.expect(observations.contains(18, "did-commit-navigation", "test-runner"));
    try observations.record(allocator, 18, "did-commit-navigation", "views://test-runner/index.html");
    try std.testing.expect(observations.contains(18, "did-commit-navigation", "test-runner"));
    try std.testing.expectEqual(@as(usize, 2), observations.events.items.len);
}

test "navigation requires matching view, event, and URL together" {
    const allocator = std.testing.allocator;
    var observations: WebviewObservations = .{};
    defer observations.deinit(allocator);
    try observations.record(allocator, 18, "did-commit-navigation", "views://test-harness/index.html");
    try observations.record(allocator, 18, "will-navigate", "views://test-runner/index.html");
    try observations.record(allocator, 17, "did-commit-navigation", "views://test-runner/index.html");
    try std.testing.expect(!observations.contains(18, "did-commit-navigation", "test-runner"));
    try observations.record(allocator, 18, "did-commit-navigation", "views://test-runner/index.html");
    try std.testing.expect(observations.contains(18, "did-commit-navigation", "test-runner"));
    observations.clear(allocator);
    try std.testing.expect(!observations.contains(18, "did-commit-navigation", "test-runner"));
}

test "observations own callback text after the callback returns" {
    const allocator = std.testing.allocator;
    var observations: WebviewObservations = .{};
    defer observations.deinit(allocator);
    var name = "did-navigate".*;
    var detail = "views://test-runner/index.html".*;
    try observations.record(allocator, 18, &name, &detail);
    @memset(&name, 'x');
    @memset(&detail, 'x');
    try std.testing.expect(observations.contains(18, "did-navigate", "test-runner"));
}

test "failed recording releases every partial allocation" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, exerciseRecording, .{});
}

fn exerciseRecording(allocator: std.mem.Allocator) !void {
    var observations: WebviewObservations = .{};
    defer observations.deinit(allocator);
    try observations.record(allocator, 18, "did-navigate", "views://test-runner/index.html");
    try observations.record(allocator, 19, "did-navigate", "views://test-harness/index.html");
}

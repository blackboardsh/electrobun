//! Fine-grained reactivity in the core. Signals hold dynamically typed
//! values; computeds and effects track the signals they read and re-run
//! only when those change (push-dirty / pull-recompute). Everything is
//! addressed by handles so every language binding can use the same graph,
//! and templates (template.zig) bind DOM nodes directly to it.
const std = @import("std");

const Allocator = std.mem.Allocator;

pub const NodeId = u32;
pub const none: NodeId = 0;

/// Reactive value. Strings are owned by the graph.
pub const Value = union(enum) {
    nil,
    boolean: bool,
    number: f64,
    string: []const u8,
    list: ListId,
    scope: ScopeId,

    pub fn eql(a: Value, b: Value) bool {
        if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
        return switch (a) {
            .nil => true,
            .boolean => |x| x == b.boolean,
            .number => |x| x == b.number,
            .string => |x| std.mem.eql(u8, x, b.string),
            .list => |x| x == b.list,
            .scope => |x| x == b.scope,
        };
    }

    pub fn truthy(v: Value) bool {
        return switch (v) {
            .nil => false,
            .boolean => |b| b,
            .number => |n| n != 0 and !std.math.isNan(n),
            .string => |s| s.len > 0,
            .list, .scope => true,
        };
    }

    pub fn format(v: Value, w: *std.Io.Writer) std.Io.Writer.Error!void {
        switch (v) {
            .nil => {},
            .boolean => |b| try w.writeAll(if (b) "true" else "false"),
            .number => |n| {
                if (@floor(n) == n and @abs(n) < 1e15) {
                    try w.print("{d}", .{@as(i64, @intFromFloat(n))});
                } else try w.print("{d}", .{n});
            },
            .string => |s| try w.writeAll(s),
            .list => try w.writeAll("[list]"),
            .scope => try w.writeAll("[object]"),
        }
    }
};

pub const ListId = u32;
pub const ScopeId = u32;

pub const ComputeFn = *const fn (ctx: ?*anyopaque, rt: *Runtime) Value;
pub const EffectFn = *const fn (ctx: ?*anyopaque, rt: *Runtime) void;

const Kind = enum(u8) { signal, computed, effect };

const Node = struct {
    kind: Kind,
    value: Value = .nil,
    version: u64 = 0,
    /// computed/effect: dependencies seen on the last run (node, version)
    sources: std.ArrayList(Source) = .empty,
    observers: std.ArrayList(NodeId) = .empty,
    func: ?*const anyopaque = null,
    ctx: ?*anyopaque = null,
    dirty: bool = true,
    scheduled: bool = false,
    disposed: bool = false,
    /// last global version this computed was validated at
    checked_at: u64 = 0,
    cleanup: ?*const fn (ctx: ?*anyopaque) void = null,
};

const Source = struct { node: NodeId, version: u64 };

/// A reactive ordered collection of values (usually scopes).
pub const List = struct {
    items: std.ArrayList(Value) = .empty,
    /// a signal bumped on every structural change (tracked by readers)
    sig: NodeId,
};

/// A scope is a reactive record: named slots holding signal ids or handlers.
pub const Scope = struct {
    parent: ScopeId = 0,
    names: std.ArrayList([]const u8) = .empty,
    slots: std.ArrayList(Slot) = .empty,
};

pub const Slot = union(enum) {
    node: NodeId,
    handler: Handler,
};

pub const Handler = struct {
    func: *const fn (ctx: ?*anyopaque, rt: *Runtime, scope: ScopeId, arg: ?*anyopaque) void,
    ctx: ?*anyopaque,
};

pub const Runtime = struct {
    gpa: Allocator,
    nodes: std.ArrayList(Node) = .empty,
    free_nodes: std.ArrayList(NodeId) = .empty,
    lists: std.ArrayList(?List) = .empty,
    scopes: std.ArrayList(?Scope) = .empty,
    /// observer currently running (tracking target)
    current: NodeId = none,
    batch_depth: u32 = 0,
    pending: std.ArrayList(NodeId) = .empty,
    global_version: u64 = 1,
    /// called when effects are queued outside a batch (host may flush later)
    on_schedule: ?*const fn (ctx: ?*anyopaque) void = null,
    on_schedule_ctx: ?*anyopaque = null,
    /// run effects synchronously after a set outside batch
    auto_flush: bool = true,

    pub fn init(gpa: Allocator) Runtime {
        var rt = Runtime{ .gpa = gpa };
        rt.nodes.append(gpa, .{ .kind = .signal, .disposed = true }) catch {};
        rt.lists.append(gpa, null) catch {};
        rt.scopes.append(gpa, null) catch {};
        return rt;
    }

    pub fn deinit(rt: *Runtime) void {
        for (rt.nodes.items) |*n| rt.freeNode(n);
        rt.nodes.deinit(rt.gpa);
        rt.free_nodes.deinit(rt.gpa);
        for (rt.lists.items) |*l| if (l.*) |*lst| {
            for (lst.items.items) |v| rt.freeValue(v);
            lst.items.deinit(rt.gpa);
        };
        rt.lists.deinit(rt.gpa);
        for (rt.scopes.items) |*s| if (s.*) |*sc| {
            for (sc.names.items) |nm| rt.gpa.free(nm);
            sc.names.deinit(rt.gpa);
            sc.slots.deinit(rt.gpa);
        };
        rt.scopes.deinit(rt.gpa);
        rt.pending.deinit(rt.gpa);
    }

    fn freeNode(rt: *Runtime, n: *Node) void {
        rt.freeValue(n.value);
        n.sources.deinit(rt.gpa);
        n.observers.deinit(rt.gpa);
    }

    fn freeValue(rt: *Runtime, v: Value) void {
        if (v == .string) rt.gpa.free(v.string);
    }

    fn own(rt: *Runtime, v: Value) !Value {
        return switch (v) {
            .string => |s| .{ .string = try rt.gpa.dupe(u8, s) },
            else => v,
        };
    }

    fn newNode(rt: *Runtime, n: Node) !NodeId {
        if (rt.free_nodes.pop()) |i| {
            rt.nodes.items[i] = n;
            return i;
        }
        try rt.nodes.append(rt.gpa, n);
        return @intCast(rt.nodes.items.len - 1);
    }

    pub fn node(rt: *Runtime, id: NodeId) *Node {
        return &rt.nodes.items[id];
    }

    // ------------------------------------------------------------------
    // Signals
    // ------------------------------------------------------------------

    pub fn signal(rt: *Runtime, initial: Value) !NodeId {
        return rt.newNode(.{ .kind = .signal, .value = try rt.own(initial), .version = 1 });
    }

    /// Read a signal or computed (tracked when inside a computed/effect).
    pub fn get(rt: *Runtime, id: NodeId) Value {
        if (id == none) return .nil;
        const n = rt.node(id);
        if (n.disposed) return .nil;
        if (n.kind == .computed) rt.refresh(id);
        rt.track(id);
        return rt.node(id).value;
    }

    /// Read without subscribing.
    pub fn peek(rt: *Runtime, id: NodeId) Value {
        if (id == none) return .nil;
        if (rt.node(id).kind == .computed) rt.refresh(id);
        return rt.node(id).value;
    }

    fn track(rt: *Runtime, id: NodeId) void {
        if (rt.current == none) return;
        const obs = rt.node(rt.current);
        for (obs.sources.items) |s| if (s.node == id) return;
        obs.sources.append(rt.gpa, .{ .node = id, .version = rt.node(id).version }) catch return;
        const src = rt.node(id);
        for (src.observers.items) |o| if (o == rt.current) return;
        src.observers.append(rt.gpa, rt.current) catch {};
    }

    pub fn set(rt: *Runtime, id: NodeId, v: Value) !void {
        const n = rt.node(id);
        if (n.kind != .signal or n.disposed) return;
        if (n.value.eql(v)) return;
        const owned = try rt.own(v);
        rt.freeValue(n.value);
        n.value = owned;
        n.version += 1;
        rt.global_version += 1;
        rt.notify(id);
        rt.maybeFlush();
    }

    /// Force observers to re-run (e.g. after mutating a list in place).
    pub fn touch(rt: *Runtime, id: NodeId) void {
        const n = rt.node(id);
        n.version += 1;
        rt.global_version += 1;
        rt.notify(id);
        rt.maybeFlush();
    }

    fn notify(rt: *Runtime, id: NodeId) void {
        // observers can unsubscribe while we iterate: copy
        var buf: [64]NodeId = undefined;
        const obs = rt.node(id).observers.items;
        const heap = obs.len > buf.len;
        const targets = if (!heap) blk: {
            @memcpy(buf[0..obs.len], obs);
            break :blk buf[0..obs.len];
        } else rt.gpa.dupe(NodeId, obs) catch return;
        defer if (heap) rt.gpa.free(targets);
        for (targets) |o| {
            const on = rt.node(o);
            if (on.disposed) continue;
            switch (on.kind) {
                .computed => if (!on.dirty) {
                    on.dirty = true;
                    rt.notify(o);
                },
                .effect => if (!on.scheduled) {
                    on.scheduled = true;
                    rt.pending.append(rt.gpa, o) catch {};
                },
                .signal => {},
            }
        }
    }

    fn maybeFlush(rt: *Runtime) void {
        if (rt.batch_depth > 0) return;
        if (rt.pending.items.len == 0) return;
        if (rt.auto_flush) {
            rt.flush();
        } else if (rt.on_schedule) |f| f(rt.on_schedule_ctx);
    }

    pub fn batchBegin(rt: *Runtime) void {
        rt.batch_depth += 1;
    }

    pub fn batchEnd(rt: *Runtime) void {
        rt.batch_depth -= 1;
        rt.maybeFlush();
    }

    /// Run queued effects until quiescent.
    pub fn flush(rt: *Runtime) void {
        var guard: usize = 0;
        while (rt.pending.items.len > 0 and guard < 100) : (guard += 1) {
            const batch = rt.pending.toOwnedSlice(rt.gpa) catch return;
            defer rt.gpa.free(batch);
            for (batch) |e| {
                const n = rt.node(e);
                n.scheduled = false;
                if (n.disposed) continue;
                if (rt.sourcesChanged(e)) rt.runEffect(e);
            }
        }
    }

    // ------------------------------------------------------------------
    // Computeds and effects
    // ------------------------------------------------------------------

    pub fn computed(rt: *Runtime, func: ComputeFn, ctx: ?*anyopaque) !NodeId {
        return rt.newNode(.{ .kind = .computed, .func = @ptrCast(func), .ctx = ctx, .dirty = true });
    }

    pub fn effect(rt: *Runtime, func: EffectFn, ctx: ?*anyopaque) !NodeId {
        const id = try rt.newNode(.{ .kind = .effect, .func = @ptrCast(func), .ctx = ctx });
        rt.runEffect(id);
        return id;
    }

    /// Like `effect` with a cleanup run before each re-run and on dispose.
    pub fn effectWithCleanup(rt: *Runtime, func: EffectFn, ctx: ?*anyopaque, cleanup: *const fn (?*anyopaque) void) !NodeId {
        const id = try rt.newNode(.{ .kind = .effect, .func = @ptrCast(func), .ctx = ctx, .cleanup = cleanup });
        rt.runEffect(id);
        return id;
    }

    fn sourcesChanged(rt: *Runtime, id: NodeId) bool {
        const n = rt.node(id);
        if (n.sources.items.len == 0) return n.kind == .effect;
        for (n.sources.items) |s| {
            const src = rt.node(s.node);
            if (src.disposed) return true;
            if (src.kind == .computed) rt.refresh(s.node);
            if (rt.node(s.node).version != s.version) return true;
        }
        return false;
    }

    fn unsubscribe(rt: *Runtime, id: NodeId) void {
        const n = rt.node(id);
        for (n.sources.items) |s| {
            const src = rt.node(s.node);
            var i: usize = 0;
            while (i < src.observers.items.len) {
                if (src.observers.items[i] == id) _ = src.observers.swapRemove(i) else i += 1;
            }
        }
        n.sources.clearRetainingCapacity();
    }

    fn runEffect(rt: *Runtime, id: NodeId) void {
        const n = rt.node(id);
        if (n.cleanup) |c| c(n.ctx);
        rt.unsubscribe(id);
        const prev = rt.current;
        rt.current = id;
        const f: EffectFn = @ptrCast(@alignCast(rt.node(id).func.?));
        f(rt.node(id).ctx, rt);
        rt.current = prev;
    }

    fn refresh(rt: *Runtime, id: NodeId) void {
        const n = rt.node(id);
        if (!n.dirty and n.checked_at == rt.global_version) return;
        if (!n.dirty and n.sources.items.len > 0 and !rt.sourcesChanged(id)) {
            rt.node(id).checked_at = rt.global_version;
            return;
        }
        rt.unsubscribe(id);
        const prev = rt.current;
        rt.current = id;
        const f: ComputeFn = @ptrCast(@alignCast(rt.node(id).func.?));
        const v = f(rt.node(id).ctx, rt);
        rt.current = prev;
        const nn = rt.node(id);
        nn.dirty = false;
        nn.checked_at = rt.global_version;
        if (!nn.value.eql(v) or nn.version == 0) {
            const owned = rt.own(v) catch v;
            rt.freeValue(nn.value);
            nn.value = owned;
            nn.version += 1;
        }
    }

    pub fn dispose(rt: *Runtime, id: NodeId) void {
        if (id == none) return;
        const n = rt.node(id);
        if (n.disposed) return;
        if (n.cleanup) |c| c(n.ctx);
        rt.unsubscribe(id);
        rt.freeValue(n.value);
        n.value = .nil;
        n.observers.deinit(rt.gpa);
        n.observers = .empty;
        n.disposed = true;
        rt.free_nodes.append(rt.gpa, id) catch {};
    }

    /// Run `f` without tracking.
    pub fn untracked(rt: *Runtime, comptime f: anytype, args: anytype) @typeInfo(@TypeOf(f)).@"fn".return_type.? {
        const prev = rt.current;
        rt.current = none;
        defer rt.current = prev;
        return @call(.auto, f, args);
    }

    // ------------------------------------------------------------------
    // Lists
    // ------------------------------------------------------------------

    pub fn list(rt: *Runtime) !ListId {
        const sig = try rt.signal(.{ .number = 0 });
        try rt.lists.append(rt.gpa, .{ .sig = sig });
        return @intCast(rt.lists.items.len - 1);
    }

    pub fn listItems(rt: *Runtime, id: ListId) []const Value {
        const l = &(rt.lists.items[id] orelse return &.{});
        rt.track(l.sig);
        return l.items.items;
    }

    pub fn listLen(rt: *Runtime, id: ListId) usize {
        return rt.listItems(id).len;
    }

    fn listChanged(rt: *Runtime, l: *List) void {
        const n = rt.node(l.sig);
        n.value = .{ .number = @floatFromInt(l.items.items.len) };
        rt.touch(l.sig);
    }

    pub fn listPush(rt: *Runtime, id: ListId, v: Value) !void {
        const l = &(rt.lists.items[id] orelse return);
        try l.items.append(rt.gpa, try rt.own(v));
        rt.listChanged(l);
    }

    pub fn listInsert(rt: *Runtime, id: ListId, index: usize, v: Value) !void {
        const l = &(rt.lists.items[id] orelse return);
        try l.items.insert(rt.gpa, @min(index, l.items.items.len), try rt.own(v));
        rt.listChanged(l);
    }

    pub fn listRemove(rt: *Runtime, id: ListId, index: usize) void {
        const l = &(rt.lists.items[id] orelse return);
        if (index >= l.items.items.len) return;
        const v = l.items.orderedRemove(index);
        rt.freeValue(v);
        rt.listChanged(l);
    }

    pub fn listMove(rt: *Runtime, id: ListId, from: usize, to: usize) void {
        const l = &(rt.lists.items[id] orelse return);
        if (from >= l.items.items.len or to >= l.items.items.len or from == to) return;
        const v = l.items.orderedRemove(from);
        l.items.insert(rt.gpa, to, v) catch return;
        rt.listChanged(l);
    }

    pub fn listClear(rt: *Runtime, id: ListId) void {
        const l = &(rt.lists.items[id] orelse return);
        for (l.items.items) |v| rt.freeValue(v);
        l.items.clearRetainingCapacity();
        rt.listChanged(l);
    }

    // ------------------------------------------------------------------
    // Scopes
    // ------------------------------------------------------------------

    pub fn scope(rt: *Runtime, parent: ScopeId) !ScopeId {
        try rt.scopes.append(rt.gpa, .{ .parent = parent });
        return @intCast(rt.scopes.items.len - 1);
    }

    pub fn freeScope(rt: *Runtime, id: ScopeId) void {
        if (id == 0 or id >= rt.scopes.items.len) return;
        if (rt.scopes.items[id]) |*sc| {
            for (sc.names.items) |nm| rt.gpa.free(nm);
            sc.names.deinit(rt.gpa);
            sc.slots.deinit(rt.gpa);
        }
        rt.scopes.items[id] = null;
    }

    fn slotIndex(sc: *const Scope, name: []const u8) ?usize {
        for (sc.names.items, 0..) |n, i| if (std.mem.eql(u8, n, name)) return i;
        return null;
    }

    pub fn defineSlot(rt: *Runtime, sid: ScopeId, name: []const u8, slot: Slot) !void {
        const sc = &(rt.scopes.items[sid] orelse return error.NoScope);
        if (slotIndex(sc, name)) |i| {
            sc.slots.items[i] = slot;
            return;
        }
        try sc.names.append(rt.gpa, try rt.gpa.dupe(u8, name));
        try sc.slots.append(rt.gpa, slot);
    }

    /// Define (or update) a named signal in a scope; returns its node.
    pub fn defineValue(rt: *Runtime, sid: ScopeId, name: []const u8, v: Value) !NodeId {
        if (rt.scopes.items[sid]) |*sc| {
            if (slotIndex(sc, name)) |i| {
                if (sc.slots.items[i] == .node) {
                    try rt.set(sc.slots.items[i].node, v);
                    return sc.slots.items[i].node;
                }
            }
        }
        const sig = try rt.signal(v);
        try rt.defineSlot(sid, name, .{ .node = sig });
        return sig;
    }

    pub fn defineHandler(rt: *Runtime, sid: ScopeId, name: []const u8, h: Handler) !void {
        try rt.defineSlot(sid, name, .{ .handler = h });
    }

    /// Find a slot by name, searching parent scopes.
    pub fn lookup(rt: *Runtime, sid: ScopeId, name: []const u8) ?struct { scope: ScopeId, slot: Slot } {
        var cur = sid;
        while (cur != 0) {
            const sc = &(rt.scopes.items[cur] orelse return null);
            if (slotIndex(sc, name)) |i| return .{ .scope = cur, .slot = sc.slots.items[i] };
            cur = sc.parent;
        }
        return null;
    }

    pub fn scopeValue(rt: *Runtime, sid: ScopeId, name: []const u8) Value {
        const r = rt.lookup(sid, name) orelse return .nil;
        return switch (r.slot) {
            .node => |n| rt.get(n),
            .handler => .nil,
        };
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "signals, computeds, effects" {
    var rt = Runtime.init(std.testing.allocator);
    defer rt.deinit();
    const a = try rt.signal(.{ .number = 1 });
    const b = try rt.signal(.{ .number = 2 });
    const Ctx = struct {
        a: NodeId,
        b: NodeId,
        sum: NodeId = 0,
        runs: u32 = 0,
        seen: f64 = 0,
        fn compute(ctx: ?*anyopaque, r: *Runtime) Value {
            const c: *@This() = @ptrCast(@alignCast(ctx.?));
            return .{ .number = r.get(c.a).number + r.get(c.b).number };
        }
        fn eff(ctx: ?*anyopaque, r: *Runtime) void {
            const c: *@This() = @ptrCast(@alignCast(ctx.?));
            c.runs += 1;
            c.seen = r.get(c.sum).number;
        }
    };
    var c = Ctx{ .a = a, .b = b };
    c.sum = try rt.computed(Ctx.compute, &c);
    _ = try rt.effect(Ctx.eff, &c);
    try std.testing.expectEqual(@as(f64, 3), c.seen);
    try rt.set(a, .{ .number = 10 });
    try std.testing.expectEqual(@as(f64, 12), c.seen);
    try std.testing.expectEqual(@as(u32, 2), c.runs);
    // batching coalesces
    rt.batchBegin();
    try rt.set(a, .{ .number = 1 });
    try rt.set(b, .{ .number = 1 });
    rt.batchEnd();
    try std.testing.expectEqual(@as(f64, 2), c.seen);
    try std.testing.expectEqual(@as(u32, 3), c.runs);
    // setting the same value does nothing
    try rt.set(a, .{ .number = 1 });
    try std.testing.expectEqual(@as(u32, 3), c.runs);
    // computed that does not change value does not re-run effect
    try rt.set(a, .{ .number = 0 });
    try rt.set(b, .{ .number = 2 });
    try std.testing.expectEqual(@as(f64, 2), c.seen);
}

test "scopes and lists" {
    var rt = Runtime.init(std.testing.allocator);
    defer rt.deinit();
    const root = try rt.scope(0);
    _ = try rt.defineValue(root, "title", .{ .string = "hello" });
    const child = try rt.scope(root);
    _ = try rt.defineValue(child, "n", .{ .number = 3 });
    try std.testing.expectEqualStrings("hello", rt.scopeValue(child, "title").string);
    const l = try rt.list();
    try rt.listPush(l, .{ .number = 1 });
    try rt.listPush(l, .{ .number = 2 });
    try std.testing.expectEqual(@as(usize, 2), rt.listLen(l));
    rt.listRemove(l, 0);
    try std.testing.expectEqual(@as(f64, 2), rt.listItems(l)[0].number);
}

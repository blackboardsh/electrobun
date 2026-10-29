//! C ABI for the UI core, shared by every Electrobun language backend
//! (TypeScript via FFI, Go, Rust, Odin, C, Zig).
//!
//! Design:
//! * Handles are integers: a `ui` id, DOM node ids, scope/signal ids.
//! * Mutations can be sent one call at a time or as a batched command buffer
//!   (`ebui_apply`), so FFI-heavy languages cross the boundary once per frame.
//! * Events are queued and polled (`ebui_poll_events`) as a compact binary
//!   record stream; an optional wakeup callback tells the host to poll.
//! * Templates bind to scopes of named values; template handlers become
//!   queued "handler" events, so no closures cross the ABI.
//!
//! All functions must be called from one thread per ui (or under the host's
//! lock); rendering happens in `ebui_update` and the host's present step.
const std = @import("std");
const ui_mod = @import("ui.zig");
const dom = @import("dom.zig");
const html = @import("html.zig");
const style_mod = @import("style.zig");
const events = @import("events.zig");
const reactive = @import("reactive.zig");
const template = @import("template.zig");
const layout = @import("layout.zig");
const font = @import("text/font.zig");

const gpa = std.heap.c_allocator;

// ---------------------------------------------------------------------------
// Locking: the app thread and the host's main thread share each UI.
// ---------------------------------------------------------------------------

var lock_owner = std.atomic.Value(u64).init(0);
var lock_depth: u32 = 0;

fn threadId() u64 {
    return @as(u64, std.Thread.getCurrentId()) + 1;
}

/// Recursive lock around all UI state (exported for in-process hosts).
pub fn lock() void {
    const me = threadId();
    if (lock_owner.load(.acquire) == me) {
        lock_depth += 1;
        return;
    }
    var spins: u32 = 0;
    while (lock_owner.cmpxchgWeak(0, me, .acquire, .monotonic) != null) {
        spins += 1;
        if (spins > 64) std.Thread.yield() catch {} else std.atomic.spinLoopHint();
    }
    lock_depth = 1;
}

pub fn unlock() void {
    lock_depth -= 1;
    if (lock_depth == 0) {
        // mutations from the app thread schedule a frame on the host
        for (instances.items) |maybe| if (maybe) |inst| {
            if (inst.request_frame) |f| if (inst.ui.doc.needs_paint or inst.ui.wantsFrames()) f(inst.request_frame_ctx);
        };
        lock_owner.store(0, .release);
    }
}

pub const ThreadCallback = *const fn (?*anyopaque) callconv(.c) void;
/// Synchronous dispatch: the callback and its borrowed arguments have finished
/// being used when this returns. Hosts may leave it null to use the caller.
pub const ThreadDispatch = *const fn (ThreadCallback, ?*anyopaque) callconv(.c) void;

/// Always dispatch BEFORE taking the UI lock. A host's event thread can be
/// waiting for this lock in a frame/input callback while the app calls us.
pub fn runOnThreadLocked(dispatch: ?ThreadDispatch, comptime T: type, args: *T, comptime operation: fn (*T) void) void {
    const Call = struct {
        fn run(ctx: ?*anyopaque) callconv(.c) void {
            lock();
            defer unlock();
            operation(@ptrCast(@alignCast(ctx.?)));
        }
    };
    if (dispatch) |f| f(Call.run, args) else Call.run(args);
}

pub const WatchedRect = struct {
    client: u32,
    /// x, y, w, h in window CSS px; null until first reported
    rect: ?[4]f32 = null,
    visible: bool = false,
};

pub const Instance = struct {
    ui: *ui_mod.Ui,
    rt: reactive.Runtime,
    mounter: template.Mounter,
    registry: template.Registry,
    templates: std.ArrayList(?*template.Template) = .empty,
    instances: std.ArrayList(?*template.Instance) = .empty,
    queue: std.ArrayList(u8) = .empty,
    /// listener ids registered through the ABI: (node, type) -> listener
    listeners: std.AutoHashMapUnmanaged(u64, u32) = .empty,
    /// elements whose window rect is reported when it changes (native views
    /// anchored over them): core node -> last reported state
    watches: std.AutoHashMapUnmanaged(u32, WatchedRect) = .empty,
    wakeup: ?*const fn (ctx: ?*anyopaque) callconv(.c) void = null,
    wakeup_ctx: ?*anyopaque = null,
    /// set by hosts that render this ui (electrobun host)
    request_frame: ?*const fn (ctx: ?*anyopaque) void = null,
    request_frame_ctx: ?*anyopaque = null,
    /// Native input may call thread-affine APIs (clipboard, window dragging).
    /// Snapshot this under the lock, then dispatch before taking it again.
    input_dispatch: ?ThreadDispatch = null,
    id: u32 = 0,
    event_serial: u32 = 0,
    last_event: usize = 0,
    scratch: std.heap.ArenaAllocator,
    string_out: std.ArrayList(u8) = .empty,
};

var instances: std.ArrayList(?*Instance) = .empty;

var io_state: ?std.Io.Threaded = null;
fn coreIo() std.Io {
    if (io_state == null) io_state = std.Io.Threaded.init(gpa, .{});
    return io_state.?.io();
}

/// Directory that relative image URLs resolve against (e.g. app resources).
export fn ebui_set_base_dir(id: u32, dir: ?[*]const u8, len: usize) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.ui.images.setBaseDir(span(dir, len)) catch {};
}

/// Register premultiplied RGBA pixels; returns an image id usable as
/// `src="image:<id>"`.
export fn ebui_add_image(id: u32, w: u32, h: u32, px: ?[*]const u8) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    const p = px orelse return 0;
    return inst.ui.images.addPixels(w, h, p[0 .. @as(usize, w) * h * 4]) catch 0;
}

fn get(id: u32) ?*Instance {
    if (id == 0 or id >= instances.items.len) return null;
    return instances.items[id];
}

fn span(p: ?[*]const u8, len: usize) []const u8 {
    const ptr = p orelse return "";
    return ptr[0..len];
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

pub export fn ebui_create() u32 {
    lock();
    defer unlock();
    if (instances.items.len == 0) instances.append(gpa, null) catch return 0;
    const ui = ui_mod.Ui.create(gpa, .{}) catch return 0;
    const inst = gpa.create(Instance) catch {
        ui.destroy();
        return 0;
    };
    inst.* = .{
        .ui = ui,
        .rt = reactive.Runtime.init(gpa),
        .mounter = undefined,
        .registry = .{ .gpa = gpa },
        .scratch = std.heap.ArenaAllocator.init(gpa),
    };
    inst.mounter = .{ .gpa = gpa, .ui = ui, .rt = &inst.rt, .components = &inst.registry };
    ui.ix.sink = null;
    ui.images.io = coreIo();
    instances.append(gpa, inst) catch return 0;
    _ = html.ensureBody(ui.doc) catch {};
    inst.id = @intCast(instances.items.len - 1);
    return inst.id;
}

/// Create with the deterministic mock font backend (tests, headless).
export fn ebui_create_headless() u32 {
    lock();
    defer unlock();
    if (instances.items.len == 0) instances.append(gpa, null) catch return 0;
    const fonts = font.MockBackend.create(gpa) catch return 0;
    const ui = ui_mod.Ui.create(gpa, .{ .fonts = fonts }) catch return 0;
    ui.owns_fonts = true;
    const inst = gpa.create(Instance) catch return 0;
    inst.* = .{ .ui = ui, .rt = reactive.Runtime.init(gpa), .mounter = undefined, .registry = .{ .gpa = gpa }, .scratch = std.heap.ArenaAllocator.init(gpa) };
    inst.mounter = .{ .gpa = gpa, .ui = ui, .rt = &inst.rt, .components = &inst.registry };
    instances.append(gpa, inst) catch return 0;
    _ = html.ensureBody(ui.doc) catch {};
    inst.id = @intCast(instances.items.len - 1);
    return inst.id;
}

pub export fn ebui_destroy(id: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    for (inst.instances.items) |m| if (m) |x| x.destroy();
    inst.instances.deinit(gpa);
    for (inst.templates.items) |t| if (t) |x| x.destroy();
    inst.templates.deinit(gpa);
    inst.registry.deinit();
    inst.rt.deinit();
    inst.ui.destroy();
    inst.queue.deinit(gpa);
    inst.listeners.deinit(gpa);
    inst.watches.deinit(gpa);
    inst.scratch.deinit();
    inst.string_out.deinit(gpa);
    gpa.destroy(inst);
    instances.items[id] = null;
}

/// The underlying engine (for in-process hosts such as ElectrobunCore).
pub fn engine(id: u32) ?*ui_mod.Ui {
    const inst = get(id) orelse return null;
    return inst.ui;
}

pub fn instance(id: u32) ?*Instance {
    return get(id);
}

export fn ebui_set_wakeup(id: u32, cb: ?*const fn (?*anyopaque) callconv(.c) void, ctx: ?*anyopaque) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.wakeup = cb;
    inst.wakeup_ctx = ctx;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export fn ebui_document_root(id: u32) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    return inst.ui.doc.root;
}

export fn ebui_body(id: u32) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    return html.ensureBody(inst.ui.doc) catch 0;
}

export fn ebui_create_element(id: u32, tag: ?[*]const u8, tag_len: usize) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    return inst.ui.doc.createElement(span(tag, tag_len)) catch 0;
}

export fn ebui_create_text(id: u32, text: ?[*]const u8, len: usize) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    return inst.ui.doc.createText(span(text, len)) catch 0;
}

export fn ebui_create_comment(id: u32) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    return inst.ui.doc.createComment() catch 0;
}

fn validNode(inst: *Instance, n: u32) bool {
    return inst.ui.doc.get(n) != null;
}

export fn ebui_insert_before(id: u32, parent: u32, child: u32, before: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (!validNode(inst, parent) or !validNode(inst, child)) return;
    if (before != 0 and (!validNode(inst, before) or inst.ui.doc.node(before).parent != parent)) {
        inst.ui.doc.appendChild(parent, child);
        return;
    }
    inst.ui.doc.insertBefore(parent, child, before);
}

export fn ebui_remove(id: u32, node: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (!validNode(inst, node)) return;
    inst.ui.doc.removeChild(node);
}

export fn ebui_destroy_node(id: u32, node: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (!validNode(inst, node)) return;
    inst.ui.destroyNode(node);
}

export fn ebui_set_attribute(id: u32, node: u32, name: ?[*]const u8, name_len: usize, value: ?[*]const u8, value_len: usize) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (!validNode(inst, node)) return;
    const n = span(name, name_len);
    const v = span(value, value_len);
    inst.ui.doc.setAttribute(node, n, v) catch {};
    // live properties of form controls
    if (std.ascii.eqlIgnoreCase(n, "value") and layout.isTextInput(inst.ui.doc, node)) inst.ui.ix.setValue(node, v) catch {};
    if (std.ascii.eqlIgnoreCase(n, "checked")) {
        var s = inst.ui.doc.node(node).state;
        s.checked = true;
        inst.ui.doc.setState(node, s);
    }
}

export fn ebui_remove_attribute(id: u32, node: u32, name: ?[*]const u8, name_len: usize) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (!validNode(inst, node)) return;
    const n = span(name, name_len);
    inst.ui.doc.removeAttribute(node, n) catch {};
    if (std.ascii.eqlIgnoreCase(n, "checked")) {
        var s = inst.ui.doc.node(node).state;
        s.checked = false;
        inst.ui.doc.setState(node, s);
    }
}

export fn ebui_set_text(id: u32, node: u32, text: ?[*]const u8, len: usize) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (!validNode(inst, node)) return;
    inst.ui.doc.setText(node, span(text, len)) catch {};
}

export fn ebui_set_style(id: u32, node: u32, prop: ?[*]const u8, prop_len: usize, value: ?[*]const u8, value_len: usize) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (!validNode(inst, node)) return;
    inst.ui.doc.setStyleProperty(node, span(prop, prop_len), span(value, value_len)) catch {};
}

/// Parse HTML and append the nodes to `parent` (0 = body).
export fn ebui_append_html(id: u32, parent: u32, src: ?[*]const u8, len: usize) bool {
    lock();
    defer unlock();
    const inst = get(id) orelse return false;
    const p = if (parent == 0) (html.ensureBody(inst.ui.doc) catch return false) else parent;
    html.parseInto(inst.ui.doc, p, span(src, len), .{ .implicit_root = false }) catch return false;
    return true;
}

export fn ebui_add_stylesheet(id: u32, css: ?[*]const u8, len: usize) usize {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    const sheet = inst.ui.doc.addStylesheet(span(css, len)) catch return 0;
    return @intFromPtr(sheet);
}

/// Add the built-in component stylesheet (eb-* classes).
export fn ebui_use_components(id: u32) usize {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    const sheet = inst.ui.doc.addStylesheet(ui_mod.Ui.components_css) catch return 0;
    return @intFromPtr(sheet);
}

export fn ebui_remove_stylesheet(id: u32, handle: usize) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    for (inst.ui.doc.sheets.items) |s| {
        if (@intFromPtr(s) == handle) {
            inst.ui.doc.removeStylesheet(s);
            return;
        }
    }
}

export fn ebui_query_selector(id: u32, scope: u32, sel: ?[*]const u8, len: usize) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    const s = if (scope == 0) inst.ui.doc.root else scope;
    return style_mod.querySelector(inst.ui.doc, s, span(sel, len)) catch 0;
}

/// Current value of a text control (valid until the next call).
export fn ebui_get_value(id: u32, node: u32, out_len: *usize) ?[*]const u8 {
    lock();
    defer unlock();
    const inst = get(id) orelse return null;
    if (!validNode(inst, node)) return null;
    const v = inst.ui.ix.value(node);
    inst.string_out.clearRetainingCapacity();
    inst.string_out.appendSlice(gpa, v) catch return null;
    out_len.* = inst.string_out.items.len;
    return inst.string_out.items.ptr;
}

export fn ebui_set_value(id: u32, node: u32, v: ?[*]const u8, len: usize) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (!validNode(inst, node)) return;
    inst.ui.ix.setValue(node, span(v, len)) catch {};
}

export fn ebui_get_checked(id: u32, node: u32) bool {
    lock();
    defer unlock();
    const inst = get(id) orelse return false;
    if (!validNode(inst, node)) return false;
    return inst.ui.doc.node(node).state.checked;
}

export fn ebui_focus(id: u32, node: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (node == 0) inst.ui.ix.blur() else if (validNode(inst, node)) inst.ui.ix.focus(node, false);
}

fn borderRect(inst: *Instance, node: u32) ?[4]f32 {
    const origin = inst.ui.ix.contentOrigin(node) orelse return null;
    const b = layout.boxOfNode(inst.ui.doc.node(node)) orelse return null;
    return .{ origin[0] - b.border.left - b.padding.left, origin[1] - b.border.top - b.padding.top, b.w, b.h };
}

/// Border-box of an element in window coordinates: out = [x, y, w, h].
export fn ebui_get_rect(id: u32, node: u32, out: *[4]f32) bool {
    lock();
    defer unlock();
    const inst = get(id) orelse return false;
    if (!validNode(inst, node)) return false;
    out.* = borderRect(inst, node) orelse return false;
    return true;
}

/// Report `node`'s window rect as `rect` event records (RecordKind.rect)
/// whenever it changes, after each frame's layout. The record carries the
/// client id bound to the node. `on = false` stops reporting.
export fn ebui_watch_rect(id: u32, node: u32, on: bool) bool {
    lock();
    defer unlock();
    const inst = get(id) orelse return false;
    if (!on) {
        _ = inst.watches.remove(node);
        return true;
    }
    if (!validNode(inst, node)) return false;
    inst.watches.put(gpa, node, .{ .client = clientOf(inst.id, node) }) catch return false;
    // report on the next frame even if nothing else changes
    if (inst.request_frame) |rf| rf(inst.request_frame_ctx);
    return true;
}

/// Whether an element currently occupies space on screen: it is alive, laid
/// out with a non-empty box, and neither it nor an ancestor is display:none
/// or visibility:hidden.
fn watchedVisible(inst: *Instance, node: u32) bool {
    const doc = inst.ui.doc;
    var cur = node;
    while (cur != dom.null_id) {
        const n = doc.get(cur) orelse return false;
        if (n.kind == .element) {
            const st = style_mod.of(doc, cur);
            if (st.display == .none) return false;
            if (cur == node and st.visibility != .visible) return false;
        }
        cur = n.parent;
    }
    return true;
}

/// Queue rect records for watched elements whose rect or visibility changed.
/// Hosts call this after updating layout for a frame (under the lock).
pub fn reportWatchedRects(inst: *Instance) void {
    if (inst.watches.count() == 0) return;
    var queued = false;
    var dead: std.ArrayList(u32) = .empty;
    defer dead.deinit(gpa);
    var it = inst.watches.iterator();
    while (it.next()) |kv| {
        const node = kv.key_ptr.*;
        const w = kv.value_ptr;
        const alive = inst.ui.doc.get(node) != null;
        const rect: ?[4]f32 = if (alive and watchedVisible(inst, node)) borderRect(inst, node) else null;
        const visible = if (rect) |r| r[2] > 0 and r[3] > 0 else false;
        const changed = visible != w.visible or w.rect == null or (rect != null and !std.meta.eql(rect.?, w.rect.?));
        if (!alive) dead.append(gpa, node) catch {};
        if (!changed and alive) continue;
        w.visible = visible;
        w.rect = rect orelse .{ 0, 0, 0, 0 };
        // Record: kind u8, client u32, x f32, y f32, w f32, h f32, visible u8
        const q = &inst.queue;
        q.append(gpa, @intFromEnum(RecordKind.rect)) catch return;
        appendU32(q, w.client);
        for (w.rect.?) |v| appendF32(q, v);
        q.append(gpa, @intFromBool(visible)) catch return;
        queued = true;
    }
    for (dead.items) |n| _ = inst.watches.remove(n);
    if (queued) if (inst.wakeup) |wk| wk(inst.wakeup_ctx);
}

export fn ebui_scroll_into_view(id: u32, node: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (validNode(inst, node)) inst.ui.ix.scrollIntoView(node);
}

// ---------------------------------------------------------------------------
// Batched commands
// ---------------------------------------------------------------------------

/// Command opcodes for ebui_apply. Layout: u8 opcode followed by fields;
/// integers are little-endian u32, strings are u32 length + bytes.
pub const Cmd = enum(u8) {
    create_element = 1, // id, tag
    create_text = 2, // id, text
    insert_before = 3, // parent, child, before
    remove = 4, // node
    destroy = 5, // node
    set_attribute = 6, // node, name, value
    remove_attribute = 7, // node, name
    set_text = 8, // node, text
    set_style = 9, // node, prop, value
    listen = 10, // node, event_type(u8)
    unlisten = 11, // node, event_type(u8)
    create_comment = 12, // id
    set_value = 13, // node, text
    focus = 14, // node
};

/// Client-chosen ids: commands that create nodes carry a client id, and the
/// core maps it to its own node id (returned via ebui_resolve).
const IdMap = std.AutoHashMapUnmanaged(u32, u32);
var id_maps: std.AutoHashMapUnmanaged(u32, IdMap) = .empty;
/// core node id -> client id, per ui (events report client ids)
var rev_maps: std.AutoHashMapUnmanaged(u32, IdMap) = .empty;

fn revMap(ui_id: u32) ?*IdMap {
    const gop = rev_maps.getOrPut(gpa, ui_id) catch return null;
    if (!gop.found_existing) gop.value_ptr.* = .empty;
    return gop.value_ptr;
}

fn clientOf(ui_id: u32, core: u32) u32 {
    const m = rev_maps.getPtr(ui_id) orelse return 0;
    return m.get(core) orelse 0;
}

fn mapId(ui_id: u32, client: u32) u32 {
    if (client == 0) return 0;
    const m = id_maps.getPtr(ui_id) orelse return client;
    return m.get(client) orelse client;
}

/// Map a client id to a core node id (0 if unknown).
export fn ebui_resolve(id: u32, client: u32) u32 {
    lock();
    defer unlock();
    return mapId(id, client);
}

const Reader = struct {
    buf: []const u8,
    pos: usize = 0,
    fn u8_(r: *Reader) ?u8 {
        if (r.pos >= r.buf.len) return null;
        r.pos += 1;
        return r.buf[r.pos - 1];
    }
    fn u32_(r: *Reader) ?u32 {
        if (r.pos + 4 > r.buf.len) return null;
        const v = std.mem.readInt(u32, r.buf[r.pos..][0..4], .little);
        r.pos += 4;
        return v;
    }
    fn str(r: *Reader) ?[]const u8 {
        const n = r.u32_() orelse return null;
        if (r.pos + n > r.buf.len) return null;
        const s = r.buf[r.pos .. r.pos + n];
        r.pos += n;
        return s;
    }
};

/// Apply a buffer of commands. Returns the number of commands applied.
export fn ebui_apply(id: u32, buf: ?[*]const u8, len: usize) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    var r = Reader{ .buf = span(buf, len) };
    const gop = id_maps.getOrPut(gpa, id) catch return 0;
    if (!gop.found_existing) gop.value_ptr.* = .empty;
    const map = gop.value_ptr;
    var count: u32 = 0;
    const doc = inst.ui.doc;
    while (r.pos < r.buf.len) {
        const op = std.enums.fromInt(Cmd, r.u8_() orelse break) orelse break;
        switch (op) {
            .create_element => {
                const cid = r.u32_() orelse break;
                const tag = r.str() orelse break;
                const nid = doc.createElement(tag) catch break;
                map.put(gpa, cid, nid) catch {};
                if (revMap(id)) |rm| rm.put(gpa, nid, cid) catch {};
            },
            .create_text => {
                const cid = r.u32_() orelse break;
                const text = r.str() orelse break;
                const nid = doc.createText(text) catch break;
                map.put(gpa, cid, nid) catch {};
                if (revMap(id)) |rm| rm.put(gpa, nid, cid) catch {};
            },
            .create_comment => {
                const cid = r.u32_() orelse break;
                const nid = doc.createComment() catch break;
                map.put(gpa, cid, nid) catch {};
                if (revMap(id)) |rm| rm.put(gpa, nid, cid) catch {};
            },
            .insert_before => {
                const p = map.get(r.u32_() orelse break) orelse 0;
                const c = map.get(r.u32_() orelse break) orelse 0;
                const bcid = r.u32_() orelse break;
                const b = if (bcid == 0) 0 else map.get(bcid) orelse 0;
                ebui_insert_before(id, p, c, b);
            },
            .remove => ebui_remove(id, map.get(r.u32_() orelse break) orelse 0),
            .destroy => {
                const cid = r.u32_() orelse break;
                const nid = map.get(cid) orelse 0;
                ebui_destroy_node(id, nid);
                _ = map.remove(cid);
                if (rev_maps.getPtr(id)) |rm| _ = rm.remove(nid);
            },
            .set_attribute => {
                const n = map.get(r.u32_() orelse break) orelse 0;
                const name = r.str() orelse break;
                const value = r.str() orelse break;
                ebui_set_attribute(id, n, name.ptr, name.len, value.ptr, value.len);
            },
            .remove_attribute => {
                const n = map.get(r.u32_() orelse break) orelse 0;
                const name = r.str() orelse break;
                ebui_remove_attribute(id, n, name.ptr, name.len);
            },
            .set_text => {
                const n = map.get(r.u32_() orelse break) orelse 0;
                const text = r.str() orelse break;
                ebui_set_text(id, n, text.ptr, text.len);
            },
            .set_style => {
                const n = map.get(r.u32_() orelse break) orelse 0;
                const p = r.str() orelse break;
                const v = r.str() orelse break;
                ebui_set_style(id, n, p.ptr, p.len, v.ptr, v.len);
            },
            .listen => {
                const n = map.get(r.u32_() orelse break) orelse 0;
                const t = r.u8_() orelse break;
                _ = ebui_listen(id, n, t);
            },
            .unlisten => {
                const n = map.get(r.u32_() orelse break) orelse 0;
                const t = r.u8_() orelse break;
                ebui_unlisten(id, n, t);
            },
            .set_value => {
                const n = map.get(r.u32_() orelse break) orelse 0;
                const v = r.str() orelse break;
                ebui_set_value(id, n, v.ptr, v.len);
            },
            .focus => ebui_focus(id, map.get(r.u32_() orelse break) orelse 0),
        }
        count += 1;
    }
    return count;
}

/// Bind an existing core node (e.g. body) to a client id for the command protocol.
export fn ebui_bind_client_id(id: u32, client: u32, node: u32) void {
    lock();
    defer unlock();
    const gop = id_maps.getOrPut(gpa, id) catch return;
    if (!gop.found_existing) gop.value_ptr.* = .empty;
    gop.value_ptr.put(gpa, client, node) catch {};
    if (revMap(id)) |rm| rm.put(gpa, node, client) catch {};
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Event record kinds in the queue.
pub const RecordKind = enum(u8) { dom = 1, handler = 2, rect = 3 };

fn listenerKey(node: u32, t: u8) u64 {
    return (@as(u64, node) << 8) | t;
}

fn domListener(ctx: ?*anyopaque, ev: *events.Event) void {
    const inst: *Instance = @ptrCast(@alignCast(ctx.?));
    // Record: kind u8, type u8, serial u32, target u32, current u32 (client
    // ids, 0 if unknown), target_core u32, x f32, y f32, button u8, mods u8,
    // detail u32, dx f32, dy f32, key str, data str
    const q = &inst.queue;
    const ui_id = inst.id;
    q.append(gpa, @intFromEnum(RecordKind.dom)) catch return;
    q.append(gpa, @intFromEnum(ev.type)) catch return;
    appendU32(q, ev.serial);
    appendU32(q, clientOf(ui_id, ev.target));
    appendU32(q, clientOf(ui_id, ev.current_target));
    appendU32(q, ev.target);
    appendF32(q, ev.x);
    appendF32(q, ev.y);
    q.append(gpa, ev.button) catch return;
    q.append(gpa, @bitCast(ev.mods)) catch return;
    appendU32(q, ev.detail);
    appendF32(q, ev.delta_x);
    appendF32(q, ev.delta_y);
    appendStr(q, ev.key);
    // input/change events carry the control's value
    const data = if (ev.type == .input or ev.type == .change) inst.ui.ix.value(ev.current_target) else ev.data;
    appendStr(q, data);
    if (inst.wakeup) |w| w(inst.wakeup_ctx);
}

fn appendU32(q: *std.ArrayList(u8), v: u32) void {
    var b: [4]u8 = undefined;
    std.mem.writeInt(u32, &b, v, .little);
    q.appendSlice(gpa, &b) catch {};
}
fn appendF32(q: *std.ArrayList(u8), v: f32) void {
    appendU32(q, @bitCast(v));
}
fn appendStr(q: *std.ArrayList(u8), s: []const u8) void {
    appendU32(q, @intCast(s.len));
    q.appendSlice(gpa, s) catch {};
}

/// Start delivering events of `type` (events.EventType ordinal) on `node`.
export fn ebui_listen(id: u32, node: u32, event_type: u8) bool {
    lock();
    defer unlock();
    const inst = get(id) orelse return false;
    if (!validNode(inst, node)) return false;
    const t = std.enums.fromInt(events.EventType, event_type) orelse return false;
    const key = listenerKey(node, event_type);
    if (inst.listeners.contains(key)) return true;
    const lid = inst.ui.ix.addListener(node, t, domListener, inst) catch return false;
    inst.listeners.put(gpa, key, lid) catch {};
    return true;
}

export fn ebui_unlisten(id: u32, node: u32, event_type: u8) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    const key = listenerKey(node, event_type);
    if (inst.listeners.fetchRemove(key)) |kv| inst.ui.ix.removeListener(kv.value);
}

/// Event type ordinal for a DOM event name ("click", "input", ...); 255 if unknown.
export fn ebui_event_type(name: ?[*]const u8, len: usize) u8 {
    lock();
    defer unlock();
    const t = events.EventType.fromName(span(name, len)) orelse return 255;
    return @intFromEnum(t);
}

/// Copy queued event records into `out`. Returns bytes written; records are
/// never split (a too-small buffer returns 0 and keeps the queue).
export fn ebui_poll_events(id: u32, out: ?[*]u8, cap: usize) usize {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    const q = &inst.queue;
    if (q.items.len == 0) return 0;
    const dst = out orelse return q.items.len;
    if (q.items.len <= cap) {
        const n = q.items.len;
        @memcpy(dst[0..n], q.items);
        q.clearRetainingCapacity();
        return n;
    }
    return 0;
}

export fn ebui_pending_events(id: u32) usize {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    return inst.queue.items.len;
}

// ---------------------------------------------------------------------------
// Reactive scopes and templates
// ---------------------------------------------------------------------------

export fn ebui_scope_create(id: u32, parent: u32) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    return inst.rt.scope(parent) catch 0;
}

export fn ebui_scope_destroy(id: u32, scope: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.freeScope(scope);
}

fn setValue(id: u32, scope: u32, name: []const u8, v: reactive.Value) u32 {
    const inst = get(id) orelse return 0;
    return inst.rt.defineValue(scope, name, v) catch 0;
}

/// Define or update a named value; returns the signal id.
export fn ebui_scope_set_number(id: u32, scope: u32, name: ?[*]const u8, name_len: usize, v: f64) u32 {
    lock();
    defer unlock();
    return setValue(id, scope, span(name, name_len), .{ .number = v });
}
export fn ebui_scope_set_bool(id: u32, scope: u32, name: ?[*]const u8, name_len: usize, v: bool) u32 {
    lock();
    defer unlock();
    return setValue(id, scope, span(name, name_len), .{ .boolean = v });
}
export fn ebui_scope_set_string(id: u32, scope: u32, name: ?[*]const u8, name_len: usize, v: ?[*]const u8, v_len: usize) u32 {
    lock();
    defer unlock();
    return setValue(id, scope, span(name, name_len), .{ .string = span(v, v_len) });
}
/// Make a named slot hold a nested scope (an object).
export fn ebui_scope_set_scope(id: u32, scope: u32, name: ?[*]const u8, name_len: usize, child: u32) u32 {
    lock();
    defer unlock();
    return setValue(id, scope, span(name, name_len), .{ .scope = child });
}
/// Make a named slot hold a list; returns the list id.
export fn ebui_scope_set_list(id: u32, scope: u32, name: ?[*]const u8, name_len: usize) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    const l = inst.rt.list() catch return 0;
    _ = inst.rt.defineValue(scope, span(name, name_len), .{ .list = l }) catch return 0;
    return l;
}

export fn ebui_signal_set_number(id: u32, sig: u32, v: f64) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.set(sig, .{ .number = v }) catch {};
}
export fn ebui_signal_set_string(id: u32, sig: u32, v: ?[*]const u8, len: usize) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.set(sig, .{ .string = span(v, len) }) catch {};
}
export fn ebui_signal_set_bool(id: u32, sig: u32, v: bool) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.set(sig, .{ .boolean = v }) catch {};
}
export fn ebui_signal_get_number(id: u32, sig: u32) f64 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    const v = inst.rt.peek(sig);
    return if (v == .number) v.number else if (v == .boolean) @as(f64, @floatFromInt(@intFromBool(v.boolean))) else 0;
}
export fn ebui_signal_get_string(id: u32, sig: u32, out_len: *usize) ?[*]const u8 {
    lock();
    defer unlock();
    const inst = get(id) orelse return null;
    const v = inst.rt.peek(sig);
    inst.string_out.clearRetainingCapacity();
    var w = std.Io.Writer.Allocating.fromArrayList(gpa, &inst.string_out);
    v.format(&w.writer) catch {};
    inst.string_out = w.toArrayList();
    out_len.* = inst.string_out.items.len;
    return inst.string_out.items.ptr;
}

export fn ebui_batch_begin(id: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.batchBegin();
}
export fn ebui_batch_end(id: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.batchEnd();
}

export fn ebui_list_push_scope(id: u32, list: u32, scope: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.listPush(list, .{ .scope = scope }) catch {};
}
export fn ebui_list_insert_scope(id: u32, list: u32, index: u32, scope: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.listInsert(list, index, .{ .scope = scope }) catch {};
}
export fn ebui_list_push_string(id: u32, list: u32, v: ?[*]const u8, len: usize) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.listPush(list, .{ .string = span(v, len) }) catch {};
}
export fn ebui_list_push_number(id: u32, list: u32, v: f64) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.listPush(list, .{ .number = v }) catch {};
}
export fn ebui_list_remove(id: u32, list: u32, index: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.listRemove(list, index);
}
export fn ebui_list_move(id: u32, list: u32, from: u32, to: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.listMove(list, from, to);
}
export fn ebui_list_clear(id: u32, list: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.rt.listClear(list);
}
export fn ebui_list_len(id: u32, list: u32) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    return @intCast(inst.rt.listLen(list));
}

const HandlerCtx = struct {
    inst: *Instance,
    name: []u8,
};

var handler_ctxs: std.ArrayList(*HandlerCtx) = .empty;

fn queuedHandler(ctx: ?*anyopaque, rt: *reactive.Runtime, scope: reactive.ScopeId, arg: ?*anyopaque) void {
    _ = rt;
    const h: *HandlerCtx = @ptrCast(@alignCast(ctx.?));
    const inst = h.inst;
    const args: ?*template.CallArgs = @ptrCast(@alignCast(arg));
    // Record: kind u8, name str, scope u32, argc u8, args (tag u8 + payload),
    // then the triggering DOM event's type u8 + target u32 (or 255 + 0)
    const q = &inst.queue;
    q.append(gpa, @intFromEnum(RecordKind.handler)) catch return;
    appendStr(q, h.name);
    appendU32(q, scope);
    const argv: []const reactive.Value = if (args) |a| a.args else &.{};
    q.append(gpa, @intCast(@min(argv.len, 255))) catch return;
    for (argv) |v| switch (v) {
        .nil => q.append(gpa, 0) catch {},
        .boolean => |b| {
            q.append(gpa, 1) catch {};
            q.append(gpa, @intFromBool(b)) catch {};
        },
        .number => |n| {
            q.append(gpa, 2) catch {};
            var b: [8]u8 = undefined;
            std.mem.writeInt(u64, &b, @bitCast(n), .little);
            q.appendSlice(gpa, &b) catch {};
        },
        .string => |s| {
            q.append(gpa, 3) catch {};
            appendStr(q, s);
        },
        .scope => |s| {
            q.append(gpa, 4) catch {};
            appendU32(q, s);
        },
        .list => |l| {
            q.append(gpa, 5) catch {};
            appendU32(q, l);
        },
    };
    const ev: ?*events.Event = if (args) |a| a.event else null;
    if (ev) |e| {
        q.append(gpa, @intFromEnum(e.type)) catch {};
        appendU32(q, e.target);
    } else {
        q.append(gpa, 255) catch {};
        appendU32(q, 0);
    }
    if (inst.wakeup) |w| w(inst.wakeup_ctx);
}

/// Declare a handler name in a scope; calls arrive as handler records.
export fn ebui_scope_set_handler(id: u32, scope: u32, name: ?[*]const u8, name_len: usize) bool {
    lock();
    defer unlock();
    const inst = get(id) orelse return false;
    const h = gpa.create(HandlerCtx) catch return false;
    h.* = .{ .inst = inst, .name = gpa.dupe(u8, span(name, name_len)) catch return false };
    handler_ctxs.append(gpa, h) catch {};
    inst.rt.defineHandler(scope, h.name, .{ .func = queuedHandler, .ctx = h }) catch return false;
    return true;
}

/// Compile a template; returns a template id (0 on error).
export fn ebui_template_compile(id: u32, src: ?[*]const u8, len: usize) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    const t = template.compile(gpa, span(src, len), &inst.registry) catch return 0;
    if (inst.templates.items.len == 0) inst.templates.append(gpa, null) catch {};
    inst.templates.append(gpa, t) catch return 0;
    return @intCast(inst.templates.items.len - 1);
}

/// Register a template as a component tag usable in other templates.
export fn ebui_component_register(id: u32, name: ?[*]const u8, name_len: usize, src: ?[*]const u8, len: usize) bool {
    lock();
    defer unlock();
    const inst = get(id) orelse return false;
    const t = template.compile(gpa, span(src, len), &inst.registry) catch return false;
    inst.registry.register(span(name, name_len), .{ .template = t }) catch return false;
    return true;
}

/// Mount a compiled template with `scope` under `parent` (0 = body) before
/// `before` (0 = append). Returns a mount id.
export fn ebui_template_mount(id: u32, tpl: u32, scope: u32, parent: u32, before: u32) u32 {
    lock();
    defer unlock();
    const inst = get(id) orelse return 0;
    if (tpl == 0 or tpl >= inst.templates.items.len) return 0;
    const t = inst.templates.items[tpl] orelse return 0;
    const p = if (parent == 0) (html.ensureBody(inst.ui.doc) catch return 0) else parent;
    const m = inst.mounter.mount(t, scope, p, before) catch return 0;
    if (inst.instances.items.len == 0) inst.instances.append(gpa, null) catch {};
    inst.instances.append(gpa, m) catch return 0;
    return @intCast(inst.instances.items.len - 1);
}

export fn ebui_template_unmount(id: u32, mount_id: u32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    if (mount_id == 0 or mount_id >= inst.instances.items.len) return;
    if (inst.instances.items[mount_id]) |m| m.destroy();
    inst.instances.items[mount_id] = null;
}

// ---------------------------------------------------------------------------
// Frame / input (for hosts that own the window)
// ---------------------------------------------------------------------------

export fn ebui_resize(id: u32, w: f32, h: f32, scale: f32) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.ui.resize(w, h, scale);
}

export fn ebui_set_dark(id: u32, dark: bool) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.ui.setColorScheme(dark);
    inst.ui.doc.markAllStyleDirty();
}

/// The surface is alpha-composited (transparent window, overlay view): with
/// no html/body background the canvas stays transparent instead of white.
pub export fn ebui_set_transparent(id: u32, on: bool) void {
    lock();
    defer unlock();
    const inst = get(id) orelse return;
    inst.ui.setTransparent(on);
    if (inst.request_frame) |f| f(inst.request_frame_ctx);
}

/// Advance time and run style/layout/paint. Returns true if a frame is ready.
export fn ebui_update(id: u32, now: f64) bool {
    lock();
    defer unlock();
    const inst = get(id) orelse return false;
    inst.ui.tick(now);
    const changed = inst.ui.update() catch false;
    reportWatchedRects(inst);
    return changed;
}

export fn ebui_wants_frames(id: u32) bool {
    lock();
    defer unlock();
    const inst = get(id) orelse return false;
    return inst.ui.wantsFrames();
}

const InputCall = struct {
    id: u32,
    event: union(enum) {
        pointer: struct { kind: u8, x: f32, y: f32, button: u8, mods: u8 },
        wheel: struct { x: f32, y: f32, dx: f32, dy: f32, mods: u8 },
        key: struct { down: bool, text: []const u8, mods: u8 },
        text: []const u8,
        composition: struct { text: []const u8, sel: u32 },
    },

    fn run(a: *InputCall) void {
        const inst = get(a.id) orelse return;
        const ix = &inst.ui.ix;
        switch (a.event) {
            .pointer => |p| {
                const m: events.Modifiers = @bitCast(p.mods);
                switch (p.kind) {
                    0 => ix.pointerMove(p.x, p.y, m),
                    1 => ix.pointerDown(p.x, p.y, p.button, m),
                    2 => ix.pointerUp(p.x, p.y, p.button, m),
                    5 => ix.pointerLeaveWindow(),
                    else => {},
                }
            },
            .wheel => |w| ix.wheel(w.x, w.y, w.dx, w.dy, @bitCast(w.mods)),
            .key => |k| if (k.down) ix.keyDown(k.text, @bitCast(k.mods)) else ix.keyUp(k.text, @bitCast(k.mods)),
            .text => |text| ix.textInput(text),
            .composition => |c| ix.setComposition(c.text, c.sel),
        }
    }

    fn dispatch(a: *InputCall) void {
        lock();
        const dispatcher = if (get(a.id)) |inst| inst.input_dispatch else null;
        unlock();
        // Re-resolve the ID in run(): it may have been destroyed while waiting
        // for the host thread. Dispatch is synchronous, so text slices stay live.
        runOnThreadLocked(dispatcher, InputCall, a, run);
    }
};

export fn ebui_pointer(id: u32, kind: u8, x: f32, y: f32, button: u8, mods: u8) void {
    var call = InputCall{ .id = id, .event = .{ .pointer = .{ .kind = kind, .x = x, .y = y, .button = button, .mods = mods } } };
    call.dispatch();
}

export fn ebui_wheel(id: u32, x: f32, y: f32, dx: f32, dy: f32, mods: u8) void {
    var call = InputCall{ .id = id, .event = .{ .wheel = .{ .x = x, .y = y, .dx = dx, .dy = dy, .mods = mods } } };
    call.dispatch();
}

export fn ebui_key(id: u32, down: bool, key: ?[*]const u8, len: usize, mods: u8) void {
    var call = InputCall{ .id = id, .event = .{ .key = .{ .down = down, .text = span(key, len), .mods = mods } } };
    call.dispatch();
}

export fn ebui_text_input(id: u32, text: ?[*]const u8, len: usize) void {
    var call = InputCall{ .id = id, .event = .{ .text = span(text, len) } };
    call.dispatch();
}

export fn ebui_composition(id: u32, text: ?[*]const u8, len: usize, sel: u32) void {
    var call = InputCall{ .id = id, .event = .{ .composition = .{ .text = span(text, len), .sel = sel } } };
    call.dispatch();
}

/// Accessibility tree as text lines "role|name|value|flags" (tests, debugging).
export fn ebui_a11y_dump(id: u32, out_len: *usize) ?[*]const u8 {
    lock();
    defer unlock();
    const inst = get(id) orelse return null;
    _ = inst.ui.update() catch {};
    const a11y = @import("a11y.zig");
    const tree = a11y.build(gpa, inst.ui) catch return null;
    defer {
        tree.deinit();
        gpa.destroy(tree);
    }
    inst.string_out.clearRetainingCapacity();
    var w = std.Io.Writer.Allocating.fromArrayList(gpa, &inst.string_out);
    for (tree.nodes.items) |n| {
        w.writer.print("{s}|{s}|{s}|{s}{s}{s}\n", .{ @tagName(n.role), n.name, n.value, if (n.state.checked) "checked " else "", if (n.state.focused) "focused " else "", if (n.state.disabled) "disabled" else "" }) catch break;
    }
    inst.string_out = w.toArrayList();
    out_len.* = inst.string_out.items.len;
    return inst.string_out.items.ptr;
}

/// Serialize a subtree as HTML (debugging, tests). Valid until the next call.
export fn ebui_serialize(id: u32, node: u32, out_len: *usize) ?[*]const u8 {
    lock();
    defer unlock();
    const inst = get(id) orelse return null;
    if (!validNode(inst, node)) return null;
    inst.string_out.clearRetainingCapacity();
    inst.ui.doc.serialize(node, &inst.string_out) catch return null;
    out_len.* = inst.string_out.items.len;
    return inst.string_out.items.ptr;
}

// ---------------------------------------------------------------------------
// Tests (through the ABI)
// ---------------------------------------------------------------------------

fn str(s: []const u8) struct { ?[*]const u8, usize } {
    return .{ s.ptr, s.len };
}

test "c abi: commands, events, templates" {
    const id = ebui_create_headless();
    try std.testing.expect(id != 0);
    defer ebui_destroy(id);
    // command buffer
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(std.testing.allocator);
    const W = struct {
        fn u32_(b: *std.ArrayList(u8), v: u32) void {
            var t: [4]u8 = undefined;
            std.mem.writeInt(u32, &t, v, .little);
            b.appendSlice(std.testing.allocator, &t) catch {};
        }
        fn s(b: *std.ArrayList(u8), v: []const u8) void {
            u32_(b, @intCast(v.len));
            b.appendSlice(std.testing.allocator, v) catch {};
        }
    };
    ebui_bind_client_id(id, 1, ebui_body(id));
    try buf.append(std.testing.allocator, @intFromEnum(Cmd.create_element));
    W.u32_(&buf, 2);
    W.s(&buf, "button");
    try buf.append(std.testing.allocator, @intFromEnum(Cmd.create_text));
    W.u32_(&buf, 3);
    W.s(&buf, "Go");
    try buf.append(std.testing.allocator, @intFromEnum(Cmd.insert_before));
    W.u32_(&buf, 2);
    W.u32_(&buf, 3);
    W.u32_(&buf, 0);
    try buf.append(std.testing.allocator, @intFromEnum(Cmd.insert_before));
    W.u32_(&buf, 1);
    W.u32_(&buf, 2);
    W.u32_(&buf, 0);
    try buf.append(std.testing.allocator, @intFromEnum(Cmd.set_attribute));
    W.u32_(&buf, 2);
    W.s(&buf, "class");
    W.s(&buf, "primary");
    try buf.append(std.testing.allocator, @intFromEnum(Cmd.listen));
    W.u32_(&buf, 2);
    try buf.append(std.testing.allocator, ebui_event_type("click".ptr, 5));
    try std.testing.expectEqual(@as(u32, 6), ebui_apply(id, buf.items.ptr, buf.items.len));
    var len: usize = 0;
    const p = ebui_serialize(id, ebui_body(id), &len).?;
    try std.testing.expectEqualStrings("<body><button class=\"primary\">Go</button></body>", p[0..len]);
    // events are queued
    const btn = ebui_resolve(id, 2);
    get(id).?.ui.ix.click(btn, 1, 2, .{}, 1);
    var ev: [256]u8 = undefined;
    const n = ebui_poll_events(id, &ev, ev.len);
    try std.testing.expect(n > 0);
    try std.testing.expectEqual(@as(u8, 1), ev[0]);
    try std.testing.expectEqual(@intFromEnum(events.EventType.click), ev[1]);

    // template with a scope and a queued handler
    const sc = ebui_scope_create(id, 0);
    const count = ebui_scope_set_number(id, sc, "count".ptr, 5, 1);
    try std.testing.expect(ebui_scope_set_handler(id, sc, "bump".ptr, 4));
    const tsrc = "<p id=t onclick={bump(count)}>{count * 10}</p>";
    const tpl = ebui_template_compile(id, tsrc.ptr, tsrc.len);
    try std.testing.expect(tpl != 0);
    _ = ebui_template_mount(id, tpl, sc, 0, 0);
    ebui_signal_set_number(id, count, 4);
    const sel = "#t";
    const t = ebui_query_selector(id, 0, sel.ptr, sel.len);
    const ps = ebui_serialize(id, t, &len).?;
    try std.testing.expectEqualStrings("<p id=\"t\">40</p>", ps[0..len]);
    get(id).?.ui.ix.click(t, 0, 0, .{}, 1);
    const n2 = ebui_poll_events(id, &ev, ev.len);
    try std.testing.expect(n2 > 0);
    try std.testing.expectEqual(@as(u8, 2), ev[0]);
    try std.testing.expectEqualStrings("bump", ev[5..9]);
}

test "c abi: watched rects are reported only when they change" {
    const id = ebui_create_headless();
    defer ebui_destroy(id);
    ebui_resize(id, 400, 300, 1);
    const css = "body { margin: 0 } #a { position: absolute; left: 10px; top: 20px; width: 100px; height: 50px }";
    _ = ebui_add_stylesheet(id, css.ptr, css.len);
    const body = ebui_body(id);
    const tag = "div";
    const a = ebui_create_element(id, tag.ptr, tag.len);
    ebui_insert_before(id, body, a, 0);
    ebui_set_attribute(id, a, "id".ptr, 2, "a".ptr, 1);
    ebui_bind_client_id(id, 42, a);
    try std.testing.expect(ebui_watch_rect(id, a, true));

    const Rec = struct { client: u32, r: [4]f32, visible: bool };
    const read = struct {
        fn f(ui_id: u32) ?Rec {
            var buf: [256]u8 = undefined;
            const n = ebui_poll_events(ui_id, &buf, buf.len);
            if (n == 0) return null;
            std.debug.assert(buf[0] == @intFromEnum(RecordKind.rect) and n == 22);
            var r: [4]f32 = undefined;
            for (0..4) |i| r[i] = @bitCast(std.mem.readInt(u32, buf[5 + i * 4 ..][0..4], .little));
            return .{ .client = std.mem.readInt(u32, buf[1..5], .little), .r = r, .visible = buf[21] == 1 };
        }
    }.f;

    _ = ebui_update(id, 0);
    const first = read(id).?;
    try std.testing.expectEqual(@as(u32, 42), first.client);
    try std.testing.expectEqual([4]f32{ 10, 20, 100, 50 }, first.r);
    try std.testing.expect(first.visible);
    // no change, no record
    _ = ebui_update(id, 0.016);
    try std.testing.expect(read(id) == null);
    // layout change is reported
    ebui_set_style(id, a, "width".ptr, 5, "160px".ptr, 5);
    _ = ebui_update(id, 0.032);
    try std.testing.expectEqual([4]f32{ 10, 20, 160, 50 }, read(id).?.r);
    // hidden, then removed
    ebui_set_style(id, a, "display".ptr, 7, "none".ptr, 4);
    _ = ebui_update(id, 0.048);
    try std.testing.expect(!read(id).?.visible);
    ebui_set_style(id, a, "display".ptr, 7, "block".ptr, 5);
    _ = ebui_update(id, 0.064);
    try std.testing.expect(read(id).?.visible);
    ebui_destroy_node(id, a);
    _ = ebui_update(id, 0.08);
    try std.testing.expect(!read(id).?.visible);
    try std.testing.expectEqual(@as(u32, 0), inst_watch_count(id));
}

fn inst_watch_count(id: u32) u32 {
    const inst = get(id) orelse return 0;
    return inst.watches.count();
}

test "host dispatch enters the event thread before taking the UI lock" {
    const Harness = struct {
        queued: std.atomic.Value(bool) = .init(false),
        done: std.atomic.Value(bool) = .init(false),
        callback: ?ThreadCallback = null,
        ctx: ?*anyopaque = null,
        operation_thread: u64 = 0,
        operation_locked: bool = false,

        fn dispatch(callback: ThreadCallback, ctx: ?*anyopaque) callconv(.c) void {
            const h: *@This() = @ptrCast(@alignCast(ctx.?));
            h.callback = callback;
            h.ctx = ctx;
            h.queued.store(true, .release);
            // Models synchronous main-thread dispatch. The caller cannot return
            // (and its stack arguments cannot expire) before main completes it.
            while (!h.done.load(.acquire)) std.Thread.yield() catch {};
        }

        fn operation(h: *@This()) void {
            h.operation_thread = threadId();
            h.operation_locked = lock_owner.load(.acquire) == threadId() and lock_depth > 0;
        }

        fn worker(h: *@This()) void {
            runOnThreadLocked(dispatch, @This(), h, operation);
        }
    };
    var h: Harness = .{};
    // Simulate a main-thread frame holding the UI lock. The app must still be
    // able to enqueue its lifecycle operation instead of waiting for this lock
    // before dispatch. Bound the wait and drain the worker even on regression.
    lock();
    const worker = std.Thread.spawn(.{}, Harness.worker, .{&h}) catch |err| {
        unlock();
        return err;
    };
    const start = std.Io.Clock.awake.now(std.testing.io);
    while (!h.queued.load(.acquire) and start.durationTo(std.Io.Clock.awake.now(std.testing.io)).toMilliseconds() < 5_000) {
        std.Thread.yield() catch {};
    }
    const queued_without_lock = h.queued.load(.acquire);
    unlock();
    if (queued_without_lock) h.callback.?(h.ctx);
    h.done.store(true, .release);
    worker.join();
    try std.testing.expect(queued_without_lock);
    try std.testing.expect(h.operation_locked);
    try std.testing.expectEqual(threadId(), h.operation_thread);
}

test "c abi: synthetic input dispatches outside the lock and rechecks UI lifetime" {
    const Host = struct {
        var dispatched: usize = 0;
        var dispatched_unlocked: bool = true;
        var destroy_before_callback: bool = false;
        var ui_id: u32 = 0;

        fn dispatch(callback: ThreadCallback, ctx: ?*anyopaque) callconv(.c) void {
            dispatched += 1;
            dispatched_unlocked = dispatched_unlocked and lock_owner.load(.acquire) != threadId();
            if (destroy_before_callback) ebui_destroy(ui_id);
            callback(ctx);
        }
    };
    const id = ebui_create_headless();
    Host.ui_id = id;
    get(id).?.input_dispatch = Host.dispatch;
    const input = ebui_create_element(id, "input".ptr, 5);
    ebui_insert_before(id, ebui_body(id), input, 0);
    ebui_focus(id, input);
    ebui_text_input(id, "hello".ptr, 5);
    ebui_key(id, true, "Backspace".ptr, 9, 0);
    ebui_key(id, false, "Backspace".ptr, 9, 0);
    var len: usize = 0;
    const value = ebui_get_value(id, input, &len).?;
    try std.testing.expectEqualStrings("hell", value[0..len]);
    try std.testing.expectEqual(@as(usize, 3), Host.dispatched);
    try std.testing.expect(Host.dispatched_unlocked);
    // A queued call must not keep an Instance* alive across dispatch. Re-resolve
    // its integer ID when it reaches the host thread and safely ignore removal.
    Host.destroy_before_callback = true;
    ebui_text_input(id, "gone".ptr, 4);
    try std.testing.expect(get(id) == null);
}

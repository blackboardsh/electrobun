//! Input handling: hit testing, hover/active/focus state, DOM-style event
//! dispatch (target + bubbling), scrolling, keyboard focus navigation, form
//! control default actions and text editing for <input>/<textarea>.
const std = @import("std");
const dom = @import("dom.zig");
const geom = @import("geom.zig");
const style_mod = @import("style.zig");
const layout = @import("layout.zig");
const paint = @import("paint.zig");
const inline_mod = @import("inline.zig");
const TextOffset = inline_mod.TextOffset;

const Allocator = std.mem.Allocator;
const Document = dom.Document;
const NodeId = dom.NodeId;
const null_id = dom.null_id;

pub const EventType = enum(u6) {
    pointerdown,
    pointerup,
    pointermove,
    pointerenter,
    pointerleave,
    pointerover,
    pointerout,
    click,
    dblclick,
    contextmenu,
    wheel,
    scroll,
    keydown,
    keyup,
    input,
    change,
    focus,
    blur,
    focusin,
    focusout,
    submit,
    toggle,
    beforeinput,
    compositionstart,
    compositionupdate,
    compositionend,
    // synthetic, for bindings
    resize,

    pub fn bubbles(t: EventType) bool {
        return switch (t) {
            .pointerenter, .pointerleave, .focus, .blur, .scroll, .toggle, .resize => false,
            else => true,
        };
    }
    pub fn mask(t: EventType) u64 {
        return @as(u64, 1) << @intFromEnum(t);
    }
    pub fn fromName(name: []const u8) ?EventType {
        const n = if (std.mem.startsWith(u8, name, "on")) name[2..] else name;
        var buf: [32]u8 = undefined;
        if (n.len > buf.len) return null;
        const lower = std.ascii.lowerString(&buf, n);
        if (std.mem.eql(u8, lower, "mousedown")) return .pointerdown;
        if (std.mem.eql(u8, lower, "mouseup")) return .pointerup;
        if (std.mem.eql(u8, lower, "mousemove")) return .pointermove;
        if (std.mem.eql(u8, lower, "mouseenter")) return .pointerenter;
        if (std.mem.eql(u8, lower, "mouseleave")) return .pointerleave;
        if (std.mem.eql(u8, lower, "mouseover")) return .pointerover;
        if (std.mem.eql(u8, lower, "mouseout")) return .pointerout;
        return std.meta.stringToEnum(EventType, lower);
    }
};

pub const Modifiers = packed struct(u8) {
    shift: bool = false,
    ctrl: bool = false,
    alt: bool = false,
    meta: bool = false,
    _pad: u4 = 0,

    /// the platform's primary shortcut modifier (cmd on macOS, ctrl elsewhere)
    pub fn primary(m: Modifiers) bool {
        return if (@import("builtin").os.tag == .macos) m.meta else m.ctrl;
    }
};

pub const Event = struct {
    type: EventType,
    target: NodeId,
    current_target: NodeId = null_id,
    /// window coordinates (CSS px)
    x: f32 = 0,
    y: f32 = 0,
    button: u8 = 0,
    buttons: u8 = 0,
    detail: u32 = 0,
    mods: Modifiers = .{},
    delta_x: f32 = 0,
    delta_y: f32 = 0,
    /// W3C `key` value ("a", "Enter", "ArrowLeft", ...)
    key: []const u8 = "",
    /// input text (input/beforeinput/composition)
    data: []const u8 = "",
    related: NodeId = null_id,
    /// unique per dispatch (set by Interaction.dispatch)
    serial: u32 = 0,
    default_prevented: bool = false,
    propagation_stopped: bool = false,

    pub fn preventDefault(e: *Event) void {
        e.default_prevented = true;
    }
    pub fn stopPropagation(e: *Event) void {
        e.propagation_stopped = true;
    }
};

pub const Listener = struct {
    node: NodeId,
    type: EventType,
    func: *const fn (ctx: ?*anyopaque, ev: *Event) void,
    ctx: ?*anyopaque,
    id: u32,
};

/// Text editing state of one text control.
pub const EditState = struct {
    text: std.ArrayList(u8) = .empty,
    caret: u32 = 0,
    anchor: u32 = 0,
    scroll_x: f32 = 0,
    scroll_y: f32 = 0,
    /// IME composition range (marked text), if composing
    composing: ?[2]u32 = null,
    undo: std.ArrayList(Snapshot) = .empty,
    redo: std.ArrayList(Snapshot) = .empty,
    /// preferred x for vertical caret motion
    goal_x: ?f32 = null,
    /// value captured on focus (for `change`)
    focus_value: []u8 = &.{},

    const Snapshot = struct { text: []u8, caret: u32, anchor: u32 };

    fn deinit(e: *EditState, gpa: Allocator) void {
        e.text.deinit(gpa);
        for (e.undo.items) |s| gpa.free(s.text);
        for (e.redo.items) |s| gpa.free(s.text);
        e.undo.deinit(gpa);
        e.redo.deinit(gpa);
        gpa.free(e.focus_value);
    }

    pub fn selection(e: *const EditState) [2]u32 {
        return .{ @min(e.caret, e.anchor), @max(e.caret, e.anchor) };
    }
};

pub const Cursor = @import("css/properties.zig").Cursor;

pub const Host = struct {
    ctx: ?*anyopaque = null,
    set_cursor: ?*const fn (ctx: ?*anyopaque, c: Cursor) void = null,
    clipboard_read: ?*const fn (ctx: ?*anyopaque, gpa: Allocator) ?[]u8 = null,
    clipboard_write: ?*const fn (ctx: ?*anyopaque, text: []const u8) void = null,
    /// caret rectangle for IME candidate window placement (window coords)
    ime_rect: ?*const fn (ctx: ?*anyopaque, r: geom.Rect) void = null,
    /// Start a native window drag from the current press. Hosts whose drag
    /// is modal (macOS) return when the button is released, reporting
    /// whether the window moved; the press is then finished here: a press
    /// that didn't move the window still clicks.
    begin_window_drag: ?*const fn (ctx: ?*anyopaque) bool = null,
    request_frame: ?*const fn (ctx: ?*anyopaque) void = null,
};

pub const Interaction = struct {
    gpa: Allocator,
    doc: *Document,
    L: *layout.Layout,
    dl: *paint.DisplayList,
    host: Host = .{},
    listeners: std.ArrayList(Listener) = .empty,
    next_listener: u32 = 1,
    /// all events are also reported here (bindings that queue events)
    sink: ?*const fn (ctx: ?*anyopaque, ev: *const Event) void = null,
    sink_ctx: ?*anyopaque = null,
    edits: std.AutoHashMapUnmanaged(NodeId, *EditState) = .empty,

    pointer_x: f32 = -1,
    pointer_y: f32 = -1,
    buttons: u8 = 0,
    down_target: NodeId = null_id,
    last_click_time: f64 = 0,
    last_click_target: NodeId = null_id,
    click_count: u32 = 0,
    cursor: Cursor = .default,
    /// selecting text with the mouse in a text control
    drag_select: NodeId = null_id,
    keyboard_focus: bool = false,
    next_serial: u32 = 0,
    /// open <select> popup: the select, its listbox overlay and highlighted index
    popup_select: NodeId = null_id,
    popup: NodeId = null_id,
    popup_index: usize = 0,
    now: f64 = 0,
    /// time of the last caret movement (blink restarts)
    caret_time: f64 = 0,

    pub fn init(gpa: Allocator, doc: *Document, L: *layout.Layout, dl: *paint.DisplayList) Interaction {
        return .{ .gpa = gpa, .doc = doc, .L = L, .dl = dl };
    }

    pub fn deinit(ix: *Interaction) void {
        ix.listeners.deinit(ix.gpa);
        var it = ix.edits.valueIterator();
        while (it.next()) |e| {
            e.*.deinit(ix.gpa);
            ix.gpa.destroy(e.*);
        }
        ix.edits.deinit(ix.gpa);
    }

    // -----------------------------------------------------------------------
    // Listeners
    // -----------------------------------------------------------------------

    pub fn addListener(ix: *Interaction, node: NodeId, t: EventType, func: *const fn (?*anyopaque, *Event) void, ctx: ?*anyopaque) !u32 {
        const id = ix.next_listener;
        ix.next_listener += 1;
        try ix.listeners.append(ix.gpa, .{ .node = node, .type = t, .func = func, .ctx = ctx, .id = id });
        ix.doc.node(node).listeners |= t.mask();
        return id;
    }

    pub fn removeListener(ix: *Interaction, id: u32) void {
        for (ix.listeners.items, 0..) |l, i| {
            if (l.id == id) {
                _ = ix.listeners.swapRemove(i);
                return;
            }
        }
    }

    /// Remove all listeners of a node (when it is destroyed).
    pub fn removeNodeListeners(ix: *Interaction, node: NodeId) void {
        var i: usize = 0;
        while (i < ix.listeners.items.len) {
            if (ix.listeners.items[i].node == node) _ = ix.listeners.swapRemove(i) else i += 1;
        }
        if (ix.edits.fetchRemove(node)) |kv| {
            kv.value.deinit(ix.gpa);
            ix.gpa.destroy(kv.value);
        }
    }

    /// Dispatch to target and (if bubbling) its ancestors. Returns false if
    /// the default action was prevented.
    pub fn dispatch(ix: *Interaction, ev: *Event) bool {
        if (ev.target == null_id or ix.doc.get(ev.target) == null) return true;
        if (ev.serial == 0) {
            ix.next_serial +%= 1;
            if (ix.next_serial == 0) ix.next_serial = 1;
            ev.serial = ix.next_serial;
        }
        if (ix.sink) |s| s(ix.sink_ctx, ev);
        // the propagation path is fixed before any listener runs (DOM semantics):
        // listeners may mutate or destroy the tree
        var path_buf: [256]NodeId = undefined;
        var n_path: usize = 0;
        var cur = ev.target;
        while (cur != null_id and n_path < path_buf.len) {
            const n = ix.doc.get(cur) orelse break;
            if (n.kind == .document) break;
            path_buf[n_path] = cur;
            n_path += 1;
            if (!ev.type.bubbles()) break;
            cur = n.parent;
        }
        for (path_buf[0..n_path]) |id| {
            const n = ix.doc.get(id) orelse continue;
            if (n.listeners & ev.type.mask() != 0) {
                ev.current_target = id;
                var i: usize = 0;
                while (i < ix.listeners.items.len) : (i += 1) {
                    const l = ix.listeners.items[i];
                    if (l.node == id and l.type == ev.type) l.func(l.ctx, ev);
                }
            }
            if (ev.propagation_stopped) break;
        }
        return !ev.default_prevented;
    }

    fn fire(ix: *Interaction, t: EventType, target: NodeId) bool {
        var ev = Event{ .type = t, .target = target, .x = ix.pointer_x, .y = ix.pointer_y };
        return ix.dispatch(&ev);
    }

    // -----------------------------------------------------------------------
    // Pointer
    // -----------------------------------------------------------------------

    pub fn hitTest(ix: *Interaction, x: f32, y: f32) NodeId {
        const hit = ix.dl.hitTestLive(x, y, ix.doc);
        if (hit != null_id) return hit;
        return ix.bodyOrRoot();
    }

    fn bodyOrRoot(ix: *Interaction) NodeId {
        const root = ix.doc.documentElement();
        if (root == null_id) return null_id;
        var c = ix.doc.node(root).first_child;
        while (c != null_id) : (c = ix.doc.node(c).next) {
            if (ix.doc.node(c).kind == .element and ix.doc.node(c).tag == ix.doc.atoms.body) return c;
        }
        return root;
    }

    fn setChainState(ix: *Interaction, from: NodeId, comptime field: []const u8, on: bool, stop_at: NodeId) void {
        var cur = from;
        while (cur != null_id and cur != stop_at) : (cur = ix.doc.node(cur).parent) {
            const n = ix.doc.get(cur) orelse return;
            if (n.kind != .element) continue;
            var s = n.state;
            if (@field(s, field) == on) continue;
            @field(s, field) = on;
            ix.doc.setState(cur, s);
        }
    }

    fn commonAncestor(ix: *Interaction, a: NodeId, b: NodeId) NodeId {
        var x = a;
        while (x != null_id) : (x = ix.doc.node(x).parent) {
            if (ix.doc.isInclusiveAncestor(x, b)) return x;
        }
        return null_id;
    }

    pub fn pointerMove(ix: *Interaction, x: f32, y: f32, mods: Modifiers) void {
        ix.pointer_x = x;
        ix.pointer_y = y;
        const target = ix.hitTest(x, y);
        ix.updateHover(target);
        if (ix.popup != null_id and ix.doc.isInclusiveAncestor(ix.popup, target)) {
            if (ix.optionIndexOf(target)) |idx| ix.highlightPopup(idx);
        }
        // text selection drag
        if (ix.drag_select != null_id and ix.buttons & 1 != 0) {
            if (ix.edits.get(ix.drag_select)) |e| {
                if (ix.offsetAtPoint(ix.drag_select, x, y)) |off| {
                    if (off != e.caret) {
                        e.caret = off;
                        ix.touchCaret(ix.drag_select);
                    }
                }
            }
        }
        var ev = Event{ .type = .pointermove, .target = target, .x = x, .y = y, .buttons = ix.buttons, .mods = mods };
        _ = ix.dispatch(&ev);
        ix.updateCursor(target);
    }

    pub fn pointerLeaveWindow(ix: *Interaction) void {
        ix.updateHover(null_id);
        ix.pointer_x = -1;
        ix.pointer_y = -1;
    }

    fn updateHover(ix: *Interaction, target_in: NodeId) void {
        const target = if (target_in != null_id and ix.doc.get(target_in) == null) ix.bodyOrRoot() else target_in;
        const old = ix.doc.hovered;
        if (old == target) return;
        if (old != null_id and ix.doc.get(old) == null) ix.doc.hovered = null_id;
        const prev = ix.doc.hovered;
        const common = if (prev != null_id and target != null_id) ix.commonAncestor(prev, target) else null_id;
        if (prev != null_id) {
            var ev = Event{ .type = .pointerout, .target = prev, .related = target, .x = ix.pointer_x, .y = ix.pointer_y };
            _ = ix.dispatch(&ev);
            // pointerleave on each element left (deepest first)
            var cur = prev;
            while (cur != null_id and cur != common) : (cur = ix.doc.node(cur).parent) {
                var lv = Event{ .type = .pointerleave, .target = cur, .related = target, .x = ix.pointer_x, .y = ix.pointer_y };
                _ = ix.dispatch(&lv);
            }
            ix.setChainState(prev, "hover", false, common);
        }
        ix.doc.hovered = target;
        if (target != null_id) {
            ix.setChainState(target, "hover", true, null_id);
            var ev = Event{ .type = .pointerover, .target = target, .related = prev, .x = ix.pointer_x, .y = ix.pointer_y };
            _ = ix.dispatch(&ev);
            // pointerenter from the outermost entered element inward
            var chain: [128]NodeId = undefined;
            var n: usize = 0;
            var cur = target;
            while (cur != null_id and cur != common and n < chain.len) : (cur = ix.doc.node(cur).parent) {
                chain[n] = cur;
                n += 1;
            }
            while (n > 0) {
                n -= 1;
                var en = Event{ .type = .pointerenter, .target = chain[n], .related = prev, .x = ix.pointer_x, .y = ix.pointer_y };
                _ = ix.dispatch(&en);
            }
        }
    }

    fn updateCursor(ix: *Interaction, target: NodeId) void {
        var c: Cursor = .default;
        if (target != null_id) {
            const st = style_mod.of(ix.doc, target);
            c = st.cursor;
            if (c == .auto) {
                // auto: text cursor over selectable text controls, else default
                c = if (ix.edits.contains(target) or layout.isTextInput(ix.doc, target)) .text else .default;
            }
        }
        if (c != ix.cursor) {
            ix.cursor = c;
            if (ix.host.set_cursor) |f| f(ix.host.ctx, c);
        }
    }

    pub fn pointerDown(ix: *Interaction, x: f32, y: f32, button: u8, mods: Modifiers) void {
        ix.pointer_x = x;
        ix.pointer_y = y;
        ix.buttons |= @as(u8, 1) << @intCast(@min(button, 7));
        const target = ix.hitTest(x, y);
        if (ix.popup != null_id) {
            if (ix.doc.isInclusiveAncestor(ix.popup, target)) {
                if (ix.optionIndexOf(target)) |idx| ix.choosePopup(idx);
                ix.buttons = 0;
                return;
            }
            // outside click dismisses (and is consumed when on the select)
            const on_select = ix.doc.isInclusiveAncestor(ix.popup_select, target);
            ix.closePopup();
            if (on_select) {
                ix.buttons = 0;
                return;
            }
        }
        ix.updateHover(target);
        ix.down_target = target;
        var ev = Event{ .type = .pointerdown, .target = target, .x = x, .y = y, .button = button, .buttons = ix.buttons, .mods = mods };
        const proceed = ix.dispatch(&ev);
        if (target == null_id) return;
        ix.setChainState(target, "active", true, null_id);
        ix.doc.active = target;
        if (!proceed) return;
        if (button == 0) {
            // window drag regions
            if (ix.inDragRegion(x, y)) {
                if (ix.host.begin_window_drag) |f| {
                    // the drag consumed the release: finish the gesture
                    if (f(ix.host.ctx)) ix.cancelPress(button) else ix.pointerUp(x, y, button, mods);
                }
                return;
            }
            const focus_target = ix.focusableAncestor(target);
            ix.keyboard_focus = false;
            if (focus_target != null_id) ix.focus(focus_target, false) else ix.blur();
            // caret placement / selection start in text controls
            if (focus_target != null_id and layout.isTextInput(ix.doc, focus_target)) {
                if (ix.editState(focus_target)) |e| {
                    if (ix.offsetAtPoint(focus_target, x, y)) |off| {
                        e.caret = off;
                        if (!mods.shift) e.anchor = off;
                        e.goal_x = null;
                        ix.touchCaret(focus_target);
                    }
                    ix.drag_select = focus_target;
                } else |_| {}
            }
        }
        if (button == 2) {
            var cm = Event{ .type = .contextmenu, .target = target, .x = x, .y = y, .button = button, .mods = mods };
            _ = ix.dispatch(&cm);
        }
    }

    /// End a press without a release event or click (the gesture was taken
    /// over, e.g. by a window drag).
    fn cancelPress(ix: *Interaction, button: u8) void {
        ix.buttons &= ~(@as(u8, 1) << @intCast(@min(button, 7)));
        if (ix.doc.active != null_id and ix.doc.get(ix.doc.active) != null) ix.setChainState(ix.doc.active, "active", false, null_id);
        ix.doc.active = null_id;
        ix.down_target = null_id;
        ix.drag_select = null_id;
    }

    pub fn pointerUp(ix: *Interaction, x: f32, y: f32, button: u8, mods: Modifiers) void {
        ix.pointer_x = x;
        ix.pointer_y = y;
        ix.buttons &= ~(@as(u8, 1) << @intCast(@min(button, 7)));
        const target = ix.hitTest(x, y);
        var ev = Event{ .type = .pointerup, .target = target, .x = x, .y = y, .button = button, .buttons = ix.buttons, .mods = mods };
        _ = ix.dispatch(&ev);
        if (ix.doc.active != null_id and ix.doc.get(ix.doc.active) != null) ix.setChainState(ix.doc.active, "active", false, null_id);
        ix.doc.active = null_id;
        ix.drag_select = null_id;
        if (button != 0) return;
        const down = ix.down_target;
        ix.down_target = null_id;
        if (down == null_id or ix.doc.get(down) == null) return;
        // click goes to the nearest common ancestor of down and up targets
        const click_target = if (down == target) target else ix.commonAncestor(down, target);
        if (click_target == null_id) return;
        // multi-click detection
        if (click_target == ix.last_click_target and ix.now - ix.last_click_time < 0.5) {
            ix.click_count += 1;
        } else ix.click_count = 1;
        ix.last_click_time = ix.now;
        ix.last_click_target = click_target;
        if (ix.click_count >= 2) {
            if (ix.edits.get(click_target)) |e| {
                if (ix.click_count == 2) selectWord(e) else {
                    e.anchor = 0;
                    e.caret = @intCast(e.text.items.len);
                }
                ix.touchCaret(click_target);
            }
        }
        ix.click(click_target, x, y, mods, ix.click_count);
    }

    /// Synthesize a click (also used for keyboard activation).
    pub fn click(ix: *Interaction, target: NodeId, x: f32, y: f32, mods: Modifiers, count: u32) void {
        var ev = Event{ .type = .click, .target = target, .x = x, .y = y, .mods = mods, .detail = count };
        if (count == 2) {
            var dbl = Event{ .type = .dblclick, .target = target, .x = x, .y = y, .mods = mods, .detail = 2 };
            _ = ix.dispatch(&dbl);
        }
        if (!ix.dispatch(&ev)) return;
        // the click handler may have removed the target
        if (ix.doc.get(target) == null) return;
        ix.activationBehavior(target);
    }

    fn activationBehavior(ix: *Interaction, target: NodeId) void {
        const doc = ix.doc;
        const w = &doc.atoms;
        var cur = target;
        while (cur != null_id) : (cur = doc.node(cur).parent) {
            const n = doc.get(cur) orelse return;
            if (n.kind != .element) continue;
            if (n.tag == w.input) {
                if (n.hasAttr(w.disabled)) return;
                const t = n.getAttr(w.type) orelse "";
                if (std.ascii.eqlIgnoreCase(t, "checkbox")) {
                    var s = n.state;
                    s.checked = !s.checked;
                    s.indeterminate = false;
                    doc.setState(cur, s);
                    _ = ix.fire(.input, cur);
                    _ = ix.fire(.change, cur);
                } else if (std.ascii.eqlIgnoreCase(t, "radio")) {
                    if (!n.state.checked) {
                        ix.uncheckRadioGroup(cur);
                        var s = n.state;
                        s.checked = true;
                        doc.setState(cur, s);
                        _ = ix.fire(.input, cur);
                        _ = ix.fire(.change, cur);
                    }
                } else if (std.ascii.eqlIgnoreCase(t, "submit")) {
                    ix.submitForm(cur);
                }
                return;
            }
            if (n.tag == w.button) {
                if (n.hasAttr(w.disabled)) return;
                const t = n.getAttr(w.type) orelse "submit";
                if (std.ascii.eqlIgnoreCase(t, "submit")) ix.submitForm(cur);
                return;
            }
            if (n.tag == w.select) {
                if (n.hasAttr(w.disabled)) return;
                ix.openPopup(cur);
                return;
            }
            if (n.tag == w.summary) {
                const p = n.parent;
                if (p != null_id and doc.node(p).tag == w.details) {
                    if (doc.node(p).hasAttr(w.open)) {
                        doc.removeAttribute(p, "open") catch {};
                    } else doc.setAttribute(p, "open", "") catch {};
                    _ = ix.fire(.toggle, p);
                }
                return;
            }
            if (n.tag == w.label) {
                const ctl = ix.labelControl(cur);
                if (ctl != null_id and ctl != target and !doc.isInclusiveAncestor(ctl, target)) {
                    if (layout.isTextInput(doc, ctl)) ix.focus(ctl, false) else ix.click(ctl, ix.pointer_x, ix.pointer_y, .{}, 1);
                }
                return;
            }
            if (n.tag == w.a) return;
        }
    }

    fn labelControl(ix: *Interaction, label: NodeId) NodeId {
        const doc = ix.doc;
        if (doc.node(label).getAttr(doc.atoms.for_)) |id| return doc.elementById(id);
        var cur = doc.nextInTree(label, label);
        while (cur != null_id) : (cur = doc.nextInTree(cur, label)) {
            const n = doc.node(cur);
            if (n.kind == .element and (n.tag == doc.atoms.input or n.tag == doc.atoms.textarea or n.tag == doc.atoms.select or n.tag == doc.atoms.button)) return cur;
        }
        return null_id;
    }

    fn uncheckRadioGroup(ix: *Interaction, radio: NodeId) void {
        const doc = ix.doc;
        const name = doc.node(radio).getAttr(doc.atoms.name) orelse return;
        var cur = doc.root;
        while (cur != null_id) : (cur = doc.nextInTree(cur, doc.root)) {
            const n = doc.node(cur);
            if (cur == radio or n.kind != .element or n.tag != doc.atoms.input or !n.state.checked) continue;
            const t = n.getAttr(doc.atoms.type) orelse continue;
            if (!std.ascii.eqlIgnoreCase(t, "radio")) continue;
            const nn = n.getAttr(doc.atoms.name) orelse continue;
            if (!std.mem.eql(u8, nn, name)) continue;
            var s = n.state;
            s.checked = false;
            doc.setState(cur, s);
        }
    }

    fn submitForm(ix: *Interaction, from: NodeId) void {
        const doc = ix.doc;
        const form = doc.interner.lookup("form") orelse return;
        var cur = from;
        while (cur != null_id) : (cur = doc.node(cur).parent) {
            if (doc.node(cur).kind == .element and doc.node(cur).tag == form) {
                _ = ix.fire(.submit, cur);
                return;
            }
        }
    }

    fn inDragRegion(ix: *Interaction, x: f32, y: f32) bool {
        const p = geom.Point{ .x = x, .y = y };
        for (ix.dl.no_drag_regions.items) |r| if (r.contains(p)) return false;
        for (ix.dl.drag_regions.items) |r| if (r.contains(p)) {
            // interactive descendants are excluded
            const t = ix.dl.hitTest(x, y);
            if (t != null_id and ix.focusableAncestor(t) != null_id) return false;
            return true;
        };
        return false;
    }

    pub fn wheel(ix: *Interaction, x: f32, y: f32, dx: f32, dy: f32, mods: Modifiers) void {
        const target = ix.hitTest(x, y);
        var ev = Event{ .type = .wheel, .target = target, .x = x, .y = y, .delta_x = dx, .delta_y = dy, .mods = mods };
        if (!ix.dispatch(&ev)) return;
        // shift+wheel scrolls horizontally
        var sx = dx;
        var sy = dy;
        if (mods.shift and sx == 0) {
            sx = sy;
            sy = 0;
        }
        _ = ix.scrollBy(target, sx, sy);
    }

    /// Scroll the nearest scrollable ancestor(s) of `from`. Returns true if anything moved.
    pub fn scrollBy(ix: *Interaction, from: NodeId, dx0: f32, dy0: f32) bool {
        var dx = dx0;
        var dy = dy0;
        var cur = from;
        var moved = false;
        while (cur != null_id and (dx != 0 or dy != 0)) : (cur = ix.doc.node(cur).parent) {
            const n = ix.doc.node(cur);
            if (n.kind != .element) continue;
            const st = style_mod.of(ix.doc, cur);
            const box = layout.boxOfNode(n) orelse continue;
            const is_root = cur == ix.doc.documentElement();
            const scroll_x = st.overflow_x == .scroll or st.overflow_x == .auto or (is_root and st.overflow_x == .visible);
            const scroll_y = st.overflow_y == .scroll or st.overflow_y == .auto or (is_root and st.overflow_y == .visible);
            const vw = if (is_root) ix.L.viewport_w else box.w - box.border.horizontal();
            const vh = if (is_root) ix.L.viewport_h else box.h - box.border.vertical();
            const cw = if (is_root) @max(box.w + box.margin.left + box.margin.right, box.scroll_w) else box.scroll_w;
            const ch = if (is_root) @max(box.h + box.margin.top + box.margin.bottom, box.scroll_h) else box.scroll_h;
            const max_x = @max(0, cw - vw);
            const max_y = @max(0, ch - vh);
            var did = false;
            if (scroll_x and dx != 0 and max_x > 0) {
                const nx = std.math.clamp(n.scroll_x + dx, 0, max_x);
                if (nx != n.scroll_x) {
                    dx -= nx - n.scroll_x;
                    n.scroll_x = nx;
                    did = true;
                }
            }
            if (scroll_y and dy != 0 and max_y > 0) {
                const ny = std.math.clamp(n.scroll_y + dy, 0, max_y);
                if (ny != n.scroll_y) {
                    dy -= ny - n.scroll_y;
                    n.scroll_y = ny;
                    did = true;
                }
            }
            if (did) {
                moved = true;
                ix.doc.needs_paint = true;
                _ = ix.fire(.scroll, cur);
                // scroll chaining stops at the first container that consumed it
                break;
            }
        }
        if (moved) ix.requestFrame();
        return moved;
    }

    // -----------------------------------------------------------------------
    // Focus
    // -----------------------------------------------------------------------

    pub fn isFocusable(ix: *Interaction, id: NodeId) bool {
        const doc = ix.doc;
        const n = doc.node(id);
        if (n.kind != .element) return false;
        const w = &doc.atoms;
        if (n.hasAttr(w.disabled)) return false;
        const st = style_mod.of(doc, id);
        if (st.display == .none or st.visibility != .visible) return false;
        if (n.getAttr(w.tabindex)) |ti| {
            const v = std.fmt.parseInt(i32, std.mem.trim(u8, ti, " "), 10) catch 0;
            return v >= -1;
        }
        if (n.tag == w.input) {
            const t = n.getAttr(w.type) orelse "";
            return !std.ascii.eqlIgnoreCase(t, "hidden");
        }
        if (n.tag == w.button or n.tag == w.select or n.tag == w.textarea or n.tag == w.summary) return true;
        if (n.tag == w.a and n.hasAttr(w.href)) return true;
        if (n.hasAttr(w.contenteditable)) return true;
        return false;
    }

    fn tabIndex(ix: *Interaction, id: NodeId) i32 {
        const n = ix.doc.node(id);
        if (n.getAttr(ix.doc.atoms.tabindex)) |ti| return std.fmt.parseInt(i32, std.mem.trim(u8, ti, " "), 10) catch 0;
        return 0;
    }

    fn focusableAncestor(ix: *Interaction, from: NodeId) NodeId {
        var cur = from;
        while (cur != null_id) : (cur = ix.doc.node(cur).parent) {
            if (ix.doc.node(cur).kind == .document) break;
            if (ix.isFocusable(cur)) return cur;
        }
        return null_id;
    }

    pub fn focus(ix: *Interaction, id: NodeId, keyboard: bool) void {
        const doc = ix.doc;
        if (doc.focused == id) return;
        ix.blur();
        doc.focused = id;
        var s = doc.node(id).state;
        s.focus = true;
        // focus rings: keyboard focus, and always for text entry (like browsers)
        s.focus_visible = keyboard or layout.isTextInput(doc, id);
        doc.setState(id, s);
        // focus-within on ancestors
        var p = doc.node(id).parent;
        while (p != null_id and doc.node(p).kind == .element) : (p = doc.node(p).parent) {
            var ps = doc.node(p).state;
            ps.focus_within = true;
            doc.setState(p, ps);
        }
        if (layout.isTextInput(doc, id)) {
            if (ix.editState(id)) |e| {
                ix.gpa.free(e.focus_value);
                e.focus_value = ix.gpa.dupe(u8, e.text.items) catch &.{};
                if (keyboard) {
                    e.anchor = 0;
                    e.caret = @intCast(e.text.items.len);
                }
                ix.touchCaret(id);
            } else |_| {}
        }
        _ = ix.fire(.focus, id);
        _ = ix.fire(.focusin, id);
    }

    pub fn blur(ix: *Interaction) void {
        const doc = ix.doc;
        const old = doc.focused;
        if (old == null_id or doc.get(old) == null) {
            doc.focused = null_id;
            return;
        }
        doc.focused = null_id;
        var s = doc.node(old).state;
        s.focus = false;
        s.focus_visible = false;
        doc.setState(old, s);
        var p = doc.node(old).parent;
        while (p != null_id and doc.node(p).kind == .element) : (p = doc.node(p).parent) {
            var ps = doc.node(p).state;
            ps.focus_within = false;
            doc.setState(p, ps);
        }
        if (ix.edits.get(old)) |e| {
            if (!std.mem.eql(u8, e.focus_value, e.text.items)) _ = ix.fire(.change, old);
            e.anchor = e.caret;
            e.composing = null;
        }
        _ = ix.fire(.blur, old);
        _ = ix.fire(.focusout, old);
    }

    /// Move focus to the next/previous focusable element in tab order.
    pub fn focusNext(ix: *Interaction, backwards: bool) void {
        const doc = ix.doc;
        var list: std.ArrayList(struct { id: NodeId, ti: i32, order: usize }) = .empty;
        defer list.deinit(ix.gpa);
        var cur = doc.root;
        var order: usize = 0;
        while (cur != null_id) : (cur = doc.nextInTree(cur, doc.root)) {
            order += 1;
            if (doc.node(cur).kind != .element) continue;
            if (!ix.isFocusable(cur)) continue;
            // skip descendants of display:none ancestors (style of() already covers self)
            if (!ix.isRendered(cur)) continue;
            const ti = ix.tabIndex(cur);
            if (ti < 0) continue;
            list.append(ix.gpa, .{ .id = cur, .ti = ti, .order = order }) catch return;
        }
        if (list.items.len == 0) return;
        std.mem.sort(@TypeOf(list.items[0]), list.items, {}, struct {
            fn lt(_: void, a: @TypeOf(list.items[0]), b: @TypeOf(list.items[0])) bool {
                const ka: i64 = if (a.ti == 0) std.math.maxInt(i32) else a.ti;
                const kb: i64 = if (b.ti == 0) std.math.maxInt(i32) else b.ti;
                if (ka != kb) return ka < kb;
                return a.order < b.order;
            }
        }.lt);
        var idx: usize = 0;
        var found = false;
        for (list.items, 0..) |e, i| if (e.id == doc.focused) {
            idx = i;
            found = true;
        };
        const n = list.items.len;
        const next = if (!found) (if (backwards) n - 1 else 0) else if (backwards) (idx + n - 1) % n else (idx + 1) % n;
        ix.keyboard_focus = true;
        ix.focus(list.items[next].id, true);
        ix.scrollIntoView(list.items[next].id);
    }

    fn isRendered(ix: *Interaction, id: NodeId) bool {
        var cur = id;
        while (cur != null_id and ix.doc.node(cur).kind == .element) : (cur = ix.doc.node(cur).parent) {
            if (style_mod.of(ix.doc, cur).display == .none) return false;
        }
        const b = layout.boxOfNode(ix.doc.node(id)) orelse return false;
        return b.placed;
    }

    /// Adjust scroll positions of ancestors so that `id` is visible.
    pub fn scrollIntoView(ix: *Interaction, id: NodeId) void {
        const doc = ix.doc;
        const b = layout.boxOfNode(doc.node(id)) orelse return;
        var x: f32 = 0;
        var y: f32 = 0;
        var cur = id;
        // accumulate offsets up to each scroll container
        while (cur != null_id and doc.node(cur).kind == .element) {
            const cb = layout.boxOfNode(doc.node(cur)) orelse break;
            x += cb.x;
            y += cb.y;
            const parent = doc.node(cur).parent;
            if (parent == null_id or doc.node(parent).kind != .element) break;
            const pst = style_mod.of(doc, parent);
            const pb = layout.boxOfNode(doc.node(parent)) orelse break;
            if (pst.clipsContent()) {
                const pn = doc.node(parent);
                const view_h = pb.h - pb.border.vertical();
                const view_w = pb.w - pb.border.horizontal();
                const top = y - pb.border.top;
                const left = x - pb.border.left;
                if (top < pn.scroll_y) pn.scroll_y = @max(0, top) else if (top + b.h > pn.scroll_y + view_h) pn.scroll_y = @min(@max(0, pb.scroll_h - view_h), top + b.h - view_h);
                if (left < pn.scroll_x) pn.scroll_x = @max(0, left) else if (left + b.w > pn.scroll_x + view_w) pn.scroll_x = @min(@max(0, pb.scroll_w - view_w), left + b.w - view_w);
                doc.needs_paint = true;
                // continue outward with the visible position
                x -= pn.scroll_x;
                y -= pn.scroll_y;
            }
            cur = parent;
        }
    }

    // -----------------------------------------------------------------------
    // Keyboard and text editing
    // -----------------------------------------------------------------------

    pub fn keyDown(ix: *Interaction, key: []const u8, mods: Modifiers) void {
        const doc = ix.doc;
        const target = if (doc.focused != null_id and doc.get(doc.focused) != null) doc.focused else ix.bodyOrRoot();
        if (ix.popup != null_id) {
            const n_opts = ix.doc.node(ix.popup).child_count;
            if (std.mem.eql(u8, key, "ArrowDown")) {
                ix.highlightPopup(@min(ix.popup_index + 1, n_opts -| 1));
            } else if (std.mem.eql(u8, key, "ArrowUp")) {
                ix.highlightPopup(ix.popup_index -| 1);
            } else if (std.mem.eql(u8, key, "Enter") or std.mem.eql(u8, key, " ")) {
                ix.choosePopup(ix.popup_index);
            } else if (std.mem.eql(u8, key, "Escape") or std.mem.eql(u8, key, "Tab")) {
                ix.closePopup();
            }
            return;
        }
        var ev = Event{ .type = .keydown, .target = target, .key = key, .mods = mods };
        if (!ix.dispatch(&ev)) return;
        if (doc.focused != null_id and doc.node(doc.focused).tag == doc.atoms.select) {
            if (std.mem.eql(u8, key, " ") or std.mem.eql(u8, key, "Enter") or std.mem.eql(u8, key, "ArrowDown") or std.mem.eql(u8, key, "ArrowUp")) {
                ix.openPopup(doc.focused);
                return;
            }
        }
        if (std.mem.eql(u8, key, "Tab") and !mods.primary()) {
            if (!(doc.focused != null_id and doc.node(doc.focused).tag == doc.atoms.textarea and false)) {
                ix.focusNext(mods.shift);
                return;
            }
        }
        if (doc.focused != null_id and ix.edits.contains(doc.focused) or (doc.focused != null_id and layout.isTextInput(doc, doc.focused))) {
            ix.editKey(doc.focused, key, mods);
            return;
        }
        if (doc.focused != null_id) {
            const n = doc.node(doc.focused);
            const is_space = std.mem.eql(u8, key, " ");
            const is_enter = std.mem.eql(u8, key, "Enter");
            if ((is_space or is_enter) and (n.tag == doc.atoms.button or n.tag == doc.atoms.summary or (n.tag == doc.atoms.input and !layout.isTextInput(doc, doc.focused)))) {
                if (is_enter and n.tag == doc.atoms.input) return;
                ix.click(doc.focused, 0, 0, mods, 1);
                return;
            }
            if (is_enter and n.tag == doc.atoms.a) {
                ix.click(doc.focused, 0, 0, mods, 1);
                return;
            }
        }
        // keyboard scrolling
        const scroll_target = if (doc.hovered != null_id) doc.hovered else target;
        const page = ix.L.viewport_h * 0.85;
        if (std.mem.eql(u8, key, "ArrowDown")) _ = ix.scrollBy(scroll_target, 0, 40) else if (std.mem.eql(u8, key, "ArrowUp")) _ = ix.scrollBy(scroll_target, 0, -40) else if (std.mem.eql(u8, key, "PageDown") or (std.mem.eql(u8, key, " ") and !mods.shift)) _ = ix.scrollBy(scroll_target, 0, page) else if (std.mem.eql(u8, key, "PageUp") or (std.mem.eql(u8, key, " ") and mods.shift)) _ = ix.scrollBy(scroll_target, 0, -page) else if (std.mem.eql(u8, key, "Home")) _ = ix.scrollBy(scroll_target, 0, -1e9) else if (std.mem.eql(u8, key, "End")) _ = ix.scrollBy(scroll_target, 0, 1e9);
    }

    pub fn keyUp(ix: *Interaction, key: []const u8, mods: Modifiers) void {
        const doc = ix.doc;
        const target = if (doc.focused != null_id and doc.get(doc.focused) != null) doc.focused else ix.bodyOrRoot();
        var ev = Event{ .type = .keyup, .target = target, .key = key, .mods = mods };
        _ = ix.dispatch(&ev);
    }

    /// Committed text input (after IME composition or plain typing).
    pub fn textInput(ix: *Interaction, text: []const u8) void {
        const doc = ix.doc;
        const id = doc.focused;
        if (id == null_id or !layout.isTextInput(doc, id)) return;
        const e = ix.editState(id) catch return;
        if (doc.node(id).hasAttr(doc.atoms.readonly)) return;
        var filtered: std.ArrayList(u8) = .empty;
        defer filtered.deinit(ix.gpa);
        const multiline = doc.node(id).tag == doc.atoms.textarea;
        for (text) |c| {
            if (c == '\r') continue;
            if (c == '\n' and !multiline) continue;
            if (c < 0x20 and c != '\n' and c != '\t') continue;
            filtered.append(ix.gpa, c) catch return;
        }
        if (filtered.items.len == 0 and e.composing == null) return;
        var bi = Event{ .type = .beforeinput, .target = id, .data = filtered.items };
        if (!ix.dispatch(&bi)) return;
        if (e.composing) |cr| {
            e.caret = cr[1];
            e.anchor = cr[0];
            e.composing = null;
            ix.replaceSelection(id, e, filtered.items, false);
            var ce = Event{ .type = .compositionend, .target = id, .data = filtered.items };
            _ = ix.dispatch(&ce);
        } else ix.replaceSelection(id, e, filtered.items, true);
    }

    /// IME marked (composing) text; `sel` is the selection within it.
    pub fn setComposition(ix: *Interaction, text: []const u8, sel: u32) void {
        const doc = ix.doc;
        const id = doc.focused;
        if (id == null_id or !layout.isTextInput(doc, id)) return;
        const e = ix.editState(id) catch return;
        const starting = e.composing == null;
        if (e.composing) |cr| {
            e.anchor = cr[0];
            e.caret = cr[1];
        }
        const start = e.selection()[0];
        ix.replaceSelection(id, e, text, false);
        if (text.len == 0) {
            e.composing = null;
        } else {
            e.composing = .{ start, start + @as(u32, @intCast(text.len)) };
            e.caret = start + @min(sel, @as(u32, @intCast(text.len)));
            e.anchor = e.caret;
        }
        var ev = Event{ .type = if (starting) .compositionstart else .compositionupdate, .target = id, .data = text };
        _ = ix.dispatch(&ev);
        ix.reportImeRect(id);
    }

    pub fn editState(ix: *Interaction, id: NodeId) !*EditState {
        if (ix.edits.get(id)) |e| return e;
        const e = try ix.gpa.create(EditState);
        e.* = .{};
        errdefer ix.gpa.destroy(e);
        // initial value: value attribute, or textarea content
        try e.text.appendSlice(ix.gpa, ix.L.controlText(id));
        if (ix.doc.node(id).getAttr(ix.doc.atoms.type)) |t| if (std.ascii.eqlIgnoreCase(t, "password")) {
            e.text.clearRetainingCapacity();
            try e.text.appendSlice(ix.gpa, ix.doc.node(id).getAttr(ix.doc.atoms.value) orelse "");
        };
        e.caret = @intCast(e.text.items.len);
        e.anchor = e.caret;
        try ix.edits.put(ix.gpa, id, e);
        return e;
    }

    /// Current value of a text control.
    pub fn value(ix: *Interaction, id: NodeId) []const u8 {
        if (ix.edits.get(id)) |e| return e.text.items;
        const doc = ix.doc;
        if (doc.node(id).tag == doc.atoms.select) {
            const opt = ix.selectedOption(id) orelse return "";
            if (doc.node(opt).getAttr(doc.atoms.value)) |v| return v;
        }
        return ix.L.controlText(id);
    }

    // -----------------------------------------------------------------------
    // <select> popup
    // -----------------------------------------------------------------------

    fn options(ix: *Interaction, sel: NodeId, out: *std.ArrayList(NodeId)) void {
        const doc = ix.doc;
        var cur = doc.nextInTree(sel, sel);
        while (cur != null_id) : (cur = doc.nextInTree(cur, sel)) {
            const n = doc.node(cur);
            if (n.kind == .element and n.tag == doc.atoms.option) out.append(ix.gpa, cur) catch return;
        }
    }

    fn selectedOption(ix: *Interaction, sel: NodeId) ?NodeId {
        var list: std.ArrayList(NodeId) = .empty;
        defer list.deinit(ix.gpa);
        ix.options(sel, &list);
        for (list.items) |o| if (ix.doc.node(o).hasAttr(ix.doc.atoms.selected)) return o;
        return if (list.items.len > 0) list.items[0] else null;
    }

    pub fn openPopup(ix: *Interaction, sel: NodeId) void {
        if (ix.popup != null_id) ix.closePopup();
        const doc = ix.doc;
        var list: std.ArrayList(NodeId) = .empty;
        defer list.deinit(ix.gpa);
        ix.options(sel, &list);
        if (list.items.len == 0) return;
        const origin = ix.contentOrigin(sel) orelse return;
        const b = layout.boxOfNode(doc.node(sel)) orelse return;
        const bx = origin[0] - b.border.left - b.padding.left;
        const by = origin[1] - b.border.top - b.padding.top;
        const pop = doc.createElement("ebui-listbox") catch return;
        var style_buf: [160]u8 = undefined;
        const below = by + b.h + 4;
        const style = std.fmt.bufPrint(&style_buf, "left: {d}px; top: {d}px; min-width: {d}px", .{ bx, below, b.w }) catch "";
        doc.setAttribute(pop, "style", style) catch {};
        doc.setAttribute(pop, "role", "listbox") catch {};
        var sel_index: usize = 0;
        const current = ix.selectedOption(sel);
        for (list.items, 0..) |o, i| {
            const item = doc.createElement("ebui-option") catch return;
            var text: std.ArrayList(u8) = .empty;
            defer text.deinit(ix.gpa);
            doc.textContent(o, &text) catch {};
            const t = doc.createText(std.mem.trim(u8, text.items, " \t\r\n")) catch return;
            doc.appendChild(item, t);
            if (doc.node(o).hasAttr(doc.atoms.disabled)) doc.setAttribute(item, "aria-disabled", "true") catch {};
            if (current != null and current.? == o) {
                sel_index = i;
                doc.setAttribute(item, "aria-selected", "true") catch {};
            }
            doc.appendChild(pop, item);
        }
        doc.appendChild(ix.bodyOrRoot(), pop);
        ix.popup = pop;
        ix.popup_select = sel;
        var s = doc.node(sel).state;
        s.open = true;
        doc.setState(sel, s);
        ix.highlightPopup(sel_index);
        ix.requestFrame();
    }

    fn optionIndexOf(ix: *Interaction, target: NodeId) ?usize {
        const doc = ix.doc;
        var cur = target;
        while (cur != null_id and doc.node(cur).parent != ix.popup) : (cur = doc.node(cur).parent) {}
        if (cur == null_id) return null;
        var i: usize = 0;
        var c = doc.node(ix.popup).first_child;
        while (c != null_id) : (c = doc.node(c).next) {
            if (c == cur) return i;
            i += 1;
        }
        return null;
    }

    fn highlightPopup(ix: *Interaction, index: usize) void {
        const doc = ix.doc;
        var i: usize = 0;
        var c = doc.node(ix.popup).first_child;
        while (c != null_id) : (c = doc.node(c).next) {
            if (i == index) {
                doc.setAttribute(c, "class", "highlighted") catch {};
                ix.scrollIntoView(c);
            } else doc.removeAttribute(c, "class") catch {};
            i += 1;
        }
        ix.popup_index = index;
        ix.requestFrame();
    }

    fn choosePopup(ix: *Interaction, index: usize) void {
        const doc = ix.doc;
        const sel = ix.popup_select;
        var list: std.ArrayList(NodeId) = .empty;
        defer list.deinit(ix.gpa);
        ix.options(sel, &list);
        ix.closePopup();
        if (index >= list.items.len) return;
        const chosen = list.items[index];
        if (doc.node(chosen).hasAttr(doc.atoms.disabled)) return;
        const before = ix.selectedOption(sel);
        for (list.items) |o| {
            if (o == chosen) doc.setAttribute(o, "selected", "") catch {} else doc.removeAttribute(o, "selected") catch {};
        }
        doc.markLayoutDirty(sel);
        doc.node(sel).flags.text_dirty = true;
        if (before == null or before.? != chosen) {
            _ = ix.fire(.input, sel);
            _ = ix.fire(.change, sel);
        }
    }

    pub fn closePopup(ix: *Interaction) void {
        if (ix.popup == null_id) return;
        const doc = ix.doc;
        if (doc.get(ix.popup) != null) doc.destroy(ix.popup);
        if (doc.get(ix.popup_select) != null) {
            var s = doc.node(ix.popup_select).state;
            s.open = false;
            doc.setState(ix.popup_select, s);
        }
        ix.popup = null_id;
        ix.popup_select = null_id;
        ix.requestFrame();
    }

    pub fn setValue(ix: *Interaction, id: NodeId, v: []const u8) !void {
        const e = try ix.editState(id);
        if (std.mem.eql(u8, e.text.items, v)) return;
        e.text.clearRetainingCapacity();
        try e.text.appendSlice(ix.gpa, v);
        e.caret = @intCast(e.text.items.len);
        e.anchor = e.caret;
        e.composing = null;
        ix.textChanged(id);
    }

    fn textChanged(ix: *Interaction, id: NodeId) void {
        ix.doc.markLayoutDirty(id);
        ix.doc.node(id).flags.text_dirty = true;
        // :placeholder-shown depends on emptiness
        ix.doc.markStyleDirty(id);
        ix.touchCaret(id);
    }

    fn touchCaret(ix: *Interaction, id: NodeId) void {
        ix.caret_time = ix.now;
        ix.doc.needs_paint = true;
        ix.ensureCaretVisible(id);
        ix.reportImeRect(id);
        ix.requestFrame();
    }

    fn requestFrame(ix: *Interaction) void {
        if (ix.host.request_frame) |f| f(ix.host.ctx);
    }

    fn pushUndo(ix: *Interaction, e: *EditState) void {
        const snap = EditState.Snapshot{ .text = ix.gpa.dupe(u8, e.text.items) catch return, .caret = e.caret, .anchor = e.anchor };
        e.undo.append(ix.gpa, snap) catch {
            ix.gpa.free(snap.text);
            return;
        };
        if (e.undo.items.len > 200) {
            ix.gpa.free(e.undo.items[0].text);
            _ = e.undo.orderedRemove(0);
        }
        for (e.redo.items) |s| ix.gpa.free(s.text);
        e.redo.clearRetainingCapacity();
    }

    fn restore(ix: *Interaction, id: NodeId, e: *EditState, from: *std.ArrayList(EditState.Snapshot), to: *std.ArrayList(EditState.Snapshot)) void {
        const snap = from.pop() orelse return;
        const cur = EditState.Snapshot{ .text = ix.gpa.dupe(u8, e.text.items) catch return, .caret = e.caret, .anchor = e.anchor };
        to.append(ix.gpa, cur) catch ix.gpa.free(cur.text);
        e.text.clearRetainingCapacity();
        e.text.appendSlice(ix.gpa, snap.text) catch {};
        e.caret = snap.caret;
        e.anchor = snap.anchor;
        ix.gpa.free(snap.text);
        ix.textChanged(id);
        _ = ix.fire(.input, id);
    }

    fn replaceSelection(ix: *Interaction, id: NodeId, e: *EditState, text: []const u8, undoable: bool) void {
        const len: u32 = @intCast(e.text.items.len);
        const raw = e.selection();
        const sel = [2]u32{ @min(raw[0], len), @min(raw[1], len) };
        if (sel[0] == sel[1] and text.len == 0) return;
        // maxlength
        var insert = text;
        if (ix.doc.node(id).getAttr(ix.doc.atoms.maxlength)) |ml| {
            const max = std.fmt.parseInt(usize, std.mem.trim(u8, ml, " "), 10) catch std.math.maxInt(usize);
            const remaining = max -| (e.text.items.len - (sel[1] - sel[0]));
            if (insert.len > remaining) insert = insert[0..utf8Floor(insert, remaining)];
        }
        if (undoable) ix.pushUndo(e);
        e.text.replaceRange(ix.gpa, sel[0], sel[1] - sel[0], insert) catch return;
        e.caret = sel[0] + @as(u32, @intCast(insert.len));
        e.anchor = e.caret;
        e.goal_x = null;
        ix.textChanged(id);
        var ev = Event{ .type = .input, .target = id, .data = insert };
        _ = ix.dispatch(&ev);
    }

    fn editKey(ix: *Interaction, id: NodeId, key: []const u8, mods: Modifiers) void {
        const e = ix.editState(id) catch return;
        const doc = ix.doc;
        const multiline = doc.node(id).tag == doc.atoms.textarea;
        const readonly = doc.node(id).hasAttr(doc.atoms.readonly);
        const text = e.text.items;
        const word = if (@import("builtin").os.tag == .macos) mods.alt else mods.ctrl;
        const line_mod = @import("builtin").os.tag == .macos and mods.meta;
        if (mods.primary() and !mods.alt) {
            if (eqKey(key, "a")) {
                e.anchor = 0;
                e.caret = @intCast(text.len);
                ix.touchCaret(id);
                return;
            }
            if (eqKey(key, "c") or eqKey(key, "x")) {
                const sel = e.selection();
                if (sel[0] != sel[1]) {
                    if (ix.host.clipboard_write) |f| f(ix.host.ctx, text[sel[0]..sel[1]]);
                    if (eqKey(key, "x") and !readonly) ix.replaceSelection(id, e, "", true);
                }
                return;
            }
            if (eqKey(key, "v")) {
                if (readonly) return;
                if (ix.host.clipboard_read) |f| if (f(ix.host.ctx, ix.gpa)) |clip| {
                    defer ix.gpa.free(clip);
                    ix.textInput(clip);
                };
                return;
            }
            if (eqKey(key, "z")) {
                if (mods.shift) ix.restore(id, e, &e.redo, &e.undo) else ix.restore(id, e, &e.undo, &e.redo);
                return;
            }
            if (eqKey(key, "y")) {
                ix.restore(id, e, &e.redo, &e.undo);
                return;
            }
        }
        var new_caret: ?u32 = null;
        if (std.mem.eql(u8, key, "ArrowLeft")) {
            const sel = e.selection();
            if (sel[0] != sel[1] and !mods.shift) new_caret = sel[0] else if (line_mod) new_caret = lineStart(text, e.caret) else if (word) new_caret = prevWord(text, e.caret) else new_caret = prevChar(text, e.caret);
        } else if (std.mem.eql(u8, key, "ArrowRight")) {
            const sel = e.selection();
            if (sel[0] != sel[1] and !mods.shift) new_caret = sel[1] else if (line_mod) new_caret = lineEnd(text, e.caret) else if (word) new_caret = nextWord(text, e.caret) else new_caret = nextChar(text, e.caret);
        } else if (std.mem.eql(u8, key, "Home")) {
            new_caret = if (multiline and !mods.primary()) lineStart(text, e.caret) else 0;
        } else if (std.mem.eql(u8, key, "End")) {
            new_caret = if (multiline and !mods.primary()) lineEnd(text, e.caret) else @intCast(text.len);
        } else if (std.mem.eql(u8, key, "ArrowUp") or std.mem.eql(u8, key, "ArrowDown")) {
            const down = std.mem.eql(u8, key, "ArrowDown");
            if (!multiline or line_mod) {
                new_caret = if (down) @intCast(text.len) else 0;
            } else {
                new_caret = ix.verticalMove(id, e, down);
            }
        } else if (std.mem.eql(u8, key, "Backspace")) {
            if (readonly) return;
            const sel = e.selection();
            if (sel[0] == sel[1]) {
                e.anchor = if (line_mod) lineStart(text, e.caret) else if (word) prevWord(text, e.caret) else prevChar(text, e.caret);
            }
            ix.replaceSelection(id, e, "", true);
            return;
        } else if (std.mem.eql(u8, key, "Delete")) {
            if (readonly) return;
            const sel = e.selection();
            if (sel[0] == sel[1]) e.anchor = if (word) nextWord(text, e.caret) else nextChar(text, e.caret);
            ix.replaceSelection(id, e, "", true);
            return;
        } else if (std.mem.eql(u8, key, "Enter")) {
            if (multiline) {
                if (!readonly) ix.replaceSelection(id, e, "\n", true);
            } else {
                if (!std.mem.eql(u8, e.focus_value, e.text.items)) {
                    _ = ix.fire(.change, id);
                    ix.gpa.free(e.focus_value);
                    e.focus_value = ix.gpa.dupe(u8, e.text.items) catch &.{};
                }
                ix.submitForm(id);
            }
            return;
        } else if (std.mem.eql(u8, key, "Escape")) {
            e.anchor = e.caret;
            ix.touchCaret(id);
            return;
        }
        if (new_caret) |c| {
            if (!std.mem.eql(u8, key, "ArrowUp") and !std.mem.eql(u8, key, "ArrowDown")) e.goal_x = null;
            e.caret = c;
            if (!mods.shift) e.anchor = c;
            ix.touchCaret(id);
        }
    }

    // -----------------------------------------------------------------------
    // Value <-> layout offsets. A control's laid-out text differs from its
    // value (password bullets, placeholder when empty); these are the only
    // conversions between the two spaces.
    // -----------------------------------------------------------------------

    pub fn layoutOffset(ix: *const Interaction, id: NodeId, e: *const EditState, value_off: u32) TextOffset {
        const v = e.text.items;
        const off = @min(value_off, v.len);
        if (v.len == 0) return .of(0); // placeholder (or nothing) is shown
        if (layout.isPassword(ix.doc, id)) {
            const n = std.unicode.utf8CountCodepoints(v[0..off]) catch off;
            return .of(@intCast(n * inline_mod.password_bullet.len));
        }
        return .of(@intCast(off));
    }

    pub fn valueOffset(ix: *const Interaction, id: NodeId, e: *const EditState, at: TextOffset) u32 {
        const v = e.text.items;
        if (v.len == 0) return 0;
        if (layout.isPassword(ix.doc, id)) {
            var remaining = at.int() / inline_mod.password_bullet.len;
            var i: usize = 0;
            while (i < v.len and remaining > 0) : (remaining -= 1) {
                i += std.unicode.utf8ByteSequenceLength(v[i]) catch 1;
            }
            return @intCast(@min(i, v.len));
        }
        return @intCast(utf8Floor(v, @min(at.int(), v.len)));
    }

    fn caretRect(ix: *const Interaction, id: NodeId, il: *const inline_mod.InlineLayout, e: *const EditState) ?inline_mod.InlineLayout.Caret {
        return il.caretAt(id, ix.layoutOffset(id, e, e.caret));
    }

    fn verticalMove(ix: *Interaction, id: NodeId, e: *EditState, down: bool) u32 {
        const b = layout.boxOfNode(ix.doc.node(id)) orelse return e.caret;
        const il = b.inline_layout orelse return e.caret;
        const c = ix.caretRect(id, il, e) orelse return e.caret;
        const gx = e.goal_x orelse c.x;
        e.goal_x = gx;
        const ny = if (down) c.y + c.h * 1.5 else c.y - c.h * 0.5;
        if (ny < 0) return 0;
        if (ny > il.height) return @intCast(e.text.items.len);
        const at = il.offsetAt(id, gx, ny) orelse return e.caret;
        return ix.valueOffset(id, e, at);
    }

    /// Map a window point to a value offset inside a text control.
    pub fn offsetAtPoint(ix: *Interaction, id: NodeId, x: f32, y: f32) ?u32 {
        const origin = ix.contentOrigin(id) orelse return null;
        const b = layout.boxOfNode(ix.doc.node(id)) orelse return null;
        const il = b.inline_layout orelse return 0;
        const e = ix.editState(id) catch return null;
        const at = il.offsetAt(id, x - origin[0] + e.scroll_x, y - origin[1] + e.scroll_y) orelse return 0;
        return ix.valueOffset(id, e, at);
    }

    /// Absolute content-box origin of a laid-out element (ignores transforms).
    pub fn contentOrigin(ix: *Interaction, id: NodeId) ?[2]f32 {
        const doc = ix.doc;
        const b = layout.boxOfNode(doc.node(id)) orelse return null;
        var x: f32 = b.border.left + b.padding.left;
        var y: f32 = b.border.top + b.padding.top;
        var cur = id;
        while (cur != null_id and doc.node(cur).kind == .element) {
            const cb = layout.boxOfNode(doc.node(cur)) orelse break;
            x += cb.x + cb.rel_x;
            y += cb.y + cb.rel_y;
            const parent = doc.node(cur).parent;
            if (parent == null_id or doc.node(parent).kind != .element) break;
            const pn = doc.node(parent);
            if (style_mod.of(doc, parent).clipsContent()) {
                x -= pn.scroll_x;
                y -= pn.scroll_y;
            }
            cur = parent;
        }
        return .{ x, y };
    }

    fn ensureCaretVisible(ix: *Interaction, id: NodeId) void {
        const e = ix.edits.get(id) orelse return;
        const b = layout.boxOfNode(ix.doc.node(id)) orelse return;
        const il = b.inline_layout orelse return;
        const c = ix.caretRect(id, il, e) orelse return;
        const cw = b.w - b.border.horizontal() - b.padding.horizontal();
        const ch = b.h - b.border.vertical() - b.padding.vertical();
        if (c.x - e.scroll_x > cw - 2) e.scroll_x = c.x - cw + 2;
        if (c.x - e.scroll_x < 0) e.scroll_x = @max(0, c.x);
        if (c.y + c.h - e.scroll_y > ch) e.scroll_y = c.y + c.h - ch;
        if (c.y - e.scroll_y < 0) e.scroll_y = @max(0, c.y);
    }

    fn reportImeRect(ix: *Interaction, id: NodeId) void {
        const f = ix.host.ime_rect orelse return;
        const e = ix.edits.get(id) orelse return;
        const b = layout.boxOfNode(ix.doc.node(id)) orelse return;
        const il = b.inline_layout orelse return;
        const c = ix.caretRect(id, il, e) orelse return;
        const o = ix.contentOrigin(id) orelse return;
        f(ix.host.ctx, .{ .x = o[0] + c.x - e.scroll_x, .y = o[1] + c.y - e.scroll_y, .w = 1, .h = c.h });
    }

    /// Whether the caret should be drawn now (blinks at ~1Hz, solid right after edits).
    pub fn caretVisible(ix: *const Interaction) bool {
        const t = ix.now - ix.caret_time;
        if (t < 0.5) return true;
        return @mod(t - 0.5, 1.0) >= 0.5;
    }
};

fn eqKey(key: []const u8, k: []const u8) bool {
    return std.ascii.eqlIgnoreCase(key, k);
}

fn utf8Floor(s: []const u8, n: usize) usize {
    var i = @min(n, s.len);
    while (i > 0 and i < s.len and (s[i] & 0xc0) == 0x80) i -= 1;
    return i;
}

fn prevChar(s: []const u8, start: u32) u32 {
    var i = start;
    if (i == 0) return 0;
    i -= 1;
    while (i > 0 and (s[i] & 0xc0) == 0x80) i -= 1;
    return i;
}

fn nextChar(s: []const u8, start: u32) u32 {
    var i = start;
    if (i >= s.len) return @intCast(s.len);
    i += 1;
    while (i < s.len and (s[i] & 0xc0) == 0x80) i += 1;
    return i;
}

fn isWordChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_' or c >= 0x80;
}

fn prevWord(s: []const u8, start: u32) u32 {
    var i = start;
    while (i > 0 and !isWordChar(s[i - 1])) i -= 1;
    while (i > 0 and isWordChar(s[i - 1])) i -= 1;
    return i;
}

fn nextWord(s: []const u8, start: u32) u32 {
    var i = start;
    while (i < s.len and !isWordChar(s[i])) i += 1;
    while (i < s.len and isWordChar(s[i])) i += 1;
    return i;
}

fn lineStart(s: []const u8, start: u32) u32 {
    var i = start;
    while (i > 0 and s[i - 1] != '\n') i -= 1;
    return i;
}

fn lineEnd(s: []const u8, start: u32) u32 {
    var i = start;
    while (i < s.len and s[i] != '\n') i += 1;
    return i;
}

fn selectWord(e: *EditState) void {
    const s = e.text.items;
    var a = e.caret;
    var b = e.caret;
    while (a > 0 and isWordChar(s[a - 1])) a -= 1;
    while (b < s.len and isWordChar(s[b])) b += 1;
    e.anchor = a;
    e.caret = b;
}

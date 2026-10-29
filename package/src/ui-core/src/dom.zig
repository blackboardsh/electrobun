//! Retained document tree. Nodes are addressed by stable u32 ids so every
//! language binding (and the batched command protocol) can refer to them
//! without pointers. Mutations only set dirty bits; style, layout and paint
//! are recomputed lazily by `Document.update`.
const std = @import("std");
const atom_mod = @import("atom.zig");
const geom = @import("geom.zig");
const props = @import("css/properties.zig");
const stylesheet = @import("css/stylesheet.zig");

pub const Atom = atom_mod.Atom;
/// Generational node handle: low `slot_bits` index a slot, the high bits
/// hold that slot's generation. Destroying a node bumps the generation, so a
/// stale id never resolves (and never aliases a newer node in the slot).
pub const NodeId = u32;
pub const null_id: NodeId = 0;
const slot_bits = 20;
const slot_mask: u32 = (1 << slot_bits) - 1;
const max_gen: u32 = (1 << (32 - slot_bits)) - 1;

inline fn slotOf(id: NodeId) u32 {
    return id & slot_mask;
}
const Allocator = std.mem.Allocator;

pub const Kind = enum(u8) { document, element, text, comment };

/// Interaction state that selectors can observe.
pub const State = packed struct(u16) {
    hover: bool = false,
    active: bool = false,
    focus: bool = false,
    focus_visible: bool = false,
    focus_within: bool = false,
    checked: bool = false,
    open: bool = false,
    indeterminate: bool = false,
    _pad: u8 = 0,
};

pub const Flags = packed struct(u16) {
    /// computed style of this node must be recomputed (and its subtree, since
    /// inherited values and descendant selectors may change)
    style_dirty: bool = true,
    /// some descendant has style_dirty set
    child_style_dirty: bool = false,
    /// this node's own box must be re-laid-out
    layout_dirty: bool = true,
    /// some descendant needs layout
    child_layout_dirty: bool = false,
    /// text content / inline run changed (re-shape)
    text_dirty: bool = true,
    /// descendants must be restyled too (a selector-relevant property of this
    /// node changed and some rule observes it from a descendant position)
    force_subtree: bool = true,
    _pad: u10 = 0,
};

pub const Attr = struct {
    name: Atom,
    value: []u8,
};

pub const Node = struct {
    kind: Kind,
    tag: Atom = atom_mod.none,
    id: NodeId,
    parent: NodeId = null_id,
    first_child: NodeId = null_id,
    last_child: NodeId = null_id,
    prev: NodeId = null_id,
    next: NodeId = null_id,
    child_count: u32 = 0,

    id_attr: Atom = atom_mod.none,
    classes: std.ArrayList(Atom) = .empty,
    attrs: std.ArrayList(Attr) = .empty,
    /// text node content (UTF-8)
    text: std.ArrayList(u8) = .empty,

    inline_decls: std.ArrayList(props.Declaration) = .empty,
    inline_arena: ?*std.heap.ArenaAllocator = null,

    state: State = .{},
    flags: Flags = .{},
    /// bitmask of event types with listeners (see events.zig)
    listeners: u64 = 0,
    /// opaque value for bindings (e.g. a JS handle)
    user_data: usize = 0,

    /// computed style; owned by the style system (null until first restyle)
    style: ?*anyopaque = null,
    /// layout box; owned by the layout system
    box: ?*anyopaque = null,
    /// render-side cache (text shaping etc.)
    render_cache: ?*anyopaque = null,

    scroll_x: f32 = 0,
    scroll_y: f32 = 0,

    pub fn isElement(n: *const Node) bool {
        return n.kind == .element;
    }
    pub fn hasClass(n: *const Node, c: Atom) bool {
        for (n.classes.items) |x| if (x == c) return true;
        return false;
    }
    pub fn getAttr(n: *const Node, name: Atom) ?[]const u8 {
        for (n.attrs.items) |a| if (a.name == name) return a.value;
        return null;
    }
    pub fn hasAttr(n: *const Node, name: Atom) bool {
        return n.getAttr(name) != null;
    }
};

/// `child_list` reports the parent; `inserted` the node that was inserted.
pub const MutationKind = enum { attribute, child_list, text, state, inserted };

pub const Sensitivity = struct {
    /// state bits that appear in non-subject compounds (e.g. `.group:hover .x`)
    ancestor_states: u16 = 0xffff,
    /// classes/ids/attributes appear in non-subject compounds
    ancestor_attrs: bool = true,
    /// sibling combinators or structural pseudos are in use
    siblings: bool = true,
    /// :has() is in use (any change may affect ancestors)
    has: bool = true,
};

pub const Document = struct {
    gpa: Allocator,
    interner: atom_mod.Interner,
    nodes: std.ArrayList(?*Node) = .empty,
    /// current generation of each slot
    gens: std.ArrayList(u16) = .empty,
    /// reusable slots (their generation was already bumped)
    free_ids: std.ArrayList(u32) = .empty,
    root: NodeId = null_id,

    /// author stylesheets in cascade order
    sheets: std.ArrayList(*stylesheet.Stylesheet) = .empty,
    sheets_dirty: bool = true,
    /// incremented whenever anything that affects rendering changes
    version: u64 = 1,
    /// a structural/attribute change happened somewhere that sibling or :has
    /// selectors may depend on
    needs_full_restyle: bool = true,
    needs_paint: bool = true,

    focused: NodeId = null_id,
    hovered: NodeId = null_id,
    active: NodeId = null_id,

    /// well-known atoms
    atoms: WellKnown = undefined,
    /// which kinds of change can affect other nodes' styles; maintained by the
    /// style engine from the active rules (conservative until then)
    sensitivity: Sensitivity = .{},

    /// optional mutation observer (bindings, accessibility)
    observer: ?*const fn (doc: *Document, kind: MutationKind, node: NodeId, ctx: ?*anyopaque) void = null,
    observer_ctx: ?*anyopaque = null,
    /// teardown hook for the style/layout/render data hung off nodes
    node_finalizer: ?*const fn (doc: *Document, node: *Node) void = null,
    /// Per-node data that was replaced or whose node was destroyed, but that
    /// other per-node data may still point into: computed styles shallow-copy
    /// inherited slices (font_family, text_shadow, custom properties) from
    /// their ancestors' style arenas, and cached layout holds *Style
    /// pointers. Everything is recomputed from live data by the next complete
    /// style + layout pass, after which the owner calls `releaseRetired`.
    retired: std.ArrayList(Retired) = .empty,

    pub fn init(gpa: Allocator) !*Document {
        const doc = try gpa.create(Document);
        doc.* = .{ .gpa = gpa, .interner = atom_mod.Interner.init(gpa) };
        doc.atoms = try WellKnown.init(&doc.interner);
        try doc.nodes.append(gpa, null); // id 0 is null
        try doc.gens.append(gpa, 0);
        doc.root = try doc.allocNode(.document, atom_mod.none);
        return doc;
    }

    pub const Retired = struct {
        ptr: *anyopaque,
        free: *const fn (gpa: Allocator, ptr: *anyopaque) void,
    };

    /// Defer freeing `ptr` until `releaseRetired`. Reserve with
    /// `reserveRetired` first where a failure must not leak.
    pub fn retire(doc: *Document, ptr: *anyopaque, free: *const fn (gpa: Allocator, ptr: *anyopaque) void) void {
        // out of memory: leaking is safe, freeing early is not
        doc.retired.append(doc.gpa, .{ .ptr = ptr, .free = free }) catch {};
    }

    pub fn reserveRetired(doc: *Document, n: usize) Allocator.Error!void {
        try doc.retired.ensureUnusedCapacity(doc.gpa, n);
    }

    /// Free retired data. Only valid once no live style or layout can refer
    /// to it: after a complete style + layout pass (or at teardown).
    pub fn releaseRetired(doc: *Document) void {
        for (doc.retired.items) |r| r.free(doc.gpa, r.ptr);
        doc.retired.clearRetainingCapacity();
    }

    pub fn deinit(doc: *Document) void {
        const gpa = doc.gpa;
        for (doc.nodes.items) |maybe| {
            if (maybe) |n| doc.freeNodeMemory(n);
        }
        doc.releaseRetired();
        doc.retired.deinit(gpa);
        doc.nodes.deinit(gpa);
        doc.gens.deinit(gpa);
        doc.free_ids.deinit(gpa);
        for (doc.sheets.items) |s| {
            s.deinit();
            gpa.destroy(s);
        }
        doc.sheets.deinit(gpa);
        doc.interner.deinit();
        gpa.destroy(doc);
    }

    fn freeNodeMemory(doc: *Document, n: *Node) void {
        const gpa = doc.gpa;
        if (doc.node_finalizer) |f| f(doc, n);
        for (n.attrs.items) |a| gpa.free(a.value);
        n.attrs.deinit(gpa);
        n.classes.deinit(gpa);
        n.text.deinit(gpa);
        n.inline_decls.deinit(gpa);
        if (n.inline_arena) |ar| {
            ar.deinit();
            gpa.destroy(ar);
        }
        gpa.destroy(n);
    }

    fn allocNode(doc: *Document, kind: Kind, tag: Atom) !NodeId {
        const n = try doc.gpa.create(Node);
        errdefer doc.gpa.destroy(n);
        var slot: u32 = undefined;
        if (doc.free_ids.pop()) |reuse| {
            slot = reuse;
            doc.nodes.items[slot] = n;
        } else {
            slot = @intCast(doc.nodes.items.len);
            if (slot > slot_mask) return error.OutOfMemory;
            try doc.gens.append(doc.gpa, 0);
            errdefer _ = doc.gens.pop();
            try doc.nodes.append(doc.gpa, n);
        }
        const id: NodeId = slot | (@as(u32, doc.gens.items[slot]) << slot_bits);
        n.* = .{ .kind = kind, .tag = tag, .id = id };
        return id;
    }

    /// The node for `id`, or null if it was destroyed (or never existed).
    pub fn get(doc: *const Document, id: NodeId) ?*Node {
        const slot = slotOf(id);
        if (id == null_id or slot >= doc.nodes.items.len) return null;
        if (doc.gens.items[slot] != id >> slot_bits) return null;
        return doc.nodes.items[slot];
    }

    /// The node for a live `id`. A stale id is a bug: it panics in safe
    /// builds. Code holding ids across mutations or frames must use `get`.
    pub fn node(doc: *const Document, id: NodeId) *Node {
        return doc.get(id) orelse std.debug.panic("stale or invalid NodeId {d}", .{id});
    }

    pub fn isAlive(doc: *const Document, id: NodeId) bool {
        return doc.get(id) != null;
    }

    pub fn createElement(doc: *Document, tag_name: []const u8) !NodeId {
        const tag = try doc.interner.internLower(tag_name);
        return doc.allocNode(.element, tag);
    }

    pub fn createText(doc: *Document, content: []const u8) !NodeId {
        const id = try doc.allocNode(.text, atom_mod.none);
        try doc.node(id).text.appendSlice(doc.gpa, content);
        return id;
    }

    pub fn createComment(doc: *Document) !NodeId {
        return doc.allocNode(.comment, atom_mod.none);
    }

    /// Detach and destroy a node and its whole subtree.
    pub fn destroy(doc: *Document, id: NodeId) void {
        const n = doc.get(id) orelse return;
        if (n.parent != null_id) doc.removeChild(id);
        doc.destroyDetached(id);
    }

    fn destroyDetached(doc: *Document, id: NodeId) void {
        const n = doc.node(id);
        var c = n.first_child;
        while (c != null_id) {
            const next = doc.node(c).next;
            doc.destroyDetached(c);
            c = next;
        }
        if (doc.focused == id) doc.focused = null_id;
        if (doc.hovered == id) doc.hovered = null_id;
        if (doc.active == id) doc.active = null_id;
        doc.freeNodeMemory(n);
        const slot = slotOf(id);
        doc.nodes.items[slot] = null;
        // retire the slot when its generation would wrap: ids never alias
        if (doc.gens.items[slot] < max_gen) {
            doc.gens.items[slot] += 1;
            doc.free_ids.append(doc.gpa, slot) catch {};
        }
    }

    // -----------------------------------------------------------------------
    // Tree mutation
    // -----------------------------------------------------------------------

    pub fn appendChild(doc: *Document, parent: NodeId, child: NodeId) void {
        doc.insertBefore(parent, child, null_id);
    }

    /// Insert `child` into `parent` before `before` (null_id = append).
    /// A child that already has a parent is moved.
    pub fn insertBefore(doc: *Document, parent: NodeId, child: NodeId, before: NodeId) void {
        const c = doc.node(child);
        if (c.parent != null_id) doc.removeChild(child);
        const p = doc.node(parent);
        c.parent = parent;
        if (before == null_id) {
            c.prev = p.last_child;
            c.next = null_id;
            if (p.last_child != null_id) doc.node(p.last_child).next = child else p.first_child = child;
            p.last_child = child;
        } else {
            const b = doc.node(before);
            std.debug.assert(b.parent == parent);
            c.next = before;
            c.prev = b.prev;
            if (b.prev != null_id) doc.node(b.prev).next = child else p.first_child = child;
            b.prev = child;
        }
        p.child_count += 1;
        doc.childrenChanged(parent);
        doc.markStyleDirty(child);
        doc.markLayoutDirty(child);
        doc.notify(.child_list, parent);
        doc.notify(.inserted, child);
    }

    pub fn removeChild(doc: *Document, child: NodeId) void {
        const c = doc.node(child);
        const parent = c.parent;
        if (parent == null_id) return;
        const p = doc.node(parent);
        if (c.prev != null_id) doc.node(c.prev).next = c.next else p.first_child = c.next;
        if (c.next != null_id) doc.node(c.next).prev = c.prev else p.last_child = c.prev;
        c.parent = null_id;
        c.prev = null_id;
        c.next = null_id;
        p.child_count -= 1;
        // interaction state inside the removed subtree no longer applies
        if (doc.hovered != null_id and doc.isInclusiveAncestor(child, doc.hovered)) doc.hovered = null_id;
        if (doc.active != null_id and doc.isInclusiveAncestor(child, doc.active)) doc.active = null_id;
        if (doc.focused != null_id and doc.isInclusiveAncestor(child, doc.focused)) doc.focused = null_id;
        doc.childrenChanged(parent);
        doc.notify(.child_list, parent);
    }

    fn childrenChanged(doc: *Document, parent: NodeId) void {
        // structural pseudo-classes (:first-child, :nth-child, :empty) and
        // sibling combinators: restyle the parent's subtree
        doc.markStyleDirty(parent);
        if (doc.sensitivity.siblings or doc.sensitivity.has) doc.node(parent).flags.force_subtree = true;
        if (doc.sensitivity.has) {
            var p = doc.node(parent).parent;
            while (p != null_id) : (p = doc.node(p).parent) {
                doc.node(p).flags.style_dirty = true;
                doc.node(p).flags.force_subtree = true;
            }
        }
        doc.markLayoutDirty(parent);
        doc.node(parent).flags.text_dirty = true;
    }

    pub fn isInclusiveAncestor(doc: *const Document, ancestor: NodeId, id: NodeId) bool {
        var cur = id;
        while (cur != null_id) {
            if (cur == ancestor) return true;
            cur = doc.node(cur).parent;
        }
        return false;
    }

    pub fn setText(doc: *Document, id: NodeId, content: []const u8) Allocator.Error!void {
        const n = doc.node(id);
        if (std.mem.eql(u8, n.text.items, content)) return;
        n.text.clearRetainingCapacity();
        try n.text.appendSlice(doc.gpa, content);
        n.flags.text_dirty = true;
        if (n.parent != null_id) {
            doc.node(n.parent).flags.text_dirty = true;
            // :empty may change only on empty <-> non-empty, but cheap enough
        }
        doc.markLayoutDirty(id);
        doc.notify(.text, id);
    }

    pub fn setAttribute(doc: *Document, id: NodeId, name: []const u8, value: []const u8) Allocator.Error!void {
        const n = doc.node(id);
        const a = try doc.interner.internLower(name);
        for (n.attrs.items) |*attr| {
            if (attr.name == a) {
                if (std.mem.eql(u8, attr.value, value)) return;
                const copy = try doc.gpa.dupe(u8, value);
                doc.gpa.free(attr.value);
                attr.value = copy;
                try doc.attributeChanged(id, a);
                return;
            }
        }
        const copy = try doc.gpa.dupe(u8, value);
        errdefer doc.gpa.free(copy);
        try n.attrs.append(doc.gpa, .{ .name = a, .value = copy });
        try doc.attributeChanged(id, a);
    }

    pub fn removeAttribute(doc: *Document, id: NodeId, name: []const u8) Allocator.Error!void {
        const n = doc.node(id);
        const a = doc.interner.lookup(name) orelse return;
        for (n.attrs.items, 0..) |attr, i| {
            if (attr.name == a) {
                doc.gpa.free(attr.value);
                _ = n.attrs.orderedRemove(i);
                try doc.attributeChanged(id, a);
                return;
            }
        }
    }

    pub fn getAttribute(doc: *const Document, id: NodeId, name: []const u8) ?[]const u8 {
        const a = doc.interner.lookup(name) orelse return null;
        return doc.node(id).getAttr(a);
    }

    fn attributeChanged(doc: *Document, id: NodeId, name: Atom) Allocator.Error!void {
        const n = doc.node(id);
        const w = &doc.atoms;
        if (name == w.class) {
            n.classes.clearRetainingCapacity();
            if (n.getAttr(w.class)) |v| {
                var it = std.mem.tokenizeAny(u8, v, " \t\r\n\x0c");
                while (it.next()) |c| try n.classes.append(doc.gpa, try doc.interner.intern(c));
            }
        } else if (name == w.id) {
            n.id_attr = if (n.getAttr(w.id)) |v| try doc.interner.intern(v) else atom_mod.none;
        } else if (name == w.style) {
            try doc.setInlineStyleText(id, n.getAttr(w.style) orelse "");
        } else if (name == w.checked) {
            n.state.checked = n.hasAttr(w.checked);
        } else if (name == w.open) {
            n.state.open = n.hasAttr(w.open);
        }
        doc.markStyleDirty(id);
        if (doc.sensitivity.ancestor_attrs) n.flags.force_subtree = true;
        doc.selectorContextChanged(id);
        doc.markLayoutDirty(id);
        n.flags.text_dirty = true;
        doc.notify(.attribute, id);
    }

    fn setInlineStyleText(doc: *Document, id: NodeId, text: []const u8) Allocator.Error!void {
        const n = doc.node(id);
        n.inline_decls.clearRetainingCapacity();
        if (n.inline_arena) |ar| {
            _ = ar.reset(.retain_capacity);
        } else {
            const ar = try doc.gpa.create(std.heap.ArenaAllocator);
            ar.* = std.heap.ArenaAllocator.init(doc.gpa);
            n.inline_arena = ar;
        }
        var tmp: std.ArrayList(props.Declaration) = .empty;
        try stylesheet.parseInline(n.inline_arena.?.allocator(), text, &tmp);
        try n.inline_decls.appendSlice(doc.gpa, tmp.items);
    }

    /// Set (or remove, when value is empty) a single inline style property,
    /// like element.style.setProperty(). Keeps the style attribute in sync.
    pub fn setStyleProperty(doc: *Document, id: NodeId, name: []const u8, value: []const u8) Allocator.Error!void {
        const n = doc.node(id);
        const current = n.getAttr(doc.atoms.style) orelse "";
        var buf: std.ArrayList(u8) = .empty;
        defer buf.deinit(doc.gpa);
        // rewrite the style attribute: drop existing `name:` declarations
        var it = std.mem.splitScalar(u8, current, ';');
        while (it.next()) |decl| {
            const trimmed = std.mem.trim(u8, decl, " \t\r\n");
            if (trimmed.len == 0) continue;
            const colon = std.mem.indexOfScalar(u8, trimmed, ':') orelse continue;
            const pname = std.mem.trim(u8, trimmed[0..colon], " \t");
            if (std.ascii.eqlIgnoreCase(pname, name)) continue;
            try buf.appendSlice(doc.gpa, trimmed);
            try buf.appendSlice(doc.gpa, "; ");
        }
        if (value.len > 0) {
            try buf.appendSlice(doc.gpa, name);
            try buf.appendSlice(doc.gpa, ": ");
            try buf.appendSlice(doc.gpa, value);
        }
        try doc.setAttribute(id, "style", std.mem.trimEnd(u8, buf.items, "; "));
    }

    pub fn setState(doc: *Document, id: NodeId, state: State) void {
        const n = doc.node(id);
        const old: u16 = @bitCast(n.state);
        const new: u16 = @bitCast(state);
        if (old == new) return;
        n.state = state;
        doc.markStyleDirty(id);
        if ((old ^ new) & doc.sensitivity.ancestor_states != 0) n.flags.force_subtree = true;
        doc.selectorContextChanged(id);
        doc.notify(.state, id);
    }

    /// A node's selector-visible data changed: siblings (via + ~) and
    /// ancestors (via :has) may need restyling.
    fn selectorContextChanged(doc: *Document, id: NodeId) void {
        const n = doc.node(id);
        if (n.parent == null_id) return;
        if (doc.sensitivity.has) {
            var p = n.parent;
            while (p != null_id) : (p = doc.node(p).parent) {
                doc.node(p).flags.style_dirty = true;
                doc.node(p).flags.force_subtree = true;
            }
            doc.markStyleDirty(n.parent);
        } else if (doc.sensitivity.siblings) {
            var sib = n.next;
            while (sib != null_id) : (sib = doc.node(sib).next) {
                const sn = doc.node(sib);
                sn.flags.style_dirty = true;
                sn.flags.force_subtree = true;
            }
            doc.markStyleDirty(n.parent);
        }
    }

    // -----------------------------------------------------------------------
    // Dirty bits
    // -----------------------------------------------------------------------

    pub fn markStyleDirty(doc: *Document, id: NodeId) void {
        const n = doc.node(id);
        n.flags.style_dirty = true;
        var p = n.parent;
        while (p != null_id) {
            const pn = doc.node(p);
            if (pn.flags.child_style_dirty) break;
            pn.flags.child_style_dirty = true;
            p = pn.parent;
        }
        doc.version += 1;
        doc.needs_paint = true;
    }

    pub fn markLayoutDirty(doc: *Document, id: NodeId) void {
        const n = doc.node(id);
        n.flags.layout_dirty = true;
        var p = n.parent;
        while (p != null_id) {
            const pn = doc.node(p);
            pn.flags.layout_dirty = true; // a child's size can change ours
            p = pn.parent;
        }
        doc.version += 1;
        doc.needs_paint = true;
    }

    pub fn markAllStyleDirty(doc: *Document) void {
        for (doc.nodes.items) |maybe| if (maybe) |n| {
            n.flags.style_dirty = true;
            n.flags.force_subtree = true;
            n.flags.layout_dirty = true;
            n.flags.text_dirty = true;
        };
        doc.version += 1;
        doc.needs_paint = true;
    }

    fn notify(doc: *Document, kind: MutationKind, id: NodeId) void {
        if (doc.observer) |o| o(doc, kind, id, doc.observer_ctx);
    }

    // -----------------------------------------------------------------------
    // Stylesheets
    // -----------------------------------------------------------------------

    pub fn addStylesheet(doc: *Document, css: []const u8) Allocator.Error!*stylesheet.Stylesheet {
        const sheet = try stylesheet.parse(doc.gpa, &doc.interner, css);
        errdefer {
            sheet.deinit();
            doc.gpa.destroy(sheet);
        }
        try doc.sheets.append(doc.gpa, sheet);
        doc.sheets_dirty = true;
        doc.markAllStyleDirty();
        return sheet;
    }

    pub fn removeStylesheet(doc: *Document, sheet: *stylesheet.Stylesheet) void {
        for (doc.sheets.items, 0..) |s, i| {
            if (s == sheet) {
                _ = doc.sheets.orderedRemove(i);
                s.deinit();
                doc.gpa.destroy(s);
                doc.sheets_dirty = true;
                doc.markAllStyleDirty();
                return;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Traversal helpers
    // -----------------------------------------------------------------------

    pub fn documentElement(doc: *const Document) NodeId {
        var c = doc.node(doc.root).first_child;
        while (c != null_id) : (c = doc.node(c).next) {
            if (doc.node(c).kind == .element) return c;
        }
        return null_id;
    }

    pub fn tagName(doc: *const Document, id: NodeId) []const u8 {
        return doc.interner.str(doc.node(id).tag);
    }

    /// Pre-order successor of `id` within the subtree rooted at `scope`.
    pub fn nextInTree(doc: *const Document, id: NodeId, scope: NodeId) NodeId {
        const n = doc.node(id);
        if (n.first_child != null_id) return n.first_child;
        var cur = id;
        while (cur != null_id and cur != scope) {
            const c = doc.node(cur);
            if (c.next != null_id) return c.next;
            cur = c.parent;
        }
        return null_id;
    }

    pub fn elementById(doc: *const Document, id_str: []const u8) NodeId {
        const a = doc.interner.lookup(id_str) orelse return null_id;
        var cur = doc.root;
        while (cur != null_id) : (cur = doc.nextInTree(cur, doc.root)) {
            if (doc.node(cur).id_attr == a) return cur;
        }
        return null_id;
    }

    /// Concatenated text of a subtree.
    pub fn textContent(doc: *const Document, id: NodeId, out: *std.ArrayList(u8)) !void {
        const n = doc.node(id);
        if (n.kind == .text) return out.appendSlice(doc.gpa, n.text.items);
        var c = n.first_child;
        while (c != null_id) : (c = doc.node(c).next) try doc.textContent(c, out);
    }

    /// Serialize a subtree as HTML (debugging and tests).
    pub fn serialize(doc: *const Document, id: NodeId, out: *std.ArrayList(u8)) !void {
        const gpa = doc.gpa;
        const n = doc.node(id);
        switch (n.kind) {
            .text => try escapeText(gpa, out, n.text.items),
            .comment => {},
            .document => {
                var c = n.first_child;
                while (c != null_id) : (c = doc.node(c).next) try doc.serialize(c, out);
            },
            .element => {
                const tag = doc.interner.str(n.tag);
                try out.append(gpa, '<');
                try out.appendSlice(gpa, tag);
                for (n.attrs.items) |a| {
                    try out.append(gpa, ' ');
                    try out.appendSlice(gpa, doc.interner.str(a.name));
                    if (a.value.len > 0) {
                        try out.appendSlice(gpa, "=\"");
                        try escapeText(gpa, out, a.value);
                        try out.append(gpa, '"');
                    }
                }
                try out.append(gpa, '>');
                if (isVoidElement(tag)) return;
                var c = n.first_child;
                while (c != null_id) : (c = doc.node(c).next) try doc.serialize(c, out);
                try out.appendSlice(gpa, "</");
                try out.appendSlice(gpa, tag);
                try out.append(gpa, '>');
            },
        }
    }
};

fn escapeText(gpa: Allocator, out: *std.ArrayList(u8), s: []const u8) !void {
    for (s) |c| switch (c) {
        '<' => try out.appendSlice(gpa, "&lt;"),
        '>' => try out.appendSlice(gpa, "&gt;"),
        '&' => try out.appendSlice(gpa, "&amp;"),
        '"' => try out.appendSlice(gpa, "&quot;"),
        else => try out.append(gpa, c),
    };
}

pub fn isVoidElement(tag: []const u8) bool {
    const voids = [_][]const u8{ "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr" };
    for (voids) |v| if (std.mem.eql(u8, tag, v)) return true;
    return false;
}

pub const WellKnown = struct {
    class: Atom,
    id: Atom,
    style: Atom,
    checked: Atom,
    disabled: Atom,
    open: Atom,
    value: Atom,
    placeholder: Atom,
    type: Atom,
    href: Atom,
    src: Atom,
    tabindex: Atom,
    hidden: Atom,
    readonly: Atom,
    required: Atom,
    contenteditable: Atom,
    lang: Atom,
    dir: Atom,
    role: Atom,
    aria_label: Atom,
    title: Atom,
    alt: Atom,
    for_: Atom,
    name: Atom,
    selected: Atom,
    width: Atom,
    height: Atom,
    rows: Atom,
    cols: Atom,
    size: Atom,
    min: Atom,
    max: Atom,
    step: Atom,
    maxlength: Atom,
    autofocus: Atom,
    // tags
    html: Atom,
    body: Atom,
    head: Atom,
    div: Atom,
    span: Atom,
    input: Atom,
    textarea: Atom,
    button: Atom,
    select: Atom,
    option: Atom,
    img: Atom,
    a: Atom,
    label: Atom,
    br: Atom,
    style_tag: Atom,
    script: Atom,
    template: Atom,
    svg: Atom,
    details: Atom,
    summary: Atom,
    dialog: Atom,
    progress: Atom,
    slot: Atom,
    li: Atom,
    ol: Atom,
    ul: Atom,
    pre: Atom,
    hr: Atom,
    canvas: Atom,
    webview: Atom,
    wgpu: Atom,

    fn init(i: *atom_mod.Interner) !WellKnown {
        var w: WellKnown = undefined;
        inline for (comptime std.meta.fieldNames(WellKnown)) |fname| {
            const name = comptime blk: {
                if (std.mem.eql(u8, fname, "for_")) break :blk "for";
                if (std.mem.eql(u8, fname, "aria_label")) break :blk "aria-label";
                if (std.mem.eql(u8, fname, "style_tag")) break :blk "style";
                if (std.mem.eql(u8, fname, "webview")) break :blk "electrobun-webview";
                if (std.mem.eql(u8, fname, "wgpu")) break :blk "electrobun-wgpu";
                break :blk fname;
            };
            @field(w, fname) = try i.intern(name);
        }
        return w;
    }
};

test "tree mutation" {
    const doc = try Document.init(std.testing.allocator);
    defer doc.deinit();
    const div = try doc.createElement("DIV");
    doc.appendChild(doc.root, div);
    const a = try doc.createText("hello");
    const b = try doc.createElement("b");
    const c = try doc.createText("!");
    doc.appendChild(div, a);
    doc.appendChild(div, c);
    doc.insertBefore(div, b, c);
    try doc.setAttribute(div, "class", "card  big");
    try doc.setAttribute(div, "id", "main");
    try std.testing.expectEqual(@as(usize, 2), doc.node(div).classes.items.len);
    try std.testing.expectEqual(div, doc.elementById("main"));
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(std.testing.allocator);
    try doc.serialize(doc.root, &out);
    try std.testing.expectEqualStrings("<div class=\"card  big\" id=\"main\">hello<b></b>!</div>", out.items);
    doc.destroy(b);
    out.clearRetainingCapacity();
    try doc.serialize(doc.root, &out);
    try std.testing.expectEqualStrings("<div class=\"card  big\" id=\"main\">hello!</div>", out.items);
    // slots are recycled, but a stale id never resolves to the new node
    const d = try doc.createElement("i");
    try std.testing.expect(d != b);
    try std.testing.expectEqual(b & slot_mask, d & slot_mask);
    try std.testing.expect(doc.get(b) == null);
    try std.testing.expect(doc.get(d) != null);
    doc.destroy(d);
    try doc.setStyleProperty(div, "color", "red");
    try doc.setStyleProperty(div, "width", "10px");
    try doc.setStyleProperty(div, "color", "blue");
    try std.testing.expectEqualStrings("width: 10px; color: blue", doc.getAttribute(div, "style").?);
    try std.testing.expectEqual(@as(usize, 2), doc.node(div).inline_decls.items.len);
}

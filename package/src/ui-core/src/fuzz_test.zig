//! Interaction fuzzer: drives a kitchen-sink document with seeded random
//! pointer, keyboard, text, DOM-mutation and animation steps, and checks
//! engine invariants after every frame. Runs under the test allocator with
//! safety checks, so leaks, double frees, out-of-bounds and stale ids panic
//! at the faulty line instead of corrupting memory. A few seeds also run
//! under the guard-page Quarantine allocator, which makes any read of freed
//! memory fault deterministically (the general-purpose allocator would hand
//! freed blocks to the next allocation and hide it).
const std = @import("std");
const dom = @import("dom.zig");
const font = @import("text/font.zig");
const style_mod = @import("style.zig");
const ui_mod = @import("ui.zig");
const Ui = ui_mod.Ui;
const Quarantine = @import("quarantine.zig").Quarantine;

const page =
    \\<style>
    \\ body { margin: 0; font-size: 12px; --f: "Inter", sans-serif; font-family: var(--f) }
    \\ .b { padding: 4px; background: #eee; transition: background-color .2s, transform .15s }
    \\ .b:hover { background: #ccc; transform: translateY(-1px) }
    \\ .b:active { box-shadow: 0 2px 6px rgba(0,0,0,.3) }
    \\ .card { padding: 6px; border: 1px solid #ddd; box-shadow: 0 4px 12px rgba(0,0,0,.2); opacity: .9; --fg: #222 }
    \\ .card:hover { --f: "Mono", monospace; text-shadow: 0 1px 1px rgba(0,0,0,.2) }
    \\ .card:hover p, .scroll:hover li { color: var(--fg) }
    \\ .card::after { content: "!"; color: red }
    \\ .card:hover::after { color: blue }
    \\ @keyframes pop { from { opacity: 0; transform: scale(.9) } }
    \\ .pop { animation: pop .1s ease-out }
    \\ .scroll { height: 60px; overflow: auto }
    \\ input:focus, textarea:focus { outline: 2px solid blue }
    \\ ul li:nth-child(odd) { background: #fafafa }
    \\</style>
    \\<div class="card pop">
    \\ <button class="b" id="b1">One</button><button class="b">Two é</button>
    \\ <input id="t" placeholder="Ada Lovelace"><input type="password" id="pw">
    \\ <textarea id="ta" placeholder="Bio">line1
    \\line2 日本語</textarea>
    \\ <select id="s"><option value="a">Alpha</option><option value="b" selected>Beta</option><option value="c">Gamma</option></select>
    \\ <label><input type="checkbox"> check</label>
    \\ <div class="scroll"><ul><li>one</li><li>two 👍</li><li>three</li><li>four</li><li>five</li><li>six</li></ul></div>
    \\ <p>Some <b>bold</b> and <i>italic</i> text that wraps across the line.</p>
    \\</div>
;

const keys = [_][]const u8{ "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Delete", "Enter", "Tab", "Escape", "Home", "End", " ", "a", "z", "c", "v" };
const texts = [_][]const u8{ "a", "Z", "é", "日本", "👍", "•", " ", "hello", "x\ny", "\t" };
const tags = [_][]const u8{ "div", "span", "button", "input", "li", "p", "b" };
const classes = [_][]const u8{ "b", "card", "pop", "scroll", "card pop", "" };

fn randomNode(r: std.Random, doc: *dom.Document) dom.NodeId {
    // walk to a random node in document order
    const root = doc.documentElement();
    var n: usize = 0;
    var cur = root;
    while (cur != dom.null_id) : (cur = doc.nextInTree(cur, root)) n += 1;
    var pick = r.uintLessThan(usize, n);
    cur = root;
    while (pick > 0) : (pick -= 1) cur = doc.nextInTree(cur, root);
    return cur;
}

fn checkInvariants(ui: *Ui) !void {
    const doc = ui.doc;
    // ids held across frames refer to live nodes (or none)
    for ([_]dom.NodeId{ doc.focused, doc.hovered, doc.active }) |id| {
        if (id != dom.null_id) try std.testing.expect(doc.get(id) != null);
    }
    // edit states: caret/anchor inside the value, on UTF-8 boundaries
    var it = ui.ix.edits.iterator();
    while (it.next()) |kv| {
        const e = kv.value_ptr.*;
        const v = e.text.items;
        try std.testing.expect(e.caret <= v.len and e.anchor <= v.len);
        for ([_]u32{ e.caret, e.anchor }) |o| {
            if (o < v.len) try std.testing.expect(v[o] & 0xC0 != 0x80);
        }
        try std.testing.expect(std.unicode.utf8ValidateSlice(v));
    }
}

fn run(gpa: std.mem.Allocator, seed: u64, steps: usize) !void {
    const ui = try Ui.create(gpa, .{ .fonts = try font.MockBackend.create(gpa) });
    ui.owns_fonts = true;
    defer ui.destroy();
    try ui.setHtml(page);
    ui.resize(420, 320, 2);
    var prng = std.Random.DefaultPrng.init(seed);
    const r = prng.random();
    var now: f64 = 0;
    ui.tick(now);
    _ = try ui.update();

    for (0..steps) |_| {
        const x = r.float(f32) * 440 - 10;
        const y = r.float(f32) * 340 - 10;
        switch (r.uintLessThan(u8, 15)) {
            0, 1, 2 => ui.ix.pointerMove(x, y, .{}),
            3 => ui.ix.pointerDown(x, y, 0, .{ .shift = r.boolean() }),
            4 => ui.ix.pointerUp(x, y, 0, .{}),
            5 => ui.ix.wheel(x, y, 0, r.float(f32) * 80 - 40, .{}),
            6 => ui.ix.keyDown(keys[r.uintLessThan(usize, keys.len)], .{ .shift = r.boolean(), .meta = r.uintLessThan(u8, 4) == 0 }),
            7 => ui.ix.textInput(texts[r.uintLessThan(usize, texts.len)]),
            8 => {
                const id = randomNode(r, ui.doc);
                if (ui.doc.node(id).kind == .element) try ui.doc.setAttribute(id, "class", classes[r.uintLessThan(usize, classes.len)]);
            },
            9 => {
                const id = randomNode(r, ui.doc);
                const n = ui.doc.node(id);
                if (n.kind == .element and n.tag != ui.doc.atoms.html and n.tag != ui.doc.atoms.body and n.tag != ui.doc.atoms.head) ui.destroyNode(id);
            },
            10 => {
                const parent = randomNode(r, ui.doc);
                if (ui.doc.node(parent).kind == .element) {
                    const el = try ui.doc.createElement(tags[r.uintLessThan(usize, tags.len)]);
                    try ui.doc.setAttribute(el, "class", classes[r.uintLessThan(usize, classes.len)]);
                    ui.doc.appendChild(el, try ui.doc.createText(texts[r.uintLessThan(usize, texts.len)]));
                    ui.doc.appendChild(parent, el);
                }
            },
            11 => {
                const id = randomNode(r, ui.doc);
                if (ui.doc.node(id).kind == .element) ui.ix.focus(id, r.boolean());
            },
            12 => ui.ix.pointerLeaveWindow(),
            13 => {
                // move a subtree elsewhere (it keeps styles inherited from
                // its old ancestors until restyled), sometimes destroying
                // the old parent in the same frame
                const id = randomNode(r, ui.doc);
                const to = randomNode(r, ui.doc);
                const n = ui.doc.node(id);
                const old_parent = n.parent;
                if (n.tag != ui.doc.atoms.html and n.tag != ui.doc.atoms.body and n.tag != ui.doc.atoms.head and old_parent != dom.null_id and
                    ui.doc.node(to).kind == .element and !ui.doc.isInclusiveAncestor(id, to))
                {
                    ui.doc.appendChild(to, id);
                    const op = ui.doc.node(old_parent);
                    if (r.boolean() and op.tag != ui.doc.atoms.html and op.tag != ui.doc.atoms.body and op.tag != ui.doc.atoms.head and
                        !ui.doc.isInclusiveAncestor(old_parent, to)) ui.destroyNode(old_parent);
                }
            },
            else => {},
        }
        // frames at irregular intervals, sometimes several events per frame
        if (r.uintLessThan(u8, 3) != 0) {
            now += r.float(f64) * 0.08;
            ui.tick(now);
            _ = try ui.update();
            try checkInvariants(ui);
        }
    }
}

test "interaction fuzz" {
    var seed: u64 = 1;
    while (seed <= 24) : (seed += 1) {
        run(std.testing.allocator, seed, 1500) catch |err| {
            std.debug.print("interaction fuzz failed with seed {d}\n", .{seed});
            return err;
        };
    }
}

test "interaction fuzz under use-after-free guard pages" {
    var seed: u64 = 101;
    while (seed <= 104) : (seed += 1) {
        var q = Quarantine.init(std.testing.allocator);
        defer q.deinit();
        run(q.allocator(), seed, 400) catch |err| {
            std.debug.print("guarded interaction fuzz failed with seed {d}\n", .{seed});
            return err;
        };
    }
}

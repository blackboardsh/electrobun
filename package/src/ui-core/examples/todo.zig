//! A complete Zig app with a GPU-rendered UI: state is plain Zig, markup is
//! an HTML template, styling is CSS. Run: zig build todo -- --dawn <path>
const std = @import("std");
const ui = @import("electrobun_ui");

const Todo = struct {
    title: ui.Signal([]const u8) = .init(""),
    done: ui.Signal(bool) = .init(false),

    pub fn toggle(self: *Todo) void {
        self.done.set(!self.done.peek());
    }
};

const Filter = enum { all, active, completed };

const App = struct {
    draft: ui.Signal([]const u8) = .init(""),
    filter: ui.Signal(Filter) = .init(.all),
    todos: ui.List(Todo) = .{},

    pub fn init(self: *App) void {
        for ([_][]const u8{ "Bake fine-grained reactivity into the core", "Render straight to the GPU", "Ship a tiny binary" }, 0..) |t, i| {
            const item = self.todos.append(.{ .title = .init(t) }) catch return;
            if (i == 1) item.done.set(true);
        }
    }

    pub fn add(self: *App) void {
        const text = std.mem.trim(u8, self.draft.peek(), " ");
        if (text.len == 0) return;
        _ = self.todos.append(.{ .title = .init(text) }) catch return;
        self.draft.set("");
    }

    pub fn onKey(self: *App, ev: *ui.Event) void {
        if (std.mem.eql(u8, ev.key, "Enter")) self.add();
    }

    pub fn remove(self: *App, t: *Todo) void {
        self.todos.removeItem(t);
    }

    pub fn clearCompleted(self: *App) void {
        var i = self.todos.len();
        while (i > 0) {
            i -= 1;
            if (self.todos.at(i).done.peek()) self.todos.remove(i);
        }
    }

    pub fn show(self: *App, f: []const u8) void {
        self.filter.set(std.meta.stringToEnum(Filter, f) orelse .all);
    }

    pub fn remaining(self: *App) i64 {
        var n: i64 = 0;
        for (self.todos.slice()) |t| {
            if (!t.done.get()) n += 1;
        }
        return n;
    }

    pub fn total(self: *App) i64 {
        return @intCast(self.todos.len());
    }

    pub const template =
        \\<main class="app">
        \\  <header>
        \\    <h1>todos</h1>
        \\    <p class="sub">Zig state · HTML template · CSS · rendered by Dawn</p>
        \\  </header>
        \\  <div class="card">
        \\    <div class="new">
        \\      <input class="draft" placeholder="What needs to be done?" bind:value={draft} onkeydown={onKey} autofocus>
        \\      <button class="primary" onclick={add} disabled={draft.length == 0}>Add</button>
        \\    </div>
        \\    <ul class="list">
        \\      <li each={todos} as="t" class="item" class:done={t.done}
        \\          class:hidden={(filter == 'active' && t.done) || (filter == 'completed' && !t.done)}>
        \\        <label class="check"><input type="checkbox" bind:checked={t.done}><span class="box"></span></label>
        \\        <span class="title" ondblclick={t.toggle}>{t.title}</span>
        \\        <button class="remove" onclick={remove(t)} title="Remove">×</button>
        \\      </li>
        \\    </ul>
        \\    <p class="empty" if={total == 0}>Nothing to do. Enjoy the day ☀️</p>
        \\    <footer>
        \\      <span>{remaining} {remaining == 1 ? 'item' : 'items'} left</span>
        \\      <nav>
        \\        <button class:active={filter == 'all'} onclick={show('all')}>All</button>
        \\        <button class:active={filter == 'active'} onclick={show('active')}>Active</button>
        \\        <button class:active={filter == 'completed'} onclick={show('completed')}>Completed</button>
        \\      </nav>
        \\      <button class="link" onclick={clearCompleted}>Clear completed</button>
        \\    </footer>
        \\  </div>
        \\</main>
    ;

    pub const style =
        \\:root { --bg: #f4f5f9; --card: #fff; --ink: #1f2430; --muted: #8a90a2; --line: #eceef3; --brand: oklch(58% 0.2 265); }
        \\@media (prefers-color-scheme: dark) { :root { --bg: #0f1117; --card: #171a22; --ink: #e8eaf0; --muted: #7c8296; --line: #232733; } }
        \\* { box-sizing: border-box; }
        \\body { margin: 0; background: var(--bg); color: var(--ink); font: 15px system-ui; }
        \\.app { max-width: 560px; margin: 0 auto; padding: 40px 20px; }
        \\h1 { margin: 0; font-size: 44px; font-weight: 800; letter-spacing: -1.5px; color: var(--brand); }
        \\.sub { margin: 4px 0 20px; color: var(--muted); font-size: 13px; }
        \\.card { background: var(--card); border-radius: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 12px 32px rgba(20,24,40,.08); overflow: hidden; }
        \\.new { display: flex; gap: 10px; padding: 16px; border-bottom: 1px solid var(--line); }
        \\.draft { flex: 1; width: auto; font-size: 15px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--ink); }
        \\.draft:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
        \\button { font: inherit; cursor: pointer; }
        \\.primary { background: var(--brand); color: white; border: none; border-radius: 10px; padding: 0 18px; font-weight: 600; transition: opacity .15s, transform .15s; }
        \\.primary:hover { transform: translateY(-1px); }
        \\.primary:disabled { opacity: .45; cursor: default; transform: none; }
        \\.list { list-style: none; margin: 0; padding: 0; }
        \\.item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); transition: background-color .15s; }
        \\.item:hover { background: color-mix(in srgb, var(--bg) 60%, transparent); background: rgba(99,102,241,.04); }
        \\.item.hidden { display: none; }
        \\.check { position: relative; width: 20px; height: 20px; }
        \\.check input { position: absolute; inset: 0; width: 20px; height: 20px; margin: 0; opacity: 0; }
        \\.box { position: absolute; inset: 0; border: 2px solid #c5c9d6; border-radius: 6px; transition: background-color .15s, border-color .15s; pointer-events: none; }
        \\.done .box { background: var(--brand); border-color: var(--brand); }
        \\.done .box::after { content: ""; position: absolute; left: 5px; top: 1px; width: 5px; height: 10px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
        \\.title { flex: 1; transition: color .2s; }
        \\.done .title { color: var(--muted); text-decoration: line-through; }
        \\.remove { opacity: 0; border: none; background: transparent; color: #e5484d; font-size: 20px; line-height: 1; padding: 0 4px; transition: opacity .15s; }
        \\.item:hover .remove { opacity: 1; }
        \\.empty { text-align: center; color: var(--muted); padding: 28px; margin: 0; }
        \\footer { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; font-size: 13px; color: var(--muted); }
        \\nav { display: flex; gap: 4px; }
        \\nav button { border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: 8px; padding: 4px 10px; }
        \\nav button:hover { border-color: var(--line); }
        \\nav button.active { border-color: var(--brand); color: var(--brand); }
        \\.link { border: none; background: none; color: var(--muted); padding: 0; }
        \\.link:hover { color: var(--ink); text-decoration: underline; }
    ;
};

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    var args = try init.minimal.args.iterateAllocator(gpa);
    defer args.deinit();
    _ = args.next();
    var dawn: []const u8 = "libwebgpu_dawn.dylib";
    var shot: ?[]const u8 = null;
    while (args.next()) |a| {
        if (std.mem.eql(u8, a, "--dawn")) dawn = args.next() orelse return error.Usage;
        if (std.mem.eql(u8, a, "--shot")) shot = args.next() orelse return error.Usage;
    }
    const u = try ui.Ui.create(gpa, .{});
    defer u.destroy();
    var app = App{};
    const mounted = try ui.mount(App, u, &app);
    defer mounted.destroy();
    var shot_state = Shot{ .path = shot };
    const win = try ui.host_macos.Window.create(gpa, init.io, u, .{ .title = "Todos", .width = 640, .height = 620, .dawn_path = dawn, .on_frame = Shot.onFrame, .ctx = &shot_state });
    win.run();
}

const Shot = struct {
    path: ?[]const u8,
    done: bool = false,
    fn onFrame(ctx: ?*anyopaque, win: *ui.host_macos.Window) void {
        const s: *Shot = @ptrCast(@alignCast(ctx.?));
        const p = s.path orelse return;
        if (win.frames >= 1 and !s.done) {
            s.done = true;
            win.screenshot(p) catch {};
            std.process.exit(0);
        }
    }
};

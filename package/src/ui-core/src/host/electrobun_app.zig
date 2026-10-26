//! Zig apps in Electrobun windows: mount a comptime app (state struct with
//! Signal/List fields, methods as handlers, `template` and optional `style`)
//! into an Electrobun WGPU view, in-process.
//!
//!   var state = App{};
//!   const ui = try electrobun_ui.electrobun.mountApp(App, &state, .{
//!       .view = try core.getWGPUViewPointer(view_id),
//!       .dawn_path = dawn_path,
//!   });
//!
//! Handlers and event listeners run on the main thread with the UI locked.
//! Mutate state from any other thread inside `ui.lock()` / `ui.unlock()`;
//! unlocking schedules a frame.
const std = @import("std");
const capi = @import("../capi.zig");
const app = @import("../app.zig");
const ui_mod = @import("../ui.zig");
const host = @import("electrobun.zig");

pub const MountOptions = struct {
    /// the WGPU view's native pointer (AbstractView*), e.g. Core.getWGPUViewPointer
    view: *anyopaque,
    /// path to libwebgpu_dawn; null uses the platform default search
    dawn_path: ?[:0]const u8 = null,
    /// add the built-in eb-* component stylesheet
    components: bool = false,
    /// extra stylesheets, applied after `T.style`
    css: []const []const u8 = &.{},
    /// force the color scheme (null follows the system)
    dark: ?bool = null,
    /// the window or view is alpha-composited: with no html/body background
    /// the canvas stays transparent instead of white
    transparent: bool = false,
};

pub const Error = error{ CreateFailed, AttachFailed, MountFailed };

pub fn Mounted(comptime T: type) type {
    return struct {
        const Self = @This();
        id: u32,
        inner: *app.Mounted(T),

        /// Take the UI lock before touching state from a non-main thread.
        pub fn lock(_: Self) void {
            capi.lock();
        }

        /// Release the lock; schedules a frame if anything changed.
        pub fn unlock(_: Self) void {
            capi.unlock();
        }

        pub fn ui(self: Self) *ui_mod.Ui {
            return self.inner.ui;
        }

        pub fn setDark(self: Self, dark: bool) void {
            capi.lock();
            defer capi.unlock();
            self.inner.ui.setColorScheme(dark);
            self.inner.ui.doc.markAllStyleDirty();
        }

        pub fn destroy(self: Self) void {
            host.ebui_detach_view(self.id);
            capi.lock();
            self.inner.destroy();
            capi.unlock();
            capi.ebui_destroy(self.id);
        }
    };
}

/// Create a UI instance, attach it to `opts.view`, and mount `state`.
pub fn mountApp(comptime T: type, state: *T, opts: MountOptions) Error!Mounted(T) {
    const id = capi.ebui_create();
    if (id == 0) return error.CreateFailed;
    errdefer capi.ebui_destroy(id);
    // before attaching: the host picks how to present from it at the first frame
    if (opts.transparent) capi.ebui_set_transparent(id, true);
    if (!host.ebui_attach_wgpu_view(id, opts.view, if (opts.dawn_path) |p| p.ptr else null)) return error.AttachFailed;
    errdefer host.ebui_detach_view(id);

    capi.lock();
    defer capi.unlock();
    const ui = capi.engine(id) orelse return error.CreateFailed;
    if (opts.components) _ = ui.doc.addStylesheet(ui_mod.Ui.components_css) catch return error.MountFailed;
    if (opts.dark) |d| ui.setColorScheme(d);
    const inner = app.mount(T, ui, state) catch return error.MountFailed;
    // app stylesheets come after the component sheet and T.style
    for (opts.css) |css| _ = ui.doc.addStylesheet(css) catch return error.MountFailed;
    return .{ .id = id, .inner = inner };
}

test "mountApp type-checks for a comptime app" {
    const Counter = struct {
        count: app.Signal(i64) = .init(0),
        pub fn inc(self: *@This()) void {
            self.count.set(self.count.peek() + 1);
        }
        pub const template = "<button onclick={inc}>{count}</button>";
    };
    // compile-only: attaching needs a live Electrobun WGPU view
    if (false) {
        var s = Counter{};
        const m = try mountApp(Counter, &s, .{ .view = undefined });
        m.lock();
        m.unlock();
        m.setDark(true);
        m.destroy();
    }
}

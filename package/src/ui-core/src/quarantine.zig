//! Use-after-free detector for tests. Every allocation gets its own pages;
//! freeing makes them inaccessible (PROT_NONE) and parks them until `deinit`,
//! so the address is never reused and any read through a dangling pointer
//! faults at the faulty line. A general-purpose allocator instead hands the
//! block to the next allocation, and the stale read silently sees new data
//! (or, in release builds, crashes somewhere else much later).
//!
//! Where mprotect is unavailable (Windows), freed blocks are poisoned with
//! 0xaa and parked instead. Live blocks at `deinit` are reported as leaks.
const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Alignment = std.mem.Alignment;

const can_protect = builtin.os.tag != .windows and builtin.link_libc;

pub const Quarantine = struct {
    pages: Allocator = std.heap.page_allocator,
    /// bookkeeping (not quarantined)
    meta: Allocator,
    live: std.AutoHashMapUnmanaged(usize, usize) = .empty,
    parked: std.ArrayList([]align(std.heap.page_size_min) u8) = .empty,

    pub fn init(meta: Allocator) Quarantine {
        return .{ .meta = meta };
    }

    pub fn deinit(q: *Quarantine) void {
        const leaked = q.live.count();
        for (q.parked.items) |p| {
            if (can_protect) protect(p, true);
            q.pages.free(p);
        }
        q.parked.deinit(q.meta);
        var it = q.live.iterator();
        while (it.next()) |kv| q.pages.free(blockOf(kv.key_ptr.*, kv.value_ptr.*));
        q.live.deinit(q.meta);
        if (leaked != 0) std.debug.panic("Quarantine: {d} allocation(s) leaked", .{leaked});
    }

    pub fn allocator(q: *Quarantine) Allocator {
        return .{ .ptr = q, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn blockOf(addr: usize, len: usize) []align(std.heap.page_size_min) u8 {
        const ptr: [*]align(std.heap.page_size_min) u8 = @ptrFromInt(addr);
        return ptr[0..std.mem.alignForward(usize, @max(len, 1), std.heap.pageSize())];
    }

    fn protect(block: []align(std.heap.page_size_min) u8, accessible: bool) void {
        var prot = std.mem.zeroes(std.c.PROT);
        if (accessible) {
            prot.READ = true;
            prot.WRITE = true;
        }
        _ = std.c.mprotect(@ptrCast(block.ptr), block.len, prot);
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: Alignment, _: usize) ?[*]u8 {
        const q: *Quarantine = @ptrCast(@alignCast(ctx));
        if (alignment.toByteUnits() > std.heap.pageSize()) return null;
        q.live.ensureUnusedCapacity(q.meta, 1) catch return null;
        const block = q.pages.alignedAlloc(u8, .fromByteUnits(std.heap.page_size_min), std.mem.alignForward(usize, @max(len, 1), std.heap.pageSize())) catch return null;
        q.live.putAssumeCapacity(@intFromPtr(block.ptr), len);
        return block.ptr;
    }

    fn resize(ctx: *anyopaque, mem: []u8, _: Alignment, new_len: usize, _: usize) bool {
        const q: *Quarantine = @ptrCast(@alignCast(ctx));
        // in place within the block's pages only; shrinking keeps the pages
        if (std.mem.alignForward(usize, @max(new_len, 1), std.heap.pageSize()) > std.mem.alignForward(usize, @max(mem.len, 1), std.heap.pageSize())) return false;
        q.live.getPtr(@intFromPtr(mem.ptr)).?.* = new_len;
        return true;
    }

    fn remap(ctx: *anyopaque, mem: []u8, alignment: Alignment, new_len: usize, ra: usize) ?[*]u8 {
        return if (resize(ctx, mem, alignment, new_len, ra)) mem.ptr else null;
    }

    fn free(ctx: *anyopaque, mem: []u8, _: Alignment, _: usize) void {
        const q: *Quarantine = @ptrCast(@alignCast(ctx));
        const kv = q.live.fetchRemove(@intFromPtr(mem.ptr)) orelse std.debug.panic("Quarantine: invalid or double free of {*}", .{mem.ptr});
        const block = blockOf(kv.key, kv.value);
        @memset(block, 0xaa);
        if (can_protect) protect(block, false);
        q.parked.append(q.meta, block) catch {
            if (can_protect) protect(block, true);
            q.pages.free(block);
        };
    }
};

test "quarantine catches nothing on correct use and frees everything" {
    var q = Quarantine.init(std.testing.allocator);
    defer q.deinit();
    const a = q.allocator();
    var list: std.ArrayList(u32) = .empty;
    defer list.deinit(a);
    for (0..5000) |i| try list.append(a, @intCast(i));
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    _ = try arena.allocator().alloc(u8, 100_000);
    try std.testing.expectEqual(@as(u32, 4999), list.items[4999]);
}

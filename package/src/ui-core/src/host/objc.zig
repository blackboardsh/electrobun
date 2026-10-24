//! Minimal Objective-C runtime helpers for driving AppKit from Zig.
const std = @import("std");
const builtin = @import("builtin");

pub const id = ?*anyopaque;
pub const SEL = ?*anyopaque;
pub const Class = ?*anyopaque;
pub const IMP = *const anyopaque;
pub const BOOL = bool;

pub extern "c" fn objc_getClass(name: [*:0]const u8) Class;
pub extern "c" fn objc_getProtocol(name: [*:0]const u8) ?*anyopaque;
pub extern "c" fn sel_registerName(name: [*:0]const u8) SEL;
pub extern "c" fn objc_msgSend() void;
pub extern "c" fn objc_msgSend_stret() void;
pub extern "c" fn objc_allocateClassPair(superclass: Class, name: [*:0]const u8, extra: usize) Class;
pub extern "c" fn objc_registerClassPair(cls: Class) void;
pub extern "c" fn class_addMethod(cls: Class, name: SEL, imp: IMP, types: [*:0]const u8) bool;
pub extern "c" fn class_addProtocol(cls: Class, protocol: ?*anyopaque) bool;
pub extern "c" fn class_addIvar(cls: Class, name: [*:0]const u8, size: usize, alignment: u8, types: [*:0]const u8) bool;
pub extern "c" fn object_setInstanceVariable(obj: id, name: [*:0]const u8, value: ?*anyopaque) ?*anyopaque;
pub extern "c" fn object_getInstanceVariable(obj: id, name: [*:0]const u8, out: *?*anyopaque) ?*anyopaque;
pub extern "c" fn objc_autoreleasePoolPush() ?*anyopaque;
pub extern "c" fn objc_autoreleasePoolPop(pool: ?*anyopaque) void;

pub fn class(name: [*:0]const u8) Class {
    return objc_getClass(name);
}

pub fn sel(name: [*:0]const u8) SEL {
    return sel_registerName(name);
}

/// Send a message with a statically typed signature.
pub fn msg(comptime Ret: type, target: anytype, selector: [*:0]const u8, args: anytype) Ret {
    const ArgsT = @TypeOf(args);
    const use_stret = builtin.cpu.arch == .x86_64 and @sizeOf(Ret) > 16;
    const target_ptr: ?*anyopaque = switch (@typeInfo(@TypeOf(target))) {
        .optional => @ptrCast(target),
        .pointer => @ptrCast(target),
        else => @compileError("target must be a pointer"),
    };
    const s = sel(selector);
    if (use_stret) {
        const Fn = FnType(void, ArgsT, true, Ret);
        const f: Fn = @ptrCast(&objc_msgSend_stret);
        var out: Ret = undefined;
        @call(.auto, f, .{ &out, target_ptr, s } ++ args);
        return out;
    }
    const Fn = FnType(Ret, ArgsT, false, Ret);
    const f: Fn = @ptrCast(&objc_msgSend);
    return @call(.auto, f, .{ target_ptr, s } ++ args);
}

fn FnType(comptime Ret: type, comptime ArgsT: type, comptime stret: bool, comptime StretT: type) type {
    const info = @typeInfo(ArgsT).@"struct";
    const n = info.field_types.len;
    if (stret) {
        var params: [n + 3]type = undefined;
        params[0] = *StretT;
        params[1] = ?*anyopaque;
        params[2] = SEL;
        for (info.field_types, 0..) |t, i| params[i + 3] = t;
        return *const @Fn(&params, &@splat(.{}), void, .{ .@"callconv" = .c });
    }
    var params: [n + 2]type = undefined;
    params[0] = ?*anyopaque;
    params[1] = SEL;
    for (info.field_types, 0..) |t, i| params[i + 2] = t;
    return *const @Fn(&params, &@splat(.{}), Ret, .{ .@"callconv" = .c });
}

pub fn nsString(s: []const u8) id {
    const NSString = class("NSString");
    const obj = msg(id, NSString, "alloc", .{});
    return msg(id, obj, "initWithBytes:length:encoding:", .{ @as(?*const anyopaque, s.ptr), @as(usize, s.len), @as(usize, 4) });
}

pub fn nsStringZ(s: [*:0]const u8) id {
    return msg(id, class("NSString"), "stringWithUTF8String:", .{s});
}

pub fn utf8(str: id) []const u8 {
    if (str == null) return "";
    const p = msg(?[*:0]const u8, str, "UTF8String", .{}) orelse return "";
    return std.mem.span(p);
}

pub const CGPoint = extern struct { x: f64, y: f64 };
pub const CGSize = extern struct { width: f64, height: f64 };
pub const CGRect = extern struct { origin: CGPoint, size: CGSize };
pub const NSRange = extern struct { location: usize, length: usize };

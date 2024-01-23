const std = @import("std");
const assert = std.debug.assert;
const c = @import("c.zig");
const objc = @import("main.zig");
const MsgSend = @import("msg_send.zig").MsgSend;

pub const Class = struct {
    value: c.Class,
    pub usingnamespace MsgSend(Class);

    // Returns a property with a given name of a given class.
    pub fn getProperty(self: Class, name: [:0]const u8) ?objc.Property {
        return objc.Property{
            .value = c.class_getProperty(self.value, name.ptr) orelse return null,
        };
    }

    /// Describes the properties declared by a class. This must be freed.
    pub fn copyPropertyList(self: Class) []objc.Property {
        var count: c_uint = undefined;
        const list = @as([*c]objc.Property, @ptrCast(c.class_copyPropertyList(self.value, &count)));
        if (count == 0) return list[0..0];
        return list[0..count];
    }

    /// Describes the protocols adopted by a class. This must be freed.
    pub fn copyProtocolList(self: Class) []objc.Protocol {
        var count: c_uint = undefined;
        const list = @as([*c]objc.Protocol, @ptrCast(c.class_copyProtocolList(self.value, &count)));
        if (count == 0) return list[0..0];
        return list[0..count];
    }

    pub fn isMetaClass(self: Class) bool {
        return c.class_isMetaClass(self.value) == 1;
    }

    pub fn getInstanceSize(self: Class) usize {
        return c.class_getInstanceSize(self.value);
    }

    pub fn respondsToSelector(self: Class, sel: objc.Sel) bool {
        return c.class_respondsToSelector(self.value, sel.value) == 1;
    }

    pub fn conformsToProtocol(self: Class, protocol: objc.Protocol) bool {
        return c.class_conformsToProtocol(self.value, &protocol.value) == 1;
    }

    // currently only allows for overriding methods previously defined, e.g. by a superclass.
    // imp should be a function with C calling convention
    // whose first two arguments are a `c.id` and a `c.SEL`.
    pub fn replaceMethod(self: Class, name: [:0]const u8, imp: anytype) void {
        const fn_info = @typeInfo(@TypeOf(imp)).Fn;
        assert(fn_info.calling_convention == .C);
        assert(fn_info.is_var_args == false);
        assert(fn_info.params.len >= 2);
        assert(fn_info.params[0].type == c.id);
        assert(fn_info.params[1].type == c.SEL);
        _ = c.class_replaceMethod(self.value, objc.sel(name).value, @ptrCast(&imp), null);
    }

    /// allows adding new methods; returns true on success.
    // imp should be a function with C calling convention
    // whose first two arguments are a `c.id` and a `c.SEL`.
    pub fn addMethod(self: Class, name: [:0]const u8, imp: anytype) !bool {
        const Fn = @TypeOf(imp);
        const fn_info = @typeInfo(Fn).Fn;
        assert(fn_info.calling_convention == .C);
        assert(fn_info.is_var_args == false);
        assert(fn_info.params.len >= 2);
        assert(fn_info.params[0].type == c.id);
        assert(fn_info.params[1].type == c.SEL);
        const encoding = comptime objc.comptimeEncode(Fn);
        return c.boolResult(@TypeOf(c.class_addMethod), c.class_addMethod(
            self.value,
            objc.sel(name).value,
            @ptrCast(&imp),
            encoding.ptr,
        ));
    }

    // only call this function between allocateClassPair and registerClassPair
    // this adds an Ivar of type `id`.
    pub fn addIvar(self: Class, name: [:0]const u8) bool {
        // The return type is i8 when we're cross compiling, unsure why.
        const result = c.class_addIvar(self.value, name, @sizeOf(c.id), @alignOf(c.id), "@");
        return c.boolResult(@TypeOf(c.class_addIvar), result);
    }
};

pub fn getClass(name: [:0]const u8) ?Class {
    return .{ .value = c.objc_getClass(name.ptr) orelse return null };
}

pub fn getMetaClass(name: [:0]const u8) ?Class {
    return .{ .value = c.objc_getMetaClass(name) orelse return null };
}

// begin by calling this function, then call registerClassPair on the result when you are finished
pub fn allocateClassPair(superclass: ?Class, name: [:0]const u8) ?Class {
    return .{ .value = c.objc_allocateClassPair(
        if (superclass) |cls| cls.value else null,
        name.ptr,
        0,
    ) orelse return null };
}

pub fn registerClassPair(class: Class) void {
    c.objc_registerClassPair(class.value);
}

pub fn disposeClassPair(class: Class) void {
    c.objc_disposeClassPair(class.value);
}

test "getClass" {
    const testing = std.testing;
    const NSObject = getClass("NSObject");
    try testing.expect(NSObject != null);
    try testing.expect(getClass("NoWay") == null);
}

test "msgSend" {
    const testing = std.testing;
    const NSObject = getClass("NSObject").?;

    // Should work with primitives
    const id = NSObject.msgSend(c.id, "alloc", .{});
    try testing.expect(id != null);
    {
        const obj: objc.Object = .{ .value = id };
        obj.msgSend(void, "dealloc", .{});
    }

    // Should work with our wrappers
    const obj = NSObject.msgSend(objc.Object, "alloc", .{});
    try testing.expect(obj.value != null);
    obj.msgSend(void, "dealloc", .{});
}

test "getProperty" {
    const testing = std.testing;
    const NSObject = getClass("NSObject").?;

    try testing.expect(NSObject.getProperty("className") != null);
    try testing.expect(NSObject.getProperty("nope") == null);
}

test "copyProperyList" {
    const testing = std.testing;
    const NSObject = getClass("NSObject").?;

    const list = NSObject.copyPropertyList();
    defer objc.free(list);
    try testing.expect(list.len > 0);
}

test "allocatecClassPair and replaceMethod" {
    const testing = std.testing;
    const NSObject = getClass("NSObject").?;
    var my_object = allocateClassPair(NSObject, "my_object").?;
    my_object.replaceMethod("hash", struct {
        fn inner(target: c.id, sel: c.SEL) callconv(.C) u64 {
            _ = sel;
            _ = target;
            return 69;
        }
    }.inner);
    registerClassPair(my_object);
    defer disposeClassPair(my_object);
    const object: objc.Object = .{
        .value = my_object.msgSend(c.id, "alloc", .{}),
    };
    defer object.msgSend(void, "dealloc", .{});
    try testing.expectEqual(@as(u64, 69), object.msgSend(u64, "hash", .{}));
}

test "Ivars" {
    const testing = std.testing;
    const NSObject = getClass("NSObject").?;
    var my_object = allocateClassPair(NSObject, "my_object").?;
    try testing.expectEqual(true, my_object.addIvar("my_ivar"));
    registerClassPair(my_object);
    defer disposeClassPair(my_object);
    const object: objc.Object = .{
        .value = my_object.msgSend(c.id, "alloc", .{}),
    };
    defer object.msgSend(void, "dealloc", .{});
    const NSString = getClass("NSString").?;
    const my_string = NSString.msgSend(objc.Object, "stringWithUTF8String:", .{"69---nice"});
    defer my_string.msgSend(void, "dealloc", .{});
    object.setInstanceVariable("my_ivar", my_string);
    const my_ivar = object.getInstanceVariable("my_ivar");
    const slice = std.mem.sliceTo(my_ivar.getProperty([*c]const u8, "UTF8String"), 0);
    try testing.expectEqualSlices(u8, "69---nice", slice);
}

test "addMethod" {
    const testing = std.testing;
    const My_Class = setup: {
        const My_Class = allocateClassPair(objc.getClass("NSObject").?, "my_class").?;
        defer registerClassPair(My_Class);
        std.debug.assert(try My_Class.addMethod("my_addition", struct {
            fn imp(target: objc.c.id, sel: objc.c.SEL, a: i32, b: i32) callconv(.C) i32 {
                _ = sel;
                _ = target;
                return a + b;
            }
        }.imp));
        break :setup My_Class;
    };
    const result = My_Class.msgSend(objc.Object, "alloc", .{})
        .msgSend(objc.Object, "init", .{})
        .msgSend(i32, "my_addition", .{ @as(i32, 2), @as(i32, 3) });
    try testing.expectEqual(@as(i32, 5), result);
}

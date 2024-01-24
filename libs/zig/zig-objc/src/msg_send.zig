const std = @import("std");
const builtin = @import("builtin");
const assert = std.debug.assert;
const c = @import("c.zig");
const objc = @import("main.zig");

/// Returns a struct that implements the msgSend function for type T.
/// This is meant to be used with `usingnamespace` to add dispatch
/// capability to a type that supports it.
pub fn MsgSend(comptime T: type) type {
    // 1. T should be a struct
    // 2. T should have a field "value" that can be an "id" (same size)

    return struct {
        /// Invoke a selector on the target, i.e. an instance method on an
        /// object or a class method on a class. The args should be a tuple.
        pub fn msgSend(
            target: T,
            comptime Return: type,
            sel_raw: anytype,
            args: anytype,
        ) Return {
            // Our one special-case: If the return type is our own Object
            // type then we wrap it.
            const is_object = Return == objc.Object;

            // Our actual return value is an "id" if we are using one of
            // our built-in types (see above). Otherwise, we trust the caller.
            const RealReturn = if (is_object) c.id else Return;

            // We accept multiple types for sel but we need to turn it into
            // an objc.sel ultimately.
            const sel: objc.Sel = switch (@TypeOf(sel_raw)) {
                objc.Sel => sel_raw,
                else => objc.sel(sel_raw),
            };

            // Build our function type and call it
            const Fn = MsgSendFn(RealReturn, @TypeOf(target.value), @TypeOf(args));
            const msg_send_fn = comptime msgSendPtr(RealReturn, false);
            const msg_send_ptr: *const Fn = @ptrCast(msg_send_fn);
            const result = @call(.auto, msg_send_ptr, .{ target.value, sel.value } ++ args);

            if (!is_object) return result;
            return .{ .value = result };
        }

        /// Invoke a selector on the superclass.
        pub fn msgSendSuper(
            target: T,
            superclass: objc.Class,
            comptime Return: type,
            sel_raw: anytype,
            args: anytype,
        ) Return {
            // See msgSend for in depth comments on all of this. This is
            // effectively the same logic.
            const is_object = Return == objc.Object;
            const RealReturn = if (is_object) c.id else Return;
            const sel: objc.Sel = switch (@TypeOf(sel_raw)) {
                objc.Sel => sel_raw,
                else => objc.sel(sel_raw),
            };

            const Fn = MsgSendFn(RealReturn, *c.objc_super, @TypeOf(args));
            const msg_send_fn = comptime msgSendPtr(RealReturn, true);
            const msg_send_ptr: *const Fn = @ptrCast(msg_send_fn);
            var super: c.objc_super = .{
                .receiver = target.value,
                .super_class = superclass.value,
            };
            const result = @call(.auto, msg_send_ptr, .{ &super, sel.value } ++ args);

            if (!is_object) return result;
            return .{ .value = result };
        }

        /// Returns the objc_msgSend or objc_msgSendSuper pointer for the
        /// given return type.
        fn msgSendPtr(
            comptime Return: type,
            comptime super: bool,
        ) *const fn () callconv(.C) void {
            // See objc/message.h. The high-level is that depending on the
            // target architecture and return type, we must use a different
            // objc_msgSend function.
            return switch (builtin.target.cpu.arch) {
                // Aarch64 uses objc_msgSend for everything. Hurray!
                .aarch64 => if (super) &c.objc_msgSendSuper else &c.objc_msgSend,

                // x86_64 depends on the return type...
                .x86_64 => switch (@typeInfo(Return)) {
                    // Most types use objc_msgSend
                    inline .Int,
                    .Bool,
                    .Enum,
                    .Pointer,
                    .Void,
                    => if (super) &c.objc_msgSendSuper else &c.objc_msgSend,

                    .Optional => |opt| opt: {
                        assert(@typeInfo(opt.child) == .Pointer);
                        break :opt if (super) &c.objc_msgSendSuper else &c.objc_msgSend;
                    },

                    // Structs must use objc_msgSend_stret.
                    // NOTE: This is probably WAY more complicated... we only
                    // call this if the struct is NOT returned as a register.
                    // And that depends on the size of the struct. But I don't
                    // know what the breakpoint actually is for that. This SO
                    // answer says 16 bytes so I'm going to use that but I have
                    // no idea...
                    .Struct => blk: {
                        if (@sizeOf(Return) > 16) {
                            break :blk if (super)
                                &c.objc_msgSendSuper_stret
                            else
                                &c.objc_msgSend_stret;
                        } else {
                            break :blk if (super)
                                &c.objc_msgSendSuper
                            else
                                &c.objc_msgSend;
                        }
                    },

                    // Floats use objc_msgSend_fpret for f64 on x86_64,
                    // but normal msgSend for other bit sizes. i386 has
                    // more complex rules but we don't support i386 at the time
                    // of this comment and probably never will since all i386
                    // Apple models are discontinued at this point.
                    .Float => |float| switch (float.bits) {
                        64 => if (super) &c.objc_msgSendSuper_fpret else &c.objc_msgSend_fpret,
                        else => if (super) &c.objc_msgSendSuper else &c.objc_msgSend,
                    },

                    // Otherwise we log in case we need to add a new case above
                    else => {
                        @compileLog(@typeInfo(Return));
                        @compileError("unsupported return type for objc runtime on x86_64");
                    },
                },

                else => @compileError("unsupported objc architecture"),
            };
        }
    };
}

/// This returns a function body type for `obj_msgSend` that matches
/// the given return type, target type, and arguments tuple type.
///
/// obj_msgSend is a really interesting function, because it doesn't act
/// like a typical function. You have to call it with the C ABI as if you're
/// calling the true target function, not as a varargs C function. Therefore
/// you have to cast obj_msgSend to a function pointer type of the final
/// destination function, then call that.
///
/// Example: you have an ObjC function like this:
///
///     @implementation Foo
///     - (void)log: (float)x { /* stuff */ }
///
/// If you call it like this, it won't work (you'll get garbage):
///
///     objc_msgSend(obj, @selector(log:), (float)PI);
///
/// You have to call it like this:
///
///     ((void (*)(id, SEL, float))objc_msgSend)(obj, @selector(log:), M_PI);
///
/// This comptime function returns the function body type that can be used
/// to cast and call for the proper C ABI behavior.
fn MsgSendFn(
    comptime Return: type,
    comptime Target: type,
    comptime Args: type,
) type {
    const argsInfo = @typeInfo(Args).Struct;
    assert(argsInfo.is_tuple);

    // Target must always be an "id". Lots of types (Class, Object, etc.)
    // are an "id" so we just make sure the sizes match for ABI reasons.
    assert(@sizeOf(Target) == @sizeOf(c.id));

    // Build up our argument types.
    const Fn = std.builtin.Type.Fn;
    const params: []Fn.Param = params: {
        var acc: [argsInfo.fields.len + 2]Fn.Param = undefined;

        // First argument is always the target and selector.
        acc[0] = .{ .type = Target, .is_generic = false, .is_noalias = false };
        acc[1] = .{ .type = c.SEL, .is_generic = false, .is_noalias = false };

        // Remaining arguments depend on the args given, in the order given
        for (argsInfo.fields, 0..) |field, i| {
            acc[i + 2] = .{
                .type = field.type,
                .is_generic = false,
                .is_noalias = false,
            };
        }

        break :params &acc;
    };

    // Copy the alignment of a normal function type so equality works
    // (mainly for tests, I don't think this has any consequence otherwise)
    const alignment = @typeInfo(fn () callconv(.C) void).Fn.alignment;

    return @Type(.{
        .Fn = .{
            .calling_convention = .C,
            .alignment = alignment,
            .is_generic = false,
            .is_var_args = false,
            .return_type = Return,
            .params = params,
        },
    });
}

test {
    // https://github.com/ziglang/zig/issues/12360
    if (true) return error.SkipZigTest;

    const testing = std.testing;
    try testing.expectEqual(fn (
        u8,
        objc.Sel,
    ) callconv(.C) u64, MsgSendFn(u64, u8, @TypeOf(.{})));
    try testing.expectEqual(fn (u8, objc.Sel, u16, u32) callconv(.C) u64, MsgSendFn(u64, u8, @TypeOf(.{
        @as(u16, 0),
        @as(u32, 0),
    })));
}

test "subClass" {
    const Subclass = objc.allocateClassPair(objc.getClass("NSObject").?, "subclass").?;
    defer objc.disposeClassPair(Subclass);
    const str = struct {
        fn inner(target: objc.c.id, sel: objc.c.SEL) callconv(.C) objc.c.id {
            _ = sel;
            const self = objc.Object.fromId(target);
            self.msgSendSuper(objc.getClass("NSObject").?, void, "init", .{});
            return target;
        }
    };
    Subclass.replaceMethod("init", str.inner);
    objc.registerClassPair(Subclass);
    const subclass_obj = Subclass.msgSend(objc.Object, "alloc", .{});
    defer subclass_obj.msgSend(void, "dealloc", .{});
    subclass_obj.msgSend(void, "init", .{});
}

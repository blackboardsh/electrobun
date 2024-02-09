const std = @import("std");
const assert = std.debug.assert;
const objc = @import("main.zig");

// We have to use the raw C allocator for all heap allocation in here
// because the objc runtime expects `malloc` to be used. If you don't use
// malloc you'll get segfaults because the objc runtime will try to free
// the memory with `free`.
const alloc = std.heap.raw_c_allocator;

/// Creates a new block type with captured (closed over) values.
///
/// The CapturesArg is the a struct of captured values that will become
/// available to the block. The Args is a tuple of types that are additional
/// invocation-time arguments to the function. The Return param is the return
/// type of the function.
///
/// The function that must be implemented is available as the `Fn` field.
/// The first argument to the function is always a pointer to the `Context`
/// type (see field in the struct). This has the captured values.
///
/// The captures struct is always available as the `Captures` field which
/// makes it easy to use an inline type definition for the argument and
/// reference the type in a named fashion later.
///
/// The returned block type can be initialized and invoked multiple times
/// for different captures and arguments.
///
/// See the tests for an example.
pub fn Block(
    comptime CapturesArg: type,
    comptime Args: anytype,
    comptime Return: type,
) type {
    return struct {
        const Self = @This();
        const captures_info = @typeInfo(Captures).Struct;
        const InvokeFn = FnType(anyopaque);
        const descriptor: Descriptor = .{
            .reserved = 0,
            .size = @sizeOf(Context),
            .copy_helper = &descCopyHelper,
            .dispose_helper = &descDisposeHelper,
            .signature = objc.comptimeEncode(InvokeFn).ptr,
        };

        /// This is the function type that is called back.
        pub const Fn = FnType(Context);

        /// The captures type, so it can be easily referenced again.
        pub const Captures = CapturesArg;

        /// This is the block context sent as the first paramter to the function.
        pub const Context = BlockContext(Captures, InvokeFn);

        /// The context for the block invocations.
        context: *Context,

        /// Create a new block. This is always created on the heap using the
        /// libc allocator because the objc runtime expects `malloc` to be
        /// used.
        pub fn init(captures: Captures, func: *const Fn) !Self {
            var ctx = try alloc.create(Context);
            errdefer alloc.destroy(ctx);

            const flags: BlockFlags = .{ .stret = @typeInfo(Return) == .Struct };
            ctx.isa = NSConcreteStackBlock;
            ctx.flags = @bitCast(flags);
            ctx.invoke = @ptrCast(func);
            ctx.descriptor = &descriptor;
            inline for (captures_info.fields) |field| {
                @field(ctx, field.name) = @field(captures, field.name);
            }

            return .{ .context = ctx };
        }

        pub fn deinit(self: *Self) void {
            alloc.destroy(self.context);
            self.* = undefined;
        }

        /// Invoke the block with the given arguments. The arguments are
        /// the arguments to pass to the function beyond the captured scope.
        pub fn invoke(self: *const Self, args: anytype) Return {
            return @call(.auto, self.context.invoke, .{self.context} ++ args);
        }

        fn descCopyHelper(src: *anyopaque, dst: *anyopaque) callconv(.C) void {
            const real_src: *Context = @ptrCast(@alignCast(src));
            const real_dst: *Context = @ptrCast(@alignCast(dst));
            inline for (captures_info.fields) |field| {
                if (field.type == objc.c.id) {
                    _Block_object_assign(
                        @field(real_dst, field.name),
                        @field(real_src, field.name),
                        3,
                    );
                }
            }
        }

        fn descDisposeHelper(src: *anyopaque) callconv(.C) void {
            const real_src: *Context = @ptrCast(@alignCast(src));
            inline for (captures_info.fields) |field| {
                if (field.type == objc.c.id) {
                    _Block_object_dispose(@field(real_src, field.name), 3);
                }
            }
        }

        /// Creates a function type for the invocation function, but alters
        /// the first arg. The first arg is a pointer so from an ABI perspective
        /// this is always the same and can be safely casted.
        fn FnType(comptime ContextArg: type) type {
            var params: [Args.len + 1]std.builtin.Type.Fn.Param = undefined;
            params[0] = .{ .is_generic = false, .is_noalias = false, .type = *const ContextArg };
            for (Args, 1..) |Arg, i| {
                params[i] = .{ .is_generic = false, .is_noalias = false, .type = Arg };
            }

            return @Type(.{
                .Fn = .{
                    .calling_convention = .C,
                    .alignment = @typeInfo(fn () callconv(.C) void).Fn.alignment,
                    .is_generic = false,
                    .is_var_args = false,
                    .return_type = Return,
                    .params = &params,
                },
            });
        }
    };
}

/// This is the type of a block structure that is passed as the first
/// argument to any block invocation. See Block.
fn BlockContext(comptime Captures: type, comptime InvokeFn: type) type {
    const captures_info = @typeInfo(Captures).Struct;
    var fields: [captures_info.fields.len + 5]std.builtin.Type.StructField = undefined;
    fields[0] = .{
        .name = "isa",
        .type = ?*anyopaque,
        .default_value = null,
        .is_comptime = false,
        .alignment = @alignOf(*anyopaque),
    };
    fields[1] = .{
        .name = "flags",
        .type = c_int,
        .default_value = null,
        .is_comptime = false,
        .alignment = @alignOf(c_int),
    };
    fields[2] = .{
        .name = "reserved",
        .type = c_int,
        .default_value = null,
        .is_comptime = false,
        .alignment = @alignOf(c_int),
    };
    fields[3] = .{
        .name = "invoke",
        .type = *const InvokeFn,
        .default_value = null,
        .is_comptime = false,
        .alignment = @typeInfo(*const InvokeFn).Pointer.alignment,
    };
    fields[4] = .{
        .name = "descriptor",
        .type = *const Descriptor,
        .default_value = null,
        .is_comptime = false,
        .alignment = @alignOf(*Descriptor),
    };

    for (captures_info.fields, 5..) |capture, i| {
        switch (capture.type) {
            comptime_int => @compileError("capture should not be a comptime_int, try using @as"),
            comptime_float => @compileError("capture should not be a comptime_float, try using @as"),
            else => {},
        }

        fields[i] = .{
            .name = capture.name,
            .type = capture.type,
            .default_value = null,
            .is_comptime = false,
            .alignment = capture.alignment,
        };
    }

    return @Type(.{
        .Struct = .{
            .layout = .Extern,
            .fields = &fields,
            .decls = &.{},
            .is_tuple = false,
        },
    });
}

// Pointer to opaque instead of anyopaque: https://github.com/ziglang/zig/issues/18461
const NSConcreteStackBlock = @extern(*opaque {}, .{ .name = "_NSConcreteStackBlock" });

extern "C" fn _Block_object_assign(dst: *anyopaque, src: *const anyopaque, flag: c_int) void;
extern "C" fn _Block_object_dispose(src: *const anyopaque, flag: c_int) void;

const Descriptor = extern struct {
    reserved: c_ulong = 0,
    size: c_ulong,
    copy_helper: *const fn (dst: *anyopaque, src: *anyopaque) callconv(.C) void,
    dispose_helper: *const fn (src: *anyopaque) callconv(.C) void,
    signature: ?[*:0]const u8,
};

const BlockFlags = packed struct(c_int) {
    _unused: u22 = 0,
    noescape: bool = false,
    _unused_2: bool = false,
    copy_dispose: bool = true,
    ctor: bool = false,
    _unused_3: bool = false,
    global: bool = false,
    stret: bool,
    signature: bool = true,
    _unused_4: u2 = 0,
};

test "Block" {
    const AddBlock = Block(struct {
        x: i32,
        y: i32,
    }, .{}, i32);

    const captures: AddBlock.Captures = .{
        .x = 2,
        .y = 3,
    };

    var block = try AddBlock.init(captures, (struct {
        fn addFn(block: *const AddBlock.Context) callconv(.C) i32 {
            return block.x + block.y;
        }
    }).addFn);
    defer block.deinit();

    const ret = block.invoke(.{});
    try std.testing.expectEqual(@as(i32, 5), ret);
}

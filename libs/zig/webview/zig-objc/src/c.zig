pub usingnamespace @cImport({
    @cInclude("objc/runtime.h");
    @cInclude("objc/message.h");
});

/// This is a funky helper to help with the fact that some macOS
/// SDKs have an i8 return value for bools and some have stdbool.
pub fn boolResult(comptime Fn: type, result: anytype) bool {
    const fn_info = @typeInfo(Fn).Fn;
    return switch (fn_info.return_type.?) {
        bool => result,
        i8 => result == 1,
        else => @compileError("unhandled class_addIvar return type"),
    };
}

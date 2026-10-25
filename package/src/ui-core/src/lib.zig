//! libElectrobunUI: the UI core as a shared library with a C ABI
//! (src/capi.zig) and the Electrobun WGPU-view host (src/host/electrobun.zig).
comptime {
    _ = @import("capi.zig");
    _ = @import("host/electrobun.zig");
}

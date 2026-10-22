// Default Odin toolchain release used to compile Odin main processes.
// This is vendored by package/build.ts; Electrobun must not use a system Odin.
// Odin is pre-1.0 and ships monthly "dev-YYYY-MM" releases that can contain
// breaking changes, so this must stay pinned to a release the SDK is known
// to compile with.
// Keep July's compiler compatibility: August/September ARM64 macOS binaries
// require macOS 16 (July requires 15), and October omits the Intel Mac binary.
// These are compiler host requirements, separate from app deployment targets.
export const ODIN_VERSION = "dev-2026-07a";

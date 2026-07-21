// Default Odin toolchain release used to compile Odin main processes.
// This is vendored by package/build.ts; Electrobun must not use a system Odin.
// Odin is pre-1.0 and ships monthly "dev-YYYY-MM" releases that can contain
// breaking changes, so this must stay pinned to a release the SDK is known
// to compile with.
export const ODIN_VERSION = "dev-2026-07a";

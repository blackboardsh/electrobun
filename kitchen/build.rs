fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // The native Kitchen host intentionally links the entire Rust SDK and a
        // large integration-test dispatcher. link.exe's 1 MiB default main-thread
        // stack is too small for this debug-profile executable.
        println!("cargo:rustc-link-arg-bin=main=/STACK:8388608");
    }
}

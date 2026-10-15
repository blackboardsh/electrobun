fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Loading and running the native devkit can exceed link.exe's 1 MiB
        // default main-thread stack, especially with an unoptimized core.
        // Match the Rust Kitchen host and typical Unix main-thread stacks.
        println!("cargo:rustc-link-arg-bin=main=/STACK:8388608");
    }
}

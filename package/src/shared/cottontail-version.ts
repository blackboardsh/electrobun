// Cottontail is the default Electrobun application runtime. This is the
// exact version bundled into apps built with `mainProcess: "cottontail"` —
// an app runtime component pinned per Electrobun release, like BUN_VERSION.
// It is deliberately distinct from the build-time Cottontail (the
// `// @hutch` pragma pairing) that executes configs, scripts, and the build
// pipeline and never ships in a bundle.
export const COTTONTAIL_VERSION = "0.6.0-canary.11";

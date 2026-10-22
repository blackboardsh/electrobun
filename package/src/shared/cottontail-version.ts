// Cottontail is an opt-in Electrobun application runtime. This is the
// exact version bundled into apps built with `mainProcess: "cottontail"` —
// an app runtime component pinned per Electrobun release, like BUN_VERSION.
// It is deliberately distinct from the build-time Cottontail (the
// `// @hutch` pragma pairing) used for config loading and bundling, which
// never ships in a bundle.
export const COTTONTAIL_VERSION = "0.7.3-canary.7";

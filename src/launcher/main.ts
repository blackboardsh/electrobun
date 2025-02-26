import { join, dirname } from "path";
import { dlopen, suffix } from "bun:ffi";

const lib = dlopen(`./libNativeWrapper.${suffix}`, {    
    runNSApplication: { args: [], returns: "void" },
});

// todo (yoav): as the debug launcher, get the relative path a different way, so dev builds can be shared and executed
// from different locations
const pathToLauncherBin = process.argv0;
const pathToMacOS = dirname(pathToLauncherBin);
const appEntrypointPath = join(
pathToMacOS,
"..",
"Resources",
"app",
"bun",
"index.js"
);

// NOTE: No point adding any event listeners here because this is the main
// ui thread which is about to be blocked by the native event loop below.
new Worker(appEntrypointPath, {
    // consider adding a preload with error handling
    // preload: [''];
});

lib.symbols.runNSApplication();

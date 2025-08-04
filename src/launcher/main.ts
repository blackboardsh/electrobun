import { join, dirname, resolve } from "path";
import { dlopen, suffix } from "bun:ffi";
import { existsSync } from "fs";

const libPath = `./libNativeWrapper.${suffix}`;
const absoluteLibPath = resolve(libPath);

// Check for CEF libraries and warn if LD_PRELOAD not set (Linux only)
if (process.platform === 'linux') {
    const cefLibs = ['./libcef.so', './libvk_swiftshader.so'];
    const existingCefLibs = cefLibs.filter(lib => existsSync(lib));
    
    if (existingCefLibs.length > 0 && !process.env.LD_PRELOAD) {
        console.error(`[LAUNCHER] ERROR: CEF libraries found but LD_PRELOAD not set!`);
        console.error(`[LAUNCHER] Please run through the wrapper script: ./run.sh`);
        console.error(`[LAUNCHER] Or set: LD_PRELOAD="${existingCefLibs.join(':')}" before starting.`);
        
        // Try to re-exec ourselves with LD_PRELOAD set
        const { spawn } = require('child_process');
        const env = { ...process.env, LD_PRELOAD: existingCefLibs.join(':') };
        const child = spawn(process.argv[0], process.argv.slice(1), {
            env,
            stdio: 'inherit'
        });
        child.on('exit', (code) => process.exit(code));
        return; // Don't continue in this process
    }
}

let lib;
try {
    // Set LD_LIBRARY_PATH if not already set
    if (!process.env.LD_LIBRARY_PATH?.includes('.')) {
        process.env.LD_LIBRARY_PATH = `.${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`;
    }
    
    lib = dlopen(libPath, {
        runNSApplication: { args: [], returns: "void" }
    });
} catch (error) {
    console.error(`[LAUNCHER] Failed to load library: ${error.message}`);
    
    // Try with absolute path as fallback
    try {
        lib = dlopen(absoluteLibPath, {
            runNSApplication: { args: [], returns: "void" }
        });
    } catch (absError) {
        console.error(`[LAUNCHER] Library loading failed. Try running: ldd ${libPath}`);
        throw error;
    }
}

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

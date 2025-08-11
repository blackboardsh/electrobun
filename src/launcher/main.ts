import { join, dirname, resolve } from "path";
import { dlopen, suffix } from "bun:ffi";
import { existsSync } from "fs";

// Since main.js now runs from Resources, we need to find libraries in the MacOS directory
const pathToMacOS = dirname(process.argv0); // bun is still in MacOS/bin directory
const libPath = join(pathToMacOS, `libNativeWrapper.${suffix}`);
const absoluteLibPath = resolve(libPath);

// Wrap main logic in a function to avoid top-level return
function main() {
    // Check for CEF libraries and warn if LD_PRELOAD not set (Linux only)
    if (process.platform === 'linux') {
        const cefLibs = [join(pathToMacOS, 'libcef.so'), join(pathToMacOS, 'libvk_swiftshader.so')];
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
    const pathToBinDir = dirname(pathToLauncherBin);

    const appEntrypointPath = join(
        pathToBinDir,
        "..",
        "Resources",
        "app",
        "bun",
        "index.js"
    );

    console.log(`[LAUNCHER] Debug info:
        process.argv0: ${process.argv0}
        pathToBinDir: ${pathToBinDir}
        appEntrypointPath: ${appEntrypointPath}
        cwd: ${process.cwd()}
        appEntrypointPath exists: ${existsSync(appEntrypointPath)}
    `);

    // NOTE: No point adding any event listeners here because this is the main
    // ui thread which is about to be blocked by the native event loop below.
    try {
        console.log(`[LAUNCHER] Creating worker with: ${appEntrypointPath}`);
        new Worker(appEntrypointPath, {
            // consider adding a preload with error handling
            // preload: [''];
        });
        console.log(`[LAUNCHER] Worker created successfully`);
    } catch (error) {
        console.error(`[LAUNCHER] Failed to create worker:`, error);
        throw error;
    }

    lib.symbols.runNSApplication();
}

// Call the main function
main();

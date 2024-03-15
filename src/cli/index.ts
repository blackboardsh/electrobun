import {join, dirname} from 'path';
import {existsSync, readFileSync, cpSync, rmdirSync, mkdirSync, createWriteStream, createReadStream} from 'fs';
import {execSync} from 'child_process';

// this when run as an npm script this will be where the folder where package.json is.
const projectRoot = process.cwd();
const configName = 'electrobun.config';
const configPath = join(projectRoot, configName);

// Note: cli args can be called via npm bun /path/to/electorbun/binary arg1 arg2 
const indexOfElectrobun = process.argv.findIndex(arg => arg.includes('electrobun'));;
const commandArg = process.argv[indexOfElectrobun + 1] || 'launcher';
const commandDefaults = {
    init: {
        projectRoot,
        config: 'electrobun.config'
    },
    build: {
        projectRoot,
        config: 'electrobun.config'
    },
    dev: {
        projectRoot,
        config: 'electrobun.config'
    },
    launcher: {
        projectRoot,
        config: 'electrobun.config'
    },
}

// todo (yoav): add types for config
const defaultConfig = {
    app: {
        name: "MyApp",
        identifier: 'com.example.myapp',
        version: '0.1',
    },
    build: {
        outputFolder: 'build',
    },
    release: {
        bucketUrl: ''
    }
};

const command = commandDefaults[commandArg];

if (!command) {
    console.error('Invalid command: ', commandArg);
    process.exit(1);
}

const config = getConfig();

const envArg = process.argv.find(arg => arg.startsWith('env='))?.split('=')[1] || '';

const validEnvironments = ['dev', 'canary', 'stable'];

// todo (yoav): dev, canary, and stable;
const buildEnvironment: 'dev' | 'canary' | 'stable' = validEnvironments.includes(envArg) ? envArg : 'dev';

// todo (yoav): dev builds should include the branch name, and/or allow configuration via external config
const buildSubFolder = `${buildEnvironment}`;

const buildFolder = join(projectRoot, config.build.outputFolder, buildSubFolder);

// MyApp

// const appName = config.app.name.replace(/\s/g, '-').toLowerCase();

const appFileName = (buildEnvironment === 'stable' ? config.app.name : `${config.app.name}-${config.app.version}-${buildEnvironment}`).replace(/\s/g, '').replace(/\./g, '-');
const bundleFileName = `${appFileName}.app`;


// const logPath = `/Library/Logs/Electrobun/ExampleApp/dev/out.log`;

let proc = null;

if (commandArg === 'init') {
    // todo (yoav): init a repo folder structure
    console.log('initializing electrobun project');

} else if (commandArg === 'build') {  
    
    // refresh build folder
    if (existsSync(buildFolder)) {
        console.info('deleting build folder: ', buildFolder);
        rmdirSync(buildFolder, {recursive: true});

    }
    mkdirSync(buildFolder, {recursive: true})

    // bundle bun to build/bun
    const bunConfig = config.build.bun;
    const bunSource = join(projectRoot, bunConfig.entrypoint);    
    

    if (!existsSync(bunSource)) {
        console.error(`failed to bundle ${bunSource} because it doesn't exist.\n You need a config.build.bun.entrypoint source file to build.`);
        process.exit(1);
    }

    

    // build macos bundle
    const appBundleFolderPath = join(buildFolder, bundleFileName);
    const appBundleFolderContentsPath = join(appBundleFolderPath, 'Contents');
    const appBundleMacOSPath = join(appBundleFolderContentsPath, 'MacOS');
    const appBundleFolderResourcesPath = join(appBundleFolderContentsPath, 'Resources');
    const appBundleAppCodePath = join(appBundleFolderResourcesPath, 'app');
    
    mkdirSync(appBundleMacOSPath, {recursive: true});
    mkdirSync(appBundleAppCodePath, {recursive: true});

    // const bundledBunPath = join(appBundleMacOSPath, 'bun');
    // cpSync(bunPath, bundledBunPath);    

    const InfoPlistContents = 
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${appFileName}</string>
    <key>CFBundleIdentifier</key>
    <string>${config.app.version}</string>
    <key>CFBundleName</key>
    <string>${bundleFileName}</string>
    <key>CFBundleVersion</key>
    <string>${config.app.version}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
</dict>
</plist>`

    Bun.write(join(appBundleFolderContentsPath, 'Info.plist'), InfoPlistContents);

    
    // in dev builds the log file is a named pipe so we can stream it back to the terminal
    // in canary/stable builds it'll be a regular log file
//     const LauncherContents = `#!/bin/bash    
// # change directory from whatever open was or double clicking on the app to the dir of the bin in the app bundle
// cd "$(dirname "$0")"/

// # Define the log file path
// LOG_FILE="$HOME/${logPath}"    

// # Ensure the directory exists
// mkdir -p "$(dirname "$LOG_FILE")"

// if [[ ! -p $LOG_FILE ]]; then
//     mkfifo $LOG_FILE
// fi    

// # Execute bun and redirect stdout and stderr to the log file
// ./bun ../Resources/app/bun/index.js >"$LOG_FILE" 2>&1
// `;

//     // Launcher binary
//     // todo (yoav): This will likely be a zig compiled binary in the future
//     Bun.write(join(appBundleMacOSPath, 'MyApp'), LauncherContents);
//     chmodSync(join(appBundleMacOSPath, 'MyApp'), '755');
    // const zigLauncherBinarySource = join(projectRoot, 'node_modules', 'electrobun', 'src', 'launcher', 'zig-out', 'bin', 'launcher');
    // const zigLauncherDestination = join(appBundleMacOSPath, 'MyApp');
    // const destLauncherFolder = dirname(zigLauncherDestination);
    // if (!existsSync(destLauncherFolder)) {
    //     // console.info('creating folder: ', destFolder);
    //     mkdirSync(destLauncherFolder, {recursive: true});
    // }
    // cpSync(zigLauncherBinarySource, zigLauncherDestination, {recursive: true, dereference: true});    
    const bunCliLauncherBinarySource = buildEnvironment === 'dev' ? 
        // Note: in dev use the cli as the launcher
        join(projectRoot, 'node_modules', '.bin', 'electrobun') : 
        // Note: for release use the zig launcher optimized for smol size
        join(projectRoot, 'node_modules', 'electrobun', 'src', 'launcher', 'zig-out', 'bin', 'launcher');
    const bunCliLauncherDestination = join(appBundleMacOSPath, appFileName);
    const destLauncherFolder = dirname(bunCliLauncherDestination);
    if (!existsSync(destLauncherFolder)) {
        // console.info('creating folder: ', destFolder);
        mkdirSync(destLauncherFolder, {recursive: true});
    }
    cpSync(bunCliLauncherBinarySource, bunCliLauncherDestination, {recursive: true, dereference: true});    

    // Bun runtime binary
    // todo (yoav): this only works for the current architecture
    const bunBinarySourcePath = join(projectRoot, 'node_modules', '.bin', 'bun');
    // Note: .bin/bun binary in node_modules is a symlink to the versioned one in another place
    // in node_modules, so we have to dereference here to get the actual binary in the bundle.
    cpSync(bunBinarySourcePath, join(appBundleMacOSPath, 'bun'), {dereference: true});    
    

    // Zig native wrapper binary
    // todo (yoav): build native bindings for target
    // copy native bindings
    const zigNativeBinarySource = join(projectRoot, 'node_modules', 'electrobun', 'src', 'zig', 'zig-out', 'bin', 'webview');
    const zigNativeBinaryDestination = join(appBundleMacOSPath, 'native', 'webview');
    const destFolder = dirname(zigNativeBinaryDestination);
    if (!existsSync(destFolder)) {
        // console.info('creating folder: ', destFolder);
        mkdirSync(destFolder, {recursive: true});
    }
    // console.log('copying', zigNativeBinarySource, 'to', zigNativeBinaryDestination);
    cpSync(zigNativeBinarySource, zigNativeBinaryDestination, {recursive: true, dereference: true});    

    const bunDestFolder = join(appBundleAppCodePath, "bun");
    // Build bun-javascript ts files
    const buildResult = await Bun.build({
        entrypoints: [bunSource],
        outdir: bunDestFolder,
        external: bunConfig.external || [],
        // minify: true, // todo (yoav): add minify in canary and prod builds
        target: "bun",
    })

    if (!buildResult.success) {
        console.error('failed to build', bunSource, buildResult.logs);
        process.exit(1);
    }
    
    // const singleFileExecutablePath = join(appBundleMacOSPath, 'myApp');
    
    // const builderProcess = Bun.spawnSync([bunPath, 'build', bunSource, '--compile', '--outfile', singleFileExecutablePath])

    // console.log('builderProcess', builderProcess.stdout.toString(), builderProcess.stderr.toString());
    

    // Build webview-javascript ts files
    // bundle all the bundles
    for (const viewName in config.build.views) {        
        const viewConfig = config.build.views[viewName];
                
        const viewSource = join(projectRoot, viewConfig.entrypoint);
        if (!existsSync(viewSource)) {
            console.error(`failed to bundle ${viewSource} because it doesn't exist.`);
            continue;
        }

        const viewDestFolder = join(appBundleAppCodePath, 'views', viewName);
        
        if (!existsSync(viewDestFolder)) {
            // console.info('creating folder: ', viewDestFolder);
            mkdirSync(viewDestFolder, {recursive: true});
        } else {
            console.error('continuing, but ', viewDestFolder, 'unexpectedly already exists in the build folder')
        }

        // console.info(`bundling ${viewSource} to ${viewDestFolder} with config: `, viewConfig);

        const buildResult = await Bun.build({
            entrypoints: [viewSource],
            outdir: viewDestFolder,
            external: viewConfig.external || [],
            target: "browser",
        })

        if (!buildResult.success) {
            console.error('failed to build', viewSource, buildResult.logs);
            continue;
        }
        
    }


    // Copy assets like html, css, images, and other files
    for (const relSource in config.build.copy) {
        const source = join(projectRoot, relSource);
        if (!existsSync(source)) {
            console.error(`failed to copy ${source} because it doesn't exist.`);
            continue;
        }

        const destination = join(appBundleAppCodePath, config.build.copy[relSource]);
        const destFolder = dirname(destination);

        if (!existsSync(destFolder)) {
            // console.info('creating folder: ', destFolder);
            mkdirSync(destFolder, {recursive: true});
        }
        
        // todo (yoav): add ability to swap out BUILD VARS
        // console.log('copying', source, 'to', destination);
        cpSync(source, destination, {recursive: true, dereference: true})
    }    

    const bunVersion = execSync(`${bunBinarySourcePath} --version`).toString().trim();
    
    const versionJsonContent = JSON.stringify({
        versions: {
            app: config.app.version,
            bun: bunVersion,
            webview: 'system'// could also be type of webview with version number. eg: 'cef:1.0.2'
        },        
        build: buildEnvironment,
        bucketUrl: config.release.bucketUrl,
    });    

    Bun.write(join(appBundleFolderResourcesPath, 'version.json'), versionJsonContent);

    if (buildEnvironment === 'dev') {
        // in dev mode add a cupla named pipes for some dev debug rpc magic
        const debugPipesFolder = join(appBundleFolderResourcesPath, 'debug');
        if (!existsSync(debugPipesFolder)) {
            // console.info('creating folder: ', debugPipesFolder);
            mkdirSync(debugPipesFolder, {recursive: true});
        }
        const toLauncherPipePath = join(debugPipesFolder, 'toLauncher');
        const toCliPipePath = join(debugPipesFolder, 'toCli');
        try {        
            execSync('mkfifo ' + toLauncherPipePath);        
        } catch (e) {
            console.log('pipe out already exists')
        }

        try {        
            execSync('mkfifo ' + toCliPipePath);
        } catch (e) {
            console.log('pipe out already exists')
        }
    }

    // todo (yoav): generate version.json file

    

} else if (commandArg === 'dev') {
    // todo (yoav): rename to start
    
    // run the project in dev mode
    // this runs the cli in debug mode, on macos executes the app bundle,
    // there is another copy of the cli in the app bundle that will execute the app
    // the two cli processes communicate via named pipes and together manage the dev
    // lifecycle and debug functionality

    // Note: this cli will be a bun single-file-executable
    // Note: we want to use the version of bun that's packaged with electrobun
    // const bunPath = join(projectRoot, 'node_modules', '.bin', 'bun');
    // const mainPath = join(buildFolder, 'bun', 'index.js');
    const mainPath = join(buildFolder, bundleFileName);
    // console.log('running ', bunPath, mainPath);
    
    // Note: open will open the app bundle as a completely different process
    // This is critical to fully test the app (including plist configuration, etc.)
    // but also to get proper cmd+tab and dock behaviour and not run the windowed app
    // as a child of the terminal process which steels keyboard focus from any descendant nswindows.    
    Bun.spawn(['open', mainPath], {        
        env: {
        }        
    });   

    if (buildEnvironment !== 'dev') {
        // Note: only continue wiring up dev mode if we're launching the 
        // dev build.
        process.exit();
    }
    
    const debugPipesFolder = join(buildFolder, bundleFileName, 'Contents', 'Resources', 'debug');
    const toLauncherPipePath = join(debugPipesFolder, 'toLauncher');
    const toCliPipePath = join(debugPipesFolder, 'toCli');

    const toCliPipeStream = createReadStream(toCliPipePath, {
		flags: 'r+', 		
	});
    
        
    let buffer = '';
    toCliPipeStream.on('data', (chunk) => {
        buffer += chunk.toString();                    
        let eolIndex;

        while ((eolIndex = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, eolIndex).trim();
            buffer = buffer.slice(eolIndex + 1);                        
            if (line) {
                try {
                    if (line === 'app exiting command')  {
                        process.exit();
                    }
                    const event = JSON.parse(line);
                    // handler(event)										
                } catch (error) {
                    // Non-json things are just bubbled up to the console.
                    console.error('webview: ', line)
                }                    
            }
        }                                       
    });	     

   

    const toLauncherPipe = createWriteStream(toLauncherPipePath, {
		flags: 'r+', 		
	});
    toLauncherPipe.write('\n')
    // toLauncherPipe.write('hello from cli 1\n')
   

    process.on("SIGINT", () => {
        toLauncherPipe.write('exit command\n')                        
        process.exit();        
      });    
} else {
    // no commands so run as the debug launcher inside the app bundle

    // todo (yoav): as the debug launcher, get the relative path a different way, so dev builds can be shared and executed
    // from different locations
    const pathToLauncherBin = process.argv0;
    const pathToMacOS = dirname(pathToLauncherBin);    
    const debugPipesFolder = join(pathToMacOS, "..", 'Resources', 'debug');
    const toLauncherPipePath = join(debugPipesFolder, 'toLauncher');
    const toCliPipePath = join(debugPipesFolder, 'toCli');

    const toLauncherPipeStream = createReadStream(toLauncherPipePath, {
		flags: 'r+', 		
	});    
    
    let buffer = '';
    toLauncherPipeStream.on('data', (chunk) => {
        buffer += chunk.toString();                    
        let eolIndex;

        while ((eolIndex = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, eolIndex).trim();
            buffer = buffer.slice(eolIndex + 1);                        
            if (line) {
                try {                    
                    if (line === 'exit command') {     
                        // Receive kill command from cli (likely did cmd+c in terminal running the cli)                                                                                       
                        process.kill(process.pid, 'SIGINT');                   
                    }
                    const event = JSON.parse(line);
                    // handler(event)										
                } catch (error) {
                    // Non-json things are just bubbled up to the console.
                    console.error('launcher received line from cli: ', line)
                }                    
            }
        }                                       
    });	    
    
    // If we open the dev app bundle directly without the cli, then no one will be listening to the toCliPipe
    // and it'll hang. So we open the pipe for reading to prevent it from blocking but we don't read it here.
    const toCliPipe = createWriteStream(toCliPipePath, {
        // Note: open the pipe for reading and writing (r+) so that it doesn't block. If you only open it for writing (w)
        // then it'll block until the cli starts reading. Double clicking on the bundle bypasses the cli so it'll block forever.
		flags: 'r+', 		
	});    
    toCliPipe.write('\n')
    
    const bunRuntimePath = join(pathToMacOS, "bun");
    const appEntrypointPath = join(pathToMacOS, "..", "Resources", "app", "bun", "index.js");    
    
    try {
        proc = Bun.spawn([bunRuntimePath, appEntrypointPath], {cwd: pathToMacOS, onExit: (code) => {
            toCliPipe.write(`subprocess exited\n`);        
            process.kill(process.pid, 'SIGINT');
        }});                        
    } catch (e) {
        toCliPipe.write(`error\n ${e}\n`)        
    }

    process.on("SIGINT", () => {
        toCliPipe.write('app exiting command\n')                        
        process.kill(proc.pid, 'SIGINT');                
        process.exit();
    });

    async function streamPipeToCli(stream) {
        for await (const chunk of stream) {
            toCliPipe.write(chunk);
        }
    }
    streamPipeToCli(proc.stdout);
    // streamPipeToCli(process.stdout);
    // streamPipeToCli(proc.stderr);
}

function getConfig() {
    let loadedConfig = {};
    if (existsSync(configPath)) {
        const configFileContents = readFileSync(configPath, 'utf8');        
        // Note: we want this to hard fail if there's a syntax error
        loadedConfig = JSON.parse(configFileContents);

        loadedConfig.build = loadedConfig.build || {};
    }    

    // todo (yoav): write a deep clone fn
    return {
        ...defaultConfig,
        ...loadedConfig,
        app: {
            ...defaultConfig.app,
            ...loadedConfig.app
        },
        build: {
            ...defaultConfig.build,
            ...loadedConfig.build
        },
        release: {
            ...defaultConfig.release,
            ...loadedConfig.release
        }
    }
}

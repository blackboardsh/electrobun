import {join, dirname} from 'path';
import {existsSync, readFileSync, cpSync, rmdirSync, mkdirSync, chmodSync} from 'fs';
import {exec} from 'child_process';

// this when run as an npm script this will be where the folder where package.json is.
const projectRoot = process.cwd();
const configName = 'electrobun.config';
const configPath = join(projectRoot, configName);

// Note: cli args can be called via npm bun /path/to/electorbun/binary arg1 arg2 
const indexOfElectrobun = process.argv.findIndex(arg => arg.includes('electrobun'));;
const commandArg = process.argv[indexOfElectrobun + 1];
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
    }
}

// todo (yoav): add types for config
const defaultConfig = {
    build: {
        outputFolder: 'build',
    }
};

const command = commandDefaults[commandArg];

if (!command) {
    console.error('Invalid command: ', commandArg);
    process.exit(1);
}

const config = getConfig();

const buildFolder = join(projectRoot, config.build.outputFolder);

const logPath = `/Library/Logs/Electrobun/ExampleApp/dev/out.log`;

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
    const appBundleFolderPath = join(buildFolder, 'dev.app');
    const appBundleFolderContentsPath = join(appBundleFolderPath, 'Contents');
    const appBundleMacOSPath = join(appBundleFolderContentsPath, 'MacOS');
    
    mkdirSync(appBundleMacOSPath, {recursive: true});

    // const bundledBunPath = join(appBundleMacOSPath, 'bun');
    // cpSync(bunPath, bundledBunPath);    

    const InfoPlistContents = `<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>CFBundleExecutable</key>
        <string>MyApp</string>
        <key>CFBundleIdentifier</key>
        <string>com.example.myapp</string>
        <key>CFBundleName</key>
        <string>MyApp</string>
        <key>CFBundleVersion</key>
        <string>1.0</string>
        <key>CFBundlePackageType</key>
        <string>APPL</string>
    </dict>
    </plist>`

    Bun.write(join(appBundleFolderContentsPath, 'Info.plist'), InfoPlistContents);

    
    // in dev builds the log file is a named pipe so we can stream it back to the terminal
    // in canary/stable builds it'll be a regular log file
    const LauncherContents = `#!/bin/bash
    cd "$(dirname "$0")"/bun
    
    # Define the log file path
    LOG_FILE="$HOME/${logPath}"    
    
    # Ensure the directory exists
    mkdir -p "$(dirname "$LOG_FILE")"

    if [[ ! -p $LOG_FILE ]]; then
        mkfifo $LOG_FILE
    fi    
    
    # Execute bun and redirect stdout and stderr to the log file
    ./bun . >"$LOG_FILE" 2>&1
`;

    Bun.write(join(appBundleMacOSPath, 'MyApp'), LauncherContents);
    chmodSync(join(appBundleMacOSPath, 'MyApp'), '755');
    
    
    const bunDestFolder = join(appBundleMacOSPath, "bun");
    const buildResult = await Bun.build({
        entrypoints: [bunSource],
        outdir: bunDestFolder,
        external: bunConfig.external || [],
        target: "bun",
    })

    if (!buildResult.success) {
        console.error('failed to build', bunSource, buildResult.logs);
        process.exit(1);
    }
    const bunPath = join(projectRoot, 'node_modules', '.bin', 'bun');
    // Note: .bin/bun binary in node_modules is a symlink to the versioned one in another place
    // in node_modules, so we have to dereference here to get the actual binary in the bundle.
    cpSync(bunPath, join(bunDestFolder, 'bun'), {dereference: true});
    // const singleFileExecutablePath = join(appBundleMacOSPath, 'myApp');
    
    // const builderProcess = Bun.spawnSync([bunPath, 'build', bunSource, '--compile', '--outfile', singleFileExecutablePath])

    // console.log('builderProcess', builderProcess.stdout.toString(), builderProcess.stderr.toString());
    


    // bundle all the bundles
    for (const viewName in config.build.views) {        
        const viewConfig = config.build.views[viewName];
                
        const viewSource = join(projectRoot, viewConfig.entrypoint);
        if (!existsSync(viewSource)) {
            console.error(`failed to bundle ${viewSource} because it doesn't exist.`);
            continue;
        }

        const viewDestFolder = join(appBundleMacOSPath, 'views', viewName);
        
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


    // copy all the files
    for (const relSource in config.build.copy) {
        const source = join(projectRoot, relSource);
        if (!existsSync(source)) {
            console.error(`failed to copy ${source} because it doesn't exist.`);
            continue;
        }

        const destination = join(appBundleMacOSPath, config.build.copy[relSource]);
        const destFolder = dirname(destination);

        if (!existsSync(destFolder)) {
            // console.info('creating folder: ', destFolder);
            mkdirSync(destFolder, {recursive: true});
        }
        
        // todo (yoav): add ability to swap out BUILD VARS
        // console.log('copying', source, 'to', destination);
        cpSync(source, destination, {recursive: true, dereference: true})
    }

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
    cpSync(zigNativeBinarySource, zigNativeBinaryDestination, {recursive: true});    

    

} else if (commandArg === 'dev') {
    // run the project in dev mode
    // Note: this cli will be a bun single-file-executable
    // Note: we want to use the version of bun that's packaged with electrobun
    // const bunPath = join(projectRoot, 'node_modules', '.bin', 'bun');
    // const mainPath = join(buildFolder, 'bun', 'index.js');
    const mainPath = join(buildFolder, 'dev.app');
    // console.log('running ', bunPath, mainPath);
    
    // Note: open will open the app bundle as a completely different process
    // This is critical to fully test the app (including plist configuration, etc.)
    // but also to get proper cmd+tab and dock behaviour and not run the windowed app
    // as a child of the terminal process which steels keyboard focus from any descendant nswindows.
    Bun.spawn(['open', mainPath], {        
        env: {
        }        
    });    

    const proc = exec(`cat ~${logPath}`, {stdio: 'inherit'});
    proc.stdout.on('data', (data) => {        
        process.stdout.write(data);
    });
    proc.stderr.on('data', (data) => {        
        process.stderr.write(data);
    });

      // todo (yoav): it would be nice if cmd+c here killed the opened app bundle
      
  

    // support multiple js files, each built differently with different externals and different names
    // support preload scripts
    // support copying files from arbitray locations
    // a given webview may not be able to access all files in the build folder via assets://
        // what should it be able to access, sometimes all views should be able to load all assets
        // sometimes I don't want any, and other times I want to isolate different views
    // assets:// should be ranemd views:// scheme should map to builld/views
      // by default, webviews given a views:// url should be able to access views
      // any other url should not unless user specifies it with enableViewsScheme: true
      // assets:// never maps to build/native or build/bun
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
        build: {
            ...defaultConfig.build,
            ...loadedConfig.build
        }
    }
}

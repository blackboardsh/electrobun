import {join, dirname, basename} from 'path';
import {existsSync, readFileSync, cpSync, rmdirSync, mkdirSync, createWriteStream, createReadStream, unlinkSync} from 'fs';
import {execSync} from 'child_process';
import tar from 'tar';
import {ZstdInit} from '@oneidentity/zstd-js/wasm';

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
        buildFolder: 'build',
        artifactFolder: 'artifacts',
        mac: {
            codesign: false,
            notarize: false,
            entitlements: {
                // This entitlement is required for Electrobun apps with a hardened runtime (required for notarization) to run on macos
                "com.apple.security.cs.allow-jit": true,                
            }
        },        
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

const buildFolder = join(projectRoot, config.build.buildFolder, buildSubFolder);

const artifactFolder = join(projectRoot, config.build.artifactFolder, buildSubFolder);

// MyApp

// const appName = config.app.name.replace(/\s/g, '-').toLowerCase();

const appFileName = (buildEnvironment === 'stable' ? config.app.name : `${config.app.name}-${buildEnvironment}`).replace(/\s/g, '').replace(/\./g, '-');
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

    const {
        appBundleFolderPath,
        appBundleFolderContentsPath,
        appBundleMacOSPath,
        appBundleFolderResourcesPath
    } = createAppBundle(appFileName, buildFolder);
    
    const appBundleAppCodePath = join(appBundleFolderResourcesPath, 'app');
        
    mkdirSync(appBundleAppCodePath, {recursive: true});
    

    // const bundledBunPath = join(appBundleMacOSPath, 'bun');
    // cpSync(bunPath, bundledBunPath);    


    // Note: for sandboxed apps, MacOS will use the CFBundleIdentifier to create a unique container for the app,
    // mirroring folders like Application Support, Caches, etc. in the user's Library folder that the sandboxed app
    // gets access to.

    // We likely want to let users configure this for different environments (eg: dev, canary, stable) and/or
    // provide methods to help segment data in those folders based on channel/environment
    const InfoPlistContents = 
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${appFileName}</string>
    <key>CFBundleIdentifier</key>
    <string>${config.app.identifier}</string>
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
    const bunBinaryDestInBundlePath = join(appBundleMacOSPath, 'bun');
    cpSync(bunBinarySourcePath, bunBinaryDestInBundlePath, {dereference: true});    
    

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
    
    // version.json inside the app bundle
    const versionJsonContent = JSON.stringify({
        versions: {
            app: config.app.version,
            bun: bunVersion,
            webview: 'system'// could also be type of webview with version number. eg: 'cef:1.0.2'
        },        
        channel: buildEnvironment,
        bucketUrl: config.release.bucketUrl,
    });    

    Bun.write(join(appBundleFolderResourcesPath, 'version.json'), versionJsonContent);
    
    // todo (yoav): add these to config
    const shouldCodesign = buildEnvironment !== 'dev' && config.build.mac.codesign;
    const shouldNotarize = shouldCodesign && config.build.mac.notarize;
    
    if (shouldCodesign) {        
        codesignAppBundle(appBundleFolderPath, join(buildFolder, 'entitlements.plist'));
    } else {
        console.log('skipping codesign')
    }
    
    
    // codesign 
    // NOTE: Codesigning fails in dev mode (when using a single-file-executable bun cli as the launcher)
    // see https://github.com/oven-sh/bun/issues/7208
    if (shouldNotarize) {
        notarizeAndStaple(appBundleFolderPath);       
    } else {
        console.log('skipping notarization')
    }
    

    // update.json for the channel in that channel's build folder
    const updateJsonContent = JSON.stringify({
        versions: {
            app: config.app.version,
            bun: bunVersion,
            webview: 'system2',
        },
        channel: buildEnvironment,        
        bucketUrl: config.release.bucketUrl
    });    

    Bun.write(join(artifactFolder, 'update.json'), updateJsonContent);
    
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
    } else {
         // bsdiff wasm https://github.com/kairi003/bsdiff-wasm
        // zstd wasm https://github.com/OneIdentity/zstd-js
        // tar https://github.com/isaacs/node-tar

        // steps:
        // 1. [done] build the app bundle, code sign, notarize, staple.
        // 2. tar and zstd the app bundle (two separate files)
        // 3. build another app bundle for the self-extracting app bundle with the zstd in Resources
        // 4. code sign and notarize the self-extracting app bundle
        // 5. while waiting for that notarization, download the prev app bundle, extract the tar, and generate a bsdiff patch
        // 6. when notarization is complete, generate a dmg of the self-extracting app bundle
        // 6.5. code sign and notarize the dmg
        // 7. copy artifacts to directory [self-extractor dmg, zstd app bundle, bsdiff patch, update.json]

        const tarPath = `${appBundleFolderPath}.tar`;

        // tar the signed and notarized app bundle
        await tar.c({
            gzip: false,
            file: tarPath,
            cwd: buildFolder
        }, 
        [basename(appBundleFolderPath)])

        const compressedTarPath = `${tarPath}.zst`;

        // zstd compress tarball
        console.log('compressing tarball...')
        await ZstdInit().then(async ({ZstdSimple, ZstdStream}) => {
            const tarball = Bun.file(tarPath);
            
            // Note: Simple is much faster than stream, but stream is better for large files
            // todo (yoav): consider a file size cutoff to switch to stream instead of simple.
            if (tarball.size > 0) {
                // Uint8 array filestream of the tar file
                const tarBuffer = await tarball.arrayBuffer();
                const data = new Uint8Array(tarBuffer);
                const compressionLevel = 22;
                // todo (yoav): use --long if available via this library
                const compressedData = ZstdSimple.compress(data, compressionLevel)

                console.log('compressed', compressedData.length, 'bytes', 'from', data.length, 'bytes')
                
                await Bun.write(compressedTarPath, compressedData);
            }
        })

        // we can delete the original app bundle since we've tarred and zstd it. We need to create the self-extracting app bundle
        // now and it needs the same name as the original app bundle.
        rmdirSync(appBundleFolderPath, {recursive: true});
        

        const selfExtractingBundle = createAppBundle(appFileName, buildFolder);
        const compressedTarballInExtractingBundlePath = join(selfExtractingBundle.appBundleFolderResourcesPath, 'compressed.tar.zst');

        // copy the zstd tarball to the self-extracting app bundle
        cpSync(compressedTarPath, compressedTarballInExtractingBundlePath);

        const selfExtractorBinSourcePath = join(projectRoot, 'node_modules', 'electrobun', 'src', 'launcher', 'zig-out', 'bin', 'launcher');
        const selfExtractorBinDestinationPath = join(selfExtractingBundle.appBundleMacOSPath, appFileName);

        cpSync(selfExtractorBinSourcePath, selfExtractorBinDestinationPath, {dereference: true});

        Bun.write(join(selfExtractingBundle.appBundleFolderContentsPath, 'Info.plist'), InfoPlistContents);


        if (shouldCodesign) {        
            codesignAppBundle(selfExtractingBundle.appBundleFolderPath, join(buildFolder, 'entitlements.plist'));
        } else {
            console.log('skipping codesign')
        }                 
        
        // Note: we need to notarize the original app bundle, the self-extracting app bundle, and the dmg
        if (shouldNotarize) {
            notarizeAndStaple(selfExtractingBundle.appBundleFolderPath);   
        } else {
            console.log('skipping notarization')
        }


        console.log('creating dmg...')
        // make a dmg
        const dmgPath = join(buildFolder, `${appFileName}.dmg`);
        
        // hdiutil create -volname "YourAppName" -srcfolder /path/to/YourApp.app -ov -format UDZO YourAppName.dmg
        // Note: use UDBZ for better compression vs. UDZO
        execSync(`hdiutil create -volname "${appFileName}" -srcfolder ${appBundleFolderPath} -ov -format UDBZ ${dmgPath}`)

        if (shouldCodesign) {        
            codesignAppBundle(dmgPath);
        } else {
            console.log('skipping codesign')
        }    

        if (shouldNotarize) {
            notarizeAndStaple(dmgPath);   
        } else {
            console.log('skipping notarization')
        }
        

        // refresh artifacts folder

        if (existsSync(artifactFolder)) {
            console.info('deleting artifact folder: ', artifactFolder);
            rmdirSync(artifactFolder, {recursive: true});
        }

        mkdirSync(artifactFolder, {recursive: true});
        
        // // compress all the upload files
        // const filesToCompress = [dmgPath, appBundleContainerPath, bunVersionedRuntimePath];
        
        // filesToCompress.forEach((filePath) => {        
        //     const filename = basename(filePath);
        //     const zipPath = join(artifactFolder, `${filename}.zip`);
        //     // todo (yoav): do this in parallel
        //     execSync(`zip -r -9 ${zipPath} ${filename}`, {cwd: dirname(filePath)});
        // });

        // self-extractor:
        // 1. extract zstd tarball in resources folder to an application specific cache folder
        // 2. extract the tarball to a tmp location, verify codesign/sha/checksum
        // 3. replace bundle in place close, and re-open the app
        // 4. do we need messaging or an alert? should we build that into the electrobun bun api to give user control


        // updator: 
        // 1. check update.json
        // 2. try download patches
        // 3. apply patches to cached tarball
        // 4. verify codesign/sha/checksum
        // 5. replace bundle in place, close, and re-open the app

    }


    // NOTE: verify codesign
    //  codesign --verify --deep --strict --verbose=2 <app path>

    // Note: verify notarization
    // spctl --assess --type execute --verbose <app path>
    
    // Note: for .dmg spctl --assess will respond with "rejected (*the code is valid* but does not seem to be an app)" which is valid
    // for a dmg.
    // can also use stapler validate -v to validate the dmg and look for teamId, signingId, and the response signedTicket
    // stapler validate -v <app path>


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

    if (buildEnvironment === 'dev') {
      
    
    
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

    }

   
    

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
            ...loadedConfig.build,
            mac: {                
                ...defaultConfig.build.mac,
                ...loadedConfig?.build?.mac,
                entitlements: {
                    ...defaultConfig.build.mac.entitlements,
                    ...loadedConfig?.build?.mac?.entitlements                
                }
            }
        },
        release: {
            ...defaultConfig.release,
            ...loadedConfig.release
        }
    }
}

function buildEntitlementsFile(entitlements) {    
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    ${Object.keys(entitlements).map(key => {
        return `<key>${key}</key>\n${getEntitlementValue(entitlements[key])}`;
    }).join('\n')}
</dict>
</plist>
`
}

function getEntitlementValue(value: boolean | string) {
    if (typeof value === 'boolean') {
        return `<${value.toString()}/>`;
    } else {
        return value;
    }
}

function codesignAppBundle(appBundleOrDmgPath: string, entitlementsFilePath?: string) {
    console.log('code signing...')
    if (!config.build.mac.codesign) {
        return;
    }
    
    const ELECTROBUN_DEVELOPER_ID = process.env['ELECTROBUN_DEVELOPER_ID'];
    
    
    if (!ELECTROBUN_DEVELOPER_ID) {
        console.error('Env var ELECTROBUN_DEVELOPER_ID is required to codesign');
        process.exit(1);
    }
    
    // list of entitlements https://developer.apple.com/documentation/security/hardened_runtime?language=objc
    // todo (yoav): consider allowing separate entitlements config for each binary
    // const entitlementsFilePath = join(buildFolder, 'entitlements.plist');
    
    if (entitlementsFilePath) {
        const entitlementsFileContents = buildEntitlementsFile(config.build.mac.entitlements);
        Bun.write(entitlementsFilePath, entitlementsFileContents);
        
        execSync(`codesign --deep --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime --entitlements ${entitlementsFilePath} ${appBundleOrDmgPath}`)        
    } else {
        execSync(`codesign --deep --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" ${appBundleOrDmgPath}`)            
    }
}


function notarizeAndStaple(appOrDmgPath: string) {
    if (!config.build.mac.notarize) {
        return;
    }

    let fileToNotarize = appOrDmgPath;
    // codesign 
    // NOTE: Codesigning fails in dev mode (when using a single-file-executable bun cli as the launcher)
    // see https://github.com/oven-sh/bun/issues/7208
    // if (shouldNotarize) {
        console.log('notarizing...')
        const zipPath = appOrDmgPath + '.zip';
        // if (appOrDmgPath.endsWith('.app')) {
            const appBundleFileName = basename(appOrDmgPath);
            // if we're codesigning the .app we have to zip it first
            execSync(`zip -r -9 ${zipPath} ${appBundleFileName}`, {cwd: dirname(appOrDmgPath)});
            fileToNotarize = zipPath;
        // }

        const ELECTROBUN_APPLEID = process.env['ELECTROBUN_APPLEID'];
        
        if (!ELECTROBUN_APPLEID) {
            console.error('Env var ELECTROBUN_APPLEID is required to notarize');
            process.exit(1);
        }
        
        const ELECTROBUN_APPLEIDPASS = process.env['ELECTROBUN_APPLEIDPASS'];
        
        if (!ELECTROBUN_APPLEIDPASS) {
            console.error('Env var ELECTROBUN_APPLEIDPASS is required to notarize');
            process.exit(1);
        }
        
        const ELECTROBUN_TEAMID = process.env['ELECTROBUN_TEAMID'];
        
        if (!ELECTROBUN_TEAMID) {
            console.error('Env var ELECTROBUN_TEAMID is required to notarize');
            process.exit(1);
        }
        
        
        // notarize        
        // todo (yoav): follow up on options here like --s3-acceleration and --webhook        
        // todo (yoav): don't use execSync since it's blocking and we'll only see the output at the end
        const statusInfo = execSync(`xcrun notarytool submit --apple-id "${ELECTROBUN_APPLEID}" --password "${ELECTROBUN_APPLEIDPASS}" --team-id "${ELECTROBUN_TEAMID}" --wait ${fileToNotarize}`).toString();
        const uuid = statusInfo.match(/id: ([^\n]+)/)?.[1]
        console.log('statusInfo', statusInfo);
        console.log('uuid', uuid);
        
        if (statusInfo.match("Current status: Invalid")) {
            console.error('notarization failed', statusInfo);
            const log = execSync(`xcrun notarytool log --apple-id "${ELECTROBUN_APPLEID}" --password "${ELECTROBUN_APPLEIDPASS}" --team-id "${ELECTROBUN_TEAMID}" ${uuid}`).toString();
            console.log('log', log)
            process.exit(1);
        }        
        // check notarization                
        // todo (yoav): actually check result
        // use `notarytool info` or some other request thing to check separately from the wait above
        
        // stable notarization        
        console.log('stapling...')
        execSync(`xcrun stapler staple ${appOrDmgPath}`)        

        if (existsSync(zipPath)) {
            unlinkSync(zipPath);
        }
}

// Note: supposedly the app bundle name is relevant to code sign/notarization so we need to make the app bundle and the self-extracting wrapper app bundle
// have the same name but different subfolders in our build directory. or I guess delete the first one after tar/compression and then create the other one.
// either way you can pass in the parent folder here for that flexibility.
// for intel/arm builds on mac we'll probably have separate subfolders as well and build them in parallel.
function createAppBundle(bundleName: string, parentFolder: string) {
    const bundleFileName = `${bundleName}.app`;
    const appBundleFolderPath = join(parentFolder, bundleFileName);
    const appBundleFolderContentsPath = join(appBundleFolderPath, 'Contents');
    const appBundleMacOSPath = join(appBundleFolderContentsPath, 'MacOS');
    const appBundleFolderResourcesPath = join(appBundleFolderContentsPath, 'Resources');
    
    // we don't have to make all the folders, just the deepest ones
    // todo (yoav): check if folders exist already before creating them
    mkdirSync(appBundleMacOSPath, {recursive: true});
    mkdirSync(appBundleFolderResourcesPath, {recursive: true});

    return {
        appBundleFolderPath,
        appBundleFolderContentsPath,
        appBundleMacOSPath,
        appBundleFolderResourcesPath,        
    }
}
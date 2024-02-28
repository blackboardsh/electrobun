import {join, dirname} from 'path';
import {existsSync, readFileSync, cpSync, rmdirSync, mkdirSync} from 'fs';
import {execSync} from 'child_process';

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
    const bunDestFolder = join(buildFolder, "bun");

    if (!existsSync(bunSource)) {
        console.error(`failed to bundle ${bunSource} because it doesn't exist.\n You need a config.build.bun.entrypoint source file to build.`);
        process.exit(1);
    }

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


    // bundle all the bundles
    for (const viewName in config.build.views) {        
        const viewConfig = config.build.views[viewName];
                
        const viewSource = join(projectRoot, viewConfig.entrypoint);
        if (!existsSync(viewSource)) {
            console.error(`failed to bundle ${viewSource} because it doesn't exist.`);
            continue;
        }

        const viewDestFolder = join(buildFolder, 'views', viewName);
        
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

        const destination = join(buildFolder, config.build.copy[relSource]);
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
    const zigNativeBinaryDestination = join(buildFolder, 'native', 'webview');
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
    const bunPath = join(projectRoot, 'node_modules', '.bin', 'bun');
    const mainPath = join(buildFolder, 'bun', 'index.js');
    // console.log('running ', bunPath, mainPath);
    Bun.spawn([bunPath, mainPath], {
        stdin: 'inherit',
        stdout: 'inherit',
        env: {

        }
        
    });

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

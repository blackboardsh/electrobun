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

// console.log('config', config);

// const defaultBundleConfig = {
//     minify: {
//         whitespace: true,
//         identifiers: true,
//         syntax: true,
//       },
//     external: [],
//     define: {

//     },
// }


if (commandArg === 'init') {
    // todo (yoav): init a repo folder structure
    console.log('initializing electrobun project');

} else if (commandArg === 'build') {  
    

    if (existsSync(buildFolder)) {
        console.info('deleting build folder: ', buildFolder);
        rmdirSync(buildFolder, {recursive: true});

    }
    mkdirSync(buildFolder, {recursive: true})
    // bundle all the bundles
    for (const relSource in config.build.bundle) {
        const source = join(projectRoot, relSource);
        if (!existsSync(source)) {
            console.error(`failed to bundle ${source} because it doesn't exist.`);
            continue;
        }

        const bundleConfig = config.build.bundle[relSource];
        const outdir = join(buildFolder, (bundleConfig.outdir || ""));
        
        if (!existsSync(outdir)) {
            console.info('creating folder: ', outdir);
            mkdirSync(outdir, {recursive: true});
        }

        console.info(`bundling ${source} to ${outdir} with config: `, bundleConfig);

        const buildResult = await Bun.build({
            entrypoints: [source],
            outdir: outdir,
            external: bundleConfig.external,
            target: bundleConfig.target,
        })

        if (!buildResult.success) {
            console.error('failed to build', source, buildResult.logs);
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
            console.info('creating folder: ', destFolder);
            mkdirSync(destFolder, {recursive: true});
        }
        
        // todo (yoav): add ability to swap out BUILD VARS
        console.log('copying', source, 'to', destination);
        cpSync(source, destination, {recursive: true, dereference: true})
    }

    // todo (yoav): build native bindings for target
    
    // copy native bindings
    const zigNativeBinarySource = join(projectRoot, 'node_modules', 'electrobun', 'src', 'zig', 'zig-out', 'bin', 'webview');
    const zigNativeBinaryDestination = join(buildFolder, 'native', 'webview');
    const destFolder = dirname(zigNativeBinaryDestination);
    if (!existsSync(destFolder)) {
        console.info('creating folder: ', destFolder);
        mkdirSync(destFolder, {recursive: true});
    }
    console.log('copying', zigNativeBinarySource, 'to', zigNativeBinaryDestination);
    cpSync(zigNativeBinarySource, zigNativeBinaryDestination, {recursive: true});

    // compile the project
    console.log('building electrobun project');

} else if (commandArg === 'dev') {
    // run the project in dev mode
    // Note: this cli will be a bun single-file-executable
    // Note: we want to use the version of bun that's packaged with electrobun
    const bunPath = join(projectRoot, 'node_modules', '.bin', 'bun');
    const mainPath = join(buildFolder, config.main);
    console.log('running ', bunPath, mainPath);
    execSync(`${bunPath} ${mainPath}`);

    
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

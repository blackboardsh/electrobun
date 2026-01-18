export default {
    app: {
        name: "Electrobun (Playground)",
        identifier: "dev.electrobun.playground",
        version: "0.0.1",
        urlSchemes: ["electrobun-playground"],
    },
    build: {
        useAsar: true,
        bun: {
            entrypoint: "src/bun/index.ts",
            external: [],
        },
        views: {
            "test-runner": {
                entrypoint: "src/test-runner/index.ts",
                external: [],
            },
            "test-harness": {
                entrypoint: "src/test-harness/index.ts",
                external: [],
            },
            "playgrounds/file-dialog": {
                entrypoint: "src/playgrounds/file-dialog/index.ts",
                external: [],
            },
            "playgrounds/tray": {
                entrypoint: "src/playgrounds/tray/index.ts",
                external: [],
            },
            "playgrounds/shortcuts": {
                entrypoint: "src/playgrounds/shortcuts/index.ts",
                external: [],
            },
            "playgrounds/clipboard": {
                entrypoint: "src/playgrounds/clipboard/index.ts",
                external: [],
            },
            "playgrounds/host-message": {
                entrypoint: "src/playgrounds/host-message/index.ts",
                external: [],
            },
            "playgrounds/session": {
                entrypoint: "src/playgrounds/session/index.ts",
                external: [],
            },
            "playgrounds/draggable": {
                entrypoint: "src/playgrounds/draggable/index.ts",
                external: [],
            },
            "playgrounds/application-menu": {
                entrypoint: "src/playgrounds/application-menu/index.ts",
                external: [],
            },
            "playgrounds/context-menu": {
                entrypoint: "src/playgrounds/context-menu/index.ts",
                external: [],
            },
            "playgrounds/webviewtag": {
                entrypoint: "src/playgrounds/webviewtag/index.ts",
                external: [],
            },
            "playgrounds/window-events": {
                entrypoint: "src/playgrounds/window-events/index.ts",
                external: [],
            },
            "playgrounds/custom-titlebar": {
                entrypoint: "src/playgrounds/custom-titlebar/index.ts",
                external: [],
            },
            "playgrounds/transparent-window": {
                entrypoint: "src/playgrounds/transparent-window/index.ts",
                external: [],
            },
        },
        copy: {
            "src/test-runner/index.html": "views/test-runner/index.html",
            "src/test-runner/index.css": "views/test-runner/index.css",
            "src/test-harness/index.html": "views/test-harness/index.html",
            "src/playgrounds/file-dialog/index.html": "views/playgrounds/file-dialog/index.html",
            "src/playgrounds/file-dialog/index.css": "views/playgrounds/file-dialog/index.css",
            "src/playgrounds/tray/index.html": "views/playgrounds/tray/index.html",
            "src/playgrounds/tray/index.css": "views/playgrounds/tray/index.css",
            "src/playgrounds/shortcuts/index.html": "views/playgrounds/shortcuts/index.html",
            "src/playgrounds/shortcuts/index.css": "views/playgrounds/shortcuts/index.css",
            "src/playgrounds/clipboard/index.html": "views/playgrounds/clipboard/index.html",
            "src/playgrounds/clipboard/index.css": "views/playgrounds/clipboard/index.css",
            "src/playgrounds/host-message/index.html": "views/playgrounds/host-message/index.html",
            "src/playgrounds/session/index.html": "views/playgrounds/session/index.html",
            "src/playgrounds/session/counter.html": "views/playgrounds/session/counter.html",
            "src/playgrounds/draggable/index.html": "views/playgrounds/draggable/index.html",
            "src/playgrounds/application-menu/index.html": "views/playgrounds/application-menu/index.html",
            "src/playgrounds/application-menu/index.css": "views/playgrounds/application-menu/index.css",
            "src/playgrounds/context-menu/index.html": "views/playgrounds/context-menu/index.html",
            "src/playgrounds/context-menu/index.css": "views/playgrounds/context-menu/index.css",            
            "src/playgrounds/webviewtag/index.html": "views/playgrounds/webviewtag/index.html",
            "src/playgrounds/webviewtag/host-message-test.html": "views/playgrounds/webviewtag/host-message-test.html",
            "src/playgrounds/webviewtag/electrobun.png": "views/playgrounds/webviewtag/electrobun.png",
            "assets/electrobun-logo-32-template.png": "views/assets/electrobun-logo-32-template.png",
            "src/playgrounds/window-events/index.html": "views/playgrounds/window-events/index.html",
            "src/playgrounds/custom-titlebar/index.html": "views/playgrounds/custom-titlebar/index.html",
            "src/playgrounds/transparent-window/index.html": "views/playgrounds/transparent-window/index.html",
        },
        mac: {
            codesign: false,
            notarize: false,
            bundleCEF: true,
            entitlements: {},
        },
        linux: {
            bundleCEF: true,
        },
        win: {
            bundleCEF: true,
        },
    },
    scripts: {
        postBuild: "./buildScript.ts",
    },
    release: {
        bucketUrl: "https://static.electrobun.dev/playground/",
    },
};

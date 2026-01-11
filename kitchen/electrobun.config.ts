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
            "file-dialog-playground": {
                entrypoint: "src/file-dialog-playground/index.ts",
                external: [],
            },
            "tray-playground": {
                entrypoint: "src/tray-playground/index.ts",
                external: [],
            },
            "shortcuts-playground": {
                entrypoint: "src/shortcuts-playground/index.ts",
                external: [],
            },
            "clipboard-playground": {
                entrypoint: "src/clipboard-playground/index.ts",
                external: [],
            },
            "host-message-playground": {
                entrypoint: "src/host-message-playground/index.ts",
                external: [],
            },
            "session-playground": {
                entrypoint: "src/session-playground/index.ts",
                external: [],
            },
            "draggable-playground": {
                entrypoint: "src/draggable-playground/index.ts",
                external: [],
            },
            "application-menu-playground": {
                entrypoint: "src/application-menu-playground/index.ts",
                external: [],
            },
            "context-menu-playground": {
                entrypoint: "src/context-menu-playground/index.ts",
                external: [],
            },
            mainview: {
                entrypoint: "src/mainview/index.ts",
                external: [],
            },
            myextension: {
                entrypoint: "src/myextension/preload.ts",
                external: [],
            },
            webviewtag: {
                entrypoint: "src/webviewtag/index.ts",
                external: [],
            },
            "window-events-playground": {
                entrypoint: "src/window-events-playground/index.ts",
                external: [],
            },
        },
        copy: {
            "src/test-runner/index.html": "views/test-runner/index.html",
            "src/test-runner/index.css": "views/test-runner/index.css",
            "src/test-harness/index.html": "views/test-harness/index.html",
            "src/file-dialog-playground/index.html": "views/file-dialog-playground/index.html",
            "src/file-dialog-playground/index.css": "views/file-dialog-playground/index.css",
            "src/tray-playground/index.html": "views/tray-playground/index.html",
            "src/tray-playground/index.css": "views/tray-playground/index.css",
            "src/shortcuts-playground/index.html": "views/shortcuts-playground/index.html",
            "src/shortcuts-playground/index.css": "views/shortcuts-playground/index.css",
            "src/clipboard-playground/index.html": "views/clipboard-playground/index.html",
            "src/clipboard-playground/index.css": "views/clipboard-playground/index.css",
            "src/host-message-playground/index.html": "views/host-message-playground/index.html",
            "src/session-playground/index.html": "views/session-playground/index.html",
            "src/session-playground/counter.html": "views/session-playground/counter.html",
            "src/draggable-playground/index.html": "views/draggable-playground/index.html",
            "src/application-menu-playground/index.html": "views/application-menu-playground/index.html",
            "src/application-menu-playground/index.css": "views/application-menu-playground/index.css",
            "src/context-menu-playground/index.html": "views/context-menu-playground/index.html",
            "src/context-menu-playground/index.css": "views/context-menu-playground/index.css",
            "src/mainview/index.html": "views/mainview/index.html",
            "src/mainview/index.css": "views/mainview/index.css",
            "src/webviewtag/index.html": "views/webviewtag/index.html",
            "src/webviewtag/host-message-test.html": "views/webviewtag/host-message-test.html",
            "src/webviewtag/electrobun.png": "views/webviewtag/electrobun.png",
            "assets/electrobun-logo-32-template.png": "views/assets/electrobun-logo-32-template.png",
            "src/window-events-playground/index.html": "views/window-events-playground/index.html",
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
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
                entrypoint: "src/playgrounds/file-dialog/index.ts",
                external: [],
            },
            "tray-playground": {
                entrypoint: "src/playgrounds/tray/index.ts",
                external: [],
            },
            "shortcuts-playground": {
                entrypoint: "src/playgrounds/shortcuts/index.ts",
                external: [],
            },
            "clipboard-playground": {
                entrypoint: "src/playgrounds/clipboard/index.ts",
                external: [],
            },
            "host-message-playground": {
                entrypoint: "src/playgrounds/host-message/index.ts",
                external: [],
            },
            "session-playground": {
                entrypoint: "src/playgrounds/session/index.ts",
                external: [],
            },
            "draggable-playground": {
                entrypoint: "src/playgrounds/draggable/index.ts",
                external: [],
            },
            "application-menu-playground": {
                entrypoint: "src/playgrounds/application-menu/index.ts",
                external: [],
            },
            "context-menu-playground": {
                entrypoint: "src/playgrounds/context-menu/index.ts",
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
                entrypoint: "src/playgrounds/webviewtag/index.ts",
                external: [],
            },
            "window-events-playground": {
                entrypoint: "src/playgrounds/window-events/index.ts",
                external: [],
            },
        },
        copy: {
            "src/test-runner/index.html": "views/test-runner/index.html",
            "src/test-runner/index.css": "views/test-runner/index.css",
            "src/test-harness/index.html": "views/test-harness/index.html",
            "src/playgrounds/file-dialog/index.html": "views/file-dialog-playground/index.html",
            "src/playgrounds/file-dialog/index.css": "views/file-dialog-playground/index.css",
            "src/playgrounds/tray/index.html": "views/tray-playground/index.html",
            "src/playgrounds/tray/index.css": "views/tray-playground/index.css",
            "src/playgrounds/shortcuts/index.html": "views/shortcuts-playground/index.html",
            "src/playgrounds/shortcuts/index.css": "views/shortcuts-playground/index.css",
            "src/playgrounds/clipboard/index.html": "views/clipboard-playground/index.html",
            "src/playgrounds/clipboard/index.css": "views/clipboard-playground/index.css",
            "src/playgrounds/host-message/index.html": "views/host-message-playground/index.html",
            "src/playgrounds/session/index.html": "views/session-playground/index.html",
            "src/playgrounds/session/counter.html": "views/session-playground/counter.html",
            "src/playgrounds/draggable/index.html": "views/draggable-playground/index.html",
            "src/playgrounds/application-menu/index.html": "views/application-menu-playground/index.html",
            "src/playgrounds/application-menu/index.css": "views/application-menu-playground/index.css",
            "src/playgrounds/context-menu/index.html": "views/context-menu-playground/index.html",
            "src/playgrounds/context-menu/index.css": "views/context-menu-playground/index.css",
            "src/mainview/index.html": "views/mainview/index.html",
            "src/mainview/index.css": "views/mainview/index.css",
            "src/playgrounds/webviewtag/index.html": "views/webviewtag/index.html",
            "src/playgrounds/webviewtag/host-message-test.html": "views/webviewtag/host-message-test.html",
            "src/playgrounds/webviewtag/electrobun.png": "views/webviewtag/electrobun.png",
            "assets/electrobun-logo-32-template.png": "views/assets/electrobun-logo-32-template.png",
            "src/playgrounds/window-events/index.html": "views/window-events-playground/index.html",
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

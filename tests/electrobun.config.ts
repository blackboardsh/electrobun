export default {
    app: {
        name: "Electrobun Test Harness",
        identifier: "dev.electrobun.tests",
        version: "1.0.0",
    },
    build: {
        bun: {
            entrypoint: "src/bun/index.ts",
            external: [],
        },       
        views: {
            mainview: {
                entrypoint: "src/mainview/index.ts",
                external: [],
            },
            webviewtag: {
                entrypoint: "src/webviewtag/index.ts",
                external: [],
            },
        },
        copy: {
            "src/mainview/index.html": "views/mainview/index.html",
            "src/mainview/styles/main.css": "views/mainview/styles/main.css",
            "src/testviews/window-create.html": "views/testviews/window-create.html",
            "src/testviews/window-events.html": "views/testviews/window-events.html",
            "src/testviews/webview-mask.html": "views/testviews/webview-mask.html",
            "src/testviews/webview-navigation.html": "views/testviews/webview-navigation.html",
            "src/testviews/tray-test.html": "views/testviews/tray-test.html",
            "src/testviews/window-focus.html": "views/testviews/window-focus.html",
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
};
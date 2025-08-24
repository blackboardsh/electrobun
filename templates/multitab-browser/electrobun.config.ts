export default {
    app: {
        name: "multitab-browser",
        identifier: "multitab-browser.electrobun.dev",
        version: "0.0.1",
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
        },
        copy: {
            "src/mainview/index.html": "views/mainview/index.html",
            "src/mainview/index.css": "views/mainview/index.css",
        },
        mac: {
            bundleCEF: true,
        },
        linux: {
            bundleCEF: true,
        },
        win: {
            bundleCEF: true,
        },
    },
};
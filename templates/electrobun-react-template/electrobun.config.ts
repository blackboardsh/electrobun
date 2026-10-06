import type { ElectrobunConfig } from "electrobun";

export default {
    app: {
        name: "Your App",
        identifier: "your.app.identifier",
        version: "0.0.1",
    },
    build: {
        mainProcess: "bun",
        bun: {
            entrypoint: "src/bun/index.ts",
        },
        copy: {
            "dist/index.html": "views/mainview/index.html",
            "dist/assets": "views/mainview/assets",
        },
        watchIgnore: ["dist/**"],
        mac: {
            bundleCEF: false,
        },
        linux: {
            bundleCEF: false,
        },
        win: {
            bundleCEF: false,
        },
    },
} satisfies ElectrobunConfig;

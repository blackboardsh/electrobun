export default {
    app: {
        name: "hello-nuxt",
        identifier: "nuxt.template.electrobun.dev",
        version: "0.0.1",
    },
    build: {
        views: {
            
        },
        copy: {
            "src/nuxt/.output/public/": "views/nuxt/",
        },
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
};
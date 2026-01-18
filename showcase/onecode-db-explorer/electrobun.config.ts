export default {
  app: {
    name: "onecode-db-explorer",
    identifier: "onecodedbexplorer.electrobun.dev",
    version: "0.1.0",
  },
  build: {
    copy: {
      // We build the UI into dist/ and copy the whole folder into the main view.
      // dist/ must contain index.html + any assets it references.
      dist: "views/mainview",
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

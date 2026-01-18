import { join } from "path";
// @ts-expect-error - Types not important for this temporary plugin.
import { transformAsync } from "@babel/core";
// @ts-expect-error - Types not important for this temporary plugin.
import ts from "@babel/preset-typescript";
// @ts-expect-error - Types not important for this temporary plugin.
import solid from "babel-preset-solid";
import type { BunPlugin } from "bun";

const projectRoot = process.cwd();

const solidTransformPlugin: BunPlugin = {
  name: "bun-plugin-solid (temporary)",
  setup: (build) => {
    // Electrobun's API packages are shipped as TS source; resolve explicitly so Bun.build can bundle them.
    build.onResolve({ filter: /^electrobun\/view$/ }, () => {
      return {
        path: join(projectRoot, "node_modules/electrobun/dist/api/browser/index.ts"),
      };
    });

    build.onResolve({ filter: /^electrobun\/bun$/ }, () => {
      return {
        path: join(projectRoot, "node_modules/electrobun/dist/api/bun/index.ts"),
      };
    });

    // Bun sometimes resolves Solid's server builds. Force the browser variants instead.
    build.onLoad({ filter: /\/node_modules\/solid-js\/dist\/server\.js$/ }, async (args) => {
      const path = args.path.replace("server.js", "solid.js");
      const code = await Bun.file(path).text();
      return { contents: code, loader: "js" };
    });

    build.onLoad({ filter: /\/node_modules\/solid-js\/store\/dist\/server\.js$/ }, async (args) => {
      const path = args.path.replace("server.js", "store.js");
      const code = await Bun.file(path).text();
      return { contents: code, loader: "js" };
    });

    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
      const isNodeModule = /[\\/]+node_modules[\\/]+/.test(args.path);
      const isSolidNodeModule = /[\\/]+node_modules[\\/]+(?:@corvu[\\/]+|solid-)/.test(args.path);
      if (isNodeModule && !isSolidNodeModule) return;

      const code = await Bun.file(args.path).text();
      const transforms = await transformAsync(code, {
        filename: args.path,
        sourceType: "module",
        presets: [
          [
            solid,
            {
              moduleName: "solid-js/web",
              generate: "dom",
              hydratable: false,
              delegateEvents: true,
              wrapConditionals: true,
              contextToCustomElements: true,
            },
          ],
          [ts, { isTSX: true, allExtensions: true }],
        ],
      });

      return {
        contents: transforms?.code ?? "",
        loader: "js",
      };
    });
  },
};

export default solidTransformPlugin;

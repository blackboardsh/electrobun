// XXX: move these to fe files.ts
import * as monaco from "monaco-editor";
import { state, setState, type AppState } from "./store";
import type { CachedFileType } from "../../shared/types/types";
import { produce } from "solid-js/store";

import { electrobun } from "./init";

// TODO:
// 1. in the rendering flow, we should check if we have the file in the cache and subscribe to changes
// 2. when a file is not in the cache, it should fire an async request to get it's metadata including if it's a file or folder, if it exists
// and store whatever result in the cache
// 3. then the front-end should just check the cache for a file and render it without all these syncRPC checks.

// Think of the filesystem as a datastore. We want to keep a cache
// of files we interact with, but don't really care about anything else
// We use fileWatchers to update the cache if we've already cached something

// rename _getNode to getNodeFromCache that accounts for __internal nodes
// move the bun stuff to an async bun request that gets called in getNode() after that calls getNodeFromCache()
// other things can just be subscribed to the cache or the _getNode call
// maybe that'll just work?
const pendingNodeRequests: { [path: string]: boolean } = {};

// doesn't cache the node, useful inside setState(produce(_state => {const _node = _getNode(path, _state)})) blocks

export const _getNode = (
  path?: string,
  _state: AppState = state
): CachedFileType | undefined => {
  if (!path) {
    return;
  }

  // These are for pseudo nodes that don't exist on the filesystem
  if (path.startsWith("__COLAB_INTERNAL__")) {
    return {
      name: path.split("/").pop() || "",
      type: "dir",
      path: path,
      children: [],
    };
  }

  // Template nodes for quick access (browser, file, terminal, agent)
  if (path.startsWith("__COLAB_TEMPLATE__")) {
    // Check if we already have this template cached
    if (_state.fileCache[path]) {
      return _state.fileCache[path];
    }

    // Extract the template type from the path (handles unique IDs like browser-chromium/abc123)
    const pathParts = path.replace("__COLAB_TEMPLATE__/", "").split("/");
    const templateId = pathParts[0]; // e.g., "browser-chromium" or "browser-webkit"
    let templateNode: CachedFileType;

    // Browser and agent templates are directory nodes with slates
    if (templateId === "browser" || templateId === "browser-chromium" || templateId === "browser-webkit" || templateId === "agent") {
      templateNode = {
        name: templateId,
        type: "dir",
        path: path,
        children: [],
      };
    }
    // Terminal template (file node, but not actually opened as a file)
    else {
      templateNode = {
        name: templateId,
        type: "file",
        path: path,
        persistedContent: "",
        isDirty: false,
        model: null,
        editors: {},
      };
    }

    // Cache the template node so it returns the same reference
    setState("fileCache", path, templateNode);
    return templateNode;
  }

  if (_state.fileCache[path]) {
    return _state.fileCache[path];
  }

  if (pendingNodeRequests[path]) {
    return;
  }

  pendingNodeRequests[path] = true;
  // Note: because this is async there's a race condition with the early exit above
  // where multiple things can call getNode for the same path triggering multiple calls
  // todo: We need to update the architecture to have a pending state for state objects like this
  electrobun.rpc?.request.getNode({ path }).then((node) => {
    delete pendingNodeRequests[path];

    if (node) {
      // Only update the cache if we don't already have it
      // since this is getNode(). actual changes to the node
      // will be handled by fileWatchers/events
      if (!state.fileCache[path]) {
        setState("fileCache", path, node);
      }
    }
  });
};

// typically used in code, will cache the node if it's not already cached
export const getNode = (path?: string): CachedFileType | undefined => {
  const node = _getNode(path);

  if (!path || !node) {
    return;
  }

  return node;
};

// todo (yoav): rename to createOrFetchModel
export const createModel = async (absolutePath: string) => {
  // Handle template file paths - they don't exist on disk, so provide empty content
  let contents = "";
  if (absolutePath.startsWith("__COLAB_TEMPLATE__")) {
    contents = "";
  } else {
    const fileContents = await electrobun.rpc?.request.readFile({
      path: absolutePath,
    }); //?.slice(0, 1024 * 1024 * 2); //, "utf-8");
    contents = fileContents?.textContent || "";
  }

  const filename = absolutePath.split("/").pop() || "";
  const extension = absolutePath.split(".").pop() || "";
  const language = getLanguageForFile(filename, extension);
  // it knows about. In fact it does this when you open a typescript file, but also as you type in the editor
  // if you add a new type import. It's funny that id does this because you _also_ have to externally
  // addExtraLib or create a model for those files for type hinting to work.
  let model = monaco.editor.getModel(monaco.Uri.parse(absolutePath));
  if (!model) {
    model = monaco.editor.createModel(
      contents,
      language,
      monaco.Uri.parse(absolutePath)
    );

    // maybe multiple editors can share the same model that the user has actually opened?
    setState(
      produce((_state: AppState) => {
        const node = _state.fileCache[absolutePath];
        if (node && node.type === "file") {
          node.model = model;
          node.persistedContent = contents;
          node.isCached = true; // Mark file as loaded so external changes trigger editor updates
        }
      })
    );
  }

  return model;
};

const extensionsToLanguages: Record<string, string> = {
  // JavaScript/TypeScript
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",

  // Web
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",

  // Data/Config
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini", // Monaco doesn't have toml, ini is close
  ini: "ini",
  xml: "xml",
  svg: "xml",

  // Documentation
  md: "markdown",
  mdx: "mdx",

  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",

  // Other languages
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "cpp",
  cpp: "cpp",
  h: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  r: "r",
  lua: "lua",
  pl: "perl",
  scala: "scala",
  zig: "rust", // No zig support, rust is somewhat similar

  // DevOps/Config
  dockerfile: "dockerfile",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",

  // Other
  lock: "json", // bun.lock, package-lock.json
};

// Special filenames that should use specific languages
const filenameToLanguage: Record<string, string> = {
  "Dockerfile": "dockerfile",
  "Makefile": "shell",
  "Gemfile": "ruby",
  "Rakefile": "ruby",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".env": "ini",
  ".env.local": "ini",
  ".env.development": "ini",
  ".env.production": "ini",
  ".prettierrc": "json",
  ".eslintrc": "json",
  "tsconfig.json": "json",
  "package.json": "json",
  "bun.lockb": "json",
};

const getLanguageForFile = (filename: string, extension: string): string => {
  // Check special filenames first
  if (filename in filenameToLanguage) {
    return filenameToLanguage[filename];
  }

  // Then check extension
  if (extension in extensionsToLanguages) {
    return extensionsToLanguages[extension];
  }

  return "plaintext";
};

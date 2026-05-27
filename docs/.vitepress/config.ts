import { defineConfig } from "vitepress";

export default defineConfig({
  vue: {
    template: {
      compilerOptions: {
        isCustomElement: (tag) =>
          tag.startsWith("electrobun-") || tag === "electroview",
      },
    },
  },
  title: "Electrobun",
  description:
    "Build ultra fast, tiny, cross-platform desktop apps with TypeScript.",
  head: [["link", { rel: "icon", href: "/favicon.ico" }]],

  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "Electrobun",

    nav: [
      { text: "Guide", link: "/guide/quick-start" },
      { text: "API Reference", link: "/api/bun" },
      {
        text: "Changelog",
        link: "/changelog/",
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Getting Started",
          items: [
            { text: "Quick Start", link: "/guide/quick-start" },
            { text: "What is Electrobun?", link: "/guide/what-is-electrobun" },
            { text: "Hello World", link: "/guide/hello-world" },
            { text: "Creating UI", link: "/guide/creating-ui" },
            {
              text: "Bundling & Distribution",
              link: "/guide/bundling-and-distribution",
            },
          ],
        },
        {
          text: "Advanced",
          items: [
            {
              text: "Cross-Platform Development",
              link: "/guide/cross-platform-development",
            },
            { text: "Compatibility", link: "/guide/compatibility" },
            { text: "Code Signing", link: "/guide/code-signing" },
            {
              text: "Architecture Overview",
              link: "/guide/architecture-overview",
            },
            {
              text: "Webview Tag Architecture",
              link: "/guide/architecture-webview-tag",
            },
            { text: "Updates", link: "/guide/updates" },
          ],
        },
      ],
      "/api/": [
        {
          text: "Bun APIs",
          items: [
            { text: "Bun API", link: "/api/bun" },
            { text: "BrowserWindow", link: "/api/browser-window" },
            { text: "BrowserView", link: "/api/browser-view" },
            { text: "WebGPU", link: "/api/webgpu" },
            { text: "Utils", link: "/api/utils" },
            { text: "Context Menu", link: "/api/context-menu" },
            { text: "Application Menu", link: "/api/application-menu" },
            { text: "Paths", link: "/api/paths" },
            { text: "Tray", link: "/api/tray" },
            { text: "Updater", link: "/api/updater" },
            { text: "Events", link: "/api/events" },
            { text: "BuildConfig", link: "/api/build-config" },
          ],
        },
        {
          text: "Browser APIs",
          items: [
            { text: "Electroview Class", link: "/api/browser-electroview" },
            { text: "Webview Tag", link: "/api/browser-webview-tag" },
            { text: "WGPU Tag", link: "/api/browser-wgpu-tag" },
            {
              text: "Draggable Regions",
              link: "/api/browser-draggable-regions",
            },
            {
              text: "Global Properties",
              link: "/api/browser-global-properties",
            },
          ],
        },
        {
          text: "CLI & Configuration",
          items: [
            { text: "Build Configuration", link: "/api/build-configuration" },
            { text: "CLI Arguments", link: "/api/cli-args" },
            { text: "Bundled Assets", link: "/api/bundled-assets" },
            { text: "Bundling CEF", link: "/api/bundling-cef" },
            { text: "Application Icons", link: "/api/application-icons" },
          ],
        },
      ],
      "/changelog/": [
        {
          text: "Changelog",
          items: [
            { text: "All Releases", link: "/changelog/" },
            { text: "Unreleased", link: "/changelog/unreleased" },
            { text: "v1.18.1", link: "/changelog/v1-18-1" },
            { text: "v1.18.0", link: "/changelog/v1-18-0" },
            { text: "v1.16.0", link: "/changelog/v1-16-0" },
            { text: "v1.15.1", link: "/changelog/v1-15-1" },
            { text: "v1.14.4", link: "/changelog/v1-14-4" },
            { text: "v1.14.3", link: "/changelog/v1-14-3" },
            { text: "v1.13.1", link: "/changelog/v1-13-1" },
            { text: "v1.12.3", link: "/changelog/v1-12-3" },
            { text: "v1.12.1", link: "/changelog/v1-12-1" },
            {
              text: "v1.0.0 — Migrating from 0.x",
              link: "/changelog/v1-0-0",
            },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/blackboardsh/electrobun" },
      { icon: "discord", link: "https://discord.gg/ueKE4tjaCE" },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern:
        "https://github.com/AkaraChen/electrobun/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2024-present Electrobun Contributors",
    },
  },
});

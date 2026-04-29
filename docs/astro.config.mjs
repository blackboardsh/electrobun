// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.electrobunny.ai",
  integrations: [
    starlight({
      title: "Electrobun Docs",
      description:
        "Build ultra fast, tiny, cross-platform desktop apps with TypeScript.",
      social: {
        github: "https://github.com/blackboardsh/electrobun",
        discord: "https://discord.gg/ueKE4tjaCE",
      },
      sidebar: [
        {
          label: "Electrobun",
          items: [
            { label: "Overview", link: "/electrobun/" },
            {
              label: "Getting Started",
              items: [
                { label: "Quick Start", link: "/electrobun/guides/quick-start/" },
                { label: "What is Electrobun?", link: "/electrobun/guides/what-is-electrobun/" },
                { label: "Hello World", link: "/electrobun/guides/hello-world/" },
                { label: "Creating UI", link: "/electrobun/guides/creating-ui/" },
                { label: "Bundling & Distribution", link: "/electrobun/guides/bundling-and-distribution/" },
              ],
            },
            {
              label: "Advanced Guides",
              items: [
                { label: "Cross-Platform Development", link: "/electrobun/guides/cross-platform-development/" },
                { label: "Compatibility", link: "/electrobun/guides/compatability/" },
                { label: "Code Signing", link: "/electrobun/guides/code-signing/" },
                { label: "Architecture Overview", link: "/electrobun/guides/architecture/overview/" },
                { label: "Webview Tag Architecture", link: "/electrobun/guides/architecture/webview-tag/" },
                { label: "Updates", link: "/electrobun/guides/updates/" },
                {
                  label: "Changelog",
                  collapsed: true,
                  items: [
                    { label: "All releases", link: "/electrobun/guides/changelog/" },
                    { label: "Unreleased", link: "/electrobun/guides/changelog/unreleased/" },
                    { label: "v1.16.0", link: "/electrobun/guides/changelog/v1-16-0/" },
                    { label: "v1.15.1", link: "/electrobun/guides/changelog/v1-15-1/" },
                    { label: "v1.14.4", link: "/electrobun/guides/changelog/v1-14-4/" },
                    { label: "v1.14.3", link: "/electrobun/guides/changelog/v1-14-3/" },
                    { label: "v1.13.1", link: "/electrobun/guides/changelog/v1-13-1/" },
                    { label: "v1.12.3", link: "/electrobun/guides/changelog/v1-12-3/" },
                    { label: "v1.12.1", link: "/electrobun/guides/changelog/v1-12-1/" },
                    { label: "v1.0.0 — Migrating from 0.x", link: "/electrobun/guides/changelog/v1-0-0/" },
                  ],
                },
              ],
            },
            {
              label: "Bun APIs",
              items: [
                { label: "Bun API", link: "/electrobun/apis/bun/" },
                { label: "BrowserWindow", link: "/electrobun/apis/browser-window/" },
                { label: "BrowserView", link: "/electrobun/apis/browser-view/" },
                { label: "WebGPU", link: "/electrobun/apis/webgpu/" },
                { label: "Utils", link: "/electrobun/apis/utils/" },
                { label: "Context Menu", link: "/electrobun/apis/context-menu/" },
                { label: "Application Menu", link: "/electrobun/apis/application-menu/" },
                { label: "Paths", link: "/electrobun/apis/paths/" },
                { label: "Tray", link: "/electrobun/apis/tray/" },
                { label: "Updater", link: "/electrobun/apis/updater/" },
                { label: "Events", link: "/electrobun/apis/events/" },
                { label: "BuildConfig", link: "/electrobun/apis/build-config/" },
              ],
            },
            {
              label: "Browser APIs",
              items: [
                { label: "Electroview Class", link: "/electrobun/apis/browser/electroview-class/" },
                { label: "Webview Tag", link: "/electrobun/apis/browser/electrobun-webview-tag/" },
                { label: "WGPU Tag", link: "/electrobun/apis/browser/electrobun-wgpu-tag/" },
                { label: "Draggable Regions", link: "/electrobun/apis/browser/draggable-regions/" },
                { label: "Global Properties", link: "/electrobun/apis/browser/global-properties/" },
              ],
            },
            {
              label: "CLI & Configuration",
              items: [
                { label: "Build Configuration", link: "/electrobun/apis/cli/build-configuration/" },
                { label: "CLI Arguments", link: "/electrobun/apis/cli/cli-args/" },
                { label: "Bundled Assets", link: "/electrobun/apis/bundled-assets/" },
                { label: "Bundling CEF", link: "/electrobun/apis/bundling-cef/" },
                { label: "Application Icons", link: "/electrobun/apis/application-icons/" },
              ],
            },
          ],
        },
      ],
    }),
  ],
});

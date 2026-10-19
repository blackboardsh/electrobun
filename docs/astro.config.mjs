// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { readFileSync } from "node:fs";

const sidebar = JSON.parse(
  readFileSync(new URL("./sidebar.json", import.meta.url), "utf8"),
);

export default defineConfig({
  site: "https://framework.blackboard.sh",
  integrations: [
    starlight({
      title: "Electrobun Docs",
      description:
        "Build ultra fast, tiny, cross-platform desktop apps with TypeScript.",
      social: {
        github: "https://github.com/blackboardsh/electrobun",
        discord: "https://discord.gg/ueKE4tjaCE",
      },
      sidebar,
    }),
  ],
});

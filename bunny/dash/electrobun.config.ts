import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Bunny Dash",
    identifier: "dev.electrobun.bunny-dash",
    version: "0.0.1",
  },
  bunny: {
    carrot: {
      dependencies: {
        "bunny.pty": "file:../foundation-carrots/pty",
        "bunny.search": "file:../foundation-carrots/search",
        "bunny.git": "file:../foundation-carrots/git",
        "bunny.tsserver": "file:../foundation-carrots/tsserver",
        "bunny.biome": "file:../foundation-carrots/biome",
        "bunny.llama": "file:../foundation-carrots/llama",
      },
    },
  },
} satisfies ElectrobunConfig;

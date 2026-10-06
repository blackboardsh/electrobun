import { electrobunAliases } from "./src/shared/helpers/electrobun";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const devkitRoot = fileURLToPath(new URL("./.hutch/devkit", import.meta.url));

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: electrobunAliases(devkitRoot),
        tsconfigPaths: true,
    },
    root: "src/mainview",
    base: "./",
    build: {
        outDir: "../../dist",
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        strictPort: true,
    },
});

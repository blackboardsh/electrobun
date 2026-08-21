import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,

      // This is necessary so that tanstack router knows where the routes folder is located and generates the necessary types
      routesDirectory: "../../src/mainview/routes",
      generatedRouteTree: "../../src/mainview/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
  ],
  root: "src/mainview",
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});

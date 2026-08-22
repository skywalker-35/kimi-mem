import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webRoot = import.meta.dirname;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      $lib: path.resolve(webRoot, "src/lib"),
      $shared: path.resolve(webRoot, "../src/shared"),
      "@": path.resolve(webRoot, "src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4747",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(webRoot, "../dist/web"),
    emptyOutDir: true,
  },
  base: "/",
});

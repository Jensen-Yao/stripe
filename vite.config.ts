import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "satellite.js/dist/wasm/index.js": path.resolve(__dirname, "src/utils/emptySatelliteWasm.ts"),
      "./wasm/index.js": path.resolve(__dirname, "src/utils/emptySatelliteWasm.ts")
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});

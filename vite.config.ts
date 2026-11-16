import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
export default defineConfig({
  plugins: [react()],
  define: { __RELAY_VERSION__: JSON.stringify(version) },
  server: {
    host: "127.0.0.1",
    watch: {
      ignored: [
        "**/release/**",
        "**/data/**",
        "**/test-results/**",
      ],
    },
  },
  build: { outDir: "dist" },
});

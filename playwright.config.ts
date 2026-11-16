import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 240000,
  expect: { timeout: 30000 },
  use: {
    baseURL: "http://127.0.0.1:5180",
    channel: process.env.RELAY_BROWSER_CHANNEL || "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    launchOptions: { timeout: 180000 },
  },
  webServer: {
    command: "node server/index.mjs",
    url: "http://127.0.0.1:5180/api/session",
    reuseExistingServer: false,
    timeout: 180000,
    env: {
      PORT: "5180",
      NODE_ENV: "production",
      DATA_DIR: path.join(os.tmpdir(), `relay-e2e-${process.pid}`),
    },
  },
});

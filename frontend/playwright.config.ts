import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "./test",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3108",
    viewport: { width: 390, height: 844 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: "npm --prefix .. run build && npm --prefix .. run dev",
    url: "http://127.0.0.1:3108/api/health",
    env: {
      PORT: "3108",
      DATA_DIR: mkdtempSync(join(tmpdir(), "boulder-ui-test-")),
      BETA7_OFF: "1",
    },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

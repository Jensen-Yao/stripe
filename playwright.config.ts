import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4180", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: { command: "npm run preview -- --port 4180", url: "http://127.0.0.1:4180", reuseExistingServer: true, timeout: 120000 }
});

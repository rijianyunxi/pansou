import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3311";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "zh-CN",
  },
  webServer: {
    command:
      "node -e \"const fs=require('node:fs'); fs.rmSync('.tmp/e2e/nuxt',{recursive:true,force:true}); ['panhub.sqlite','plugins.json','search-settings.json'].forEach(f=>fs.rmSync('.tmp/e2e/'+f,{force:true}))\" && PANHUB_E2E=1 PANHUB_BUILD_DIR=.tmp/e2e/nuxt PANHUB_SQLITE_DB=.tmp/e2e/panhub.sqlite ADMIN_PASSWORD=e2e-admin-password PANHUB_SEARCH_SETTINGS_STORE=.tmp/e2e/search-settings.json PANHUB_PLUGIN_STORE=.tmp/e2e/plugins.json pnpm dev --host 127.0.0.1 --port 3311",
    url: `${baseURL}/api/auth/admin-status`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "desktop-chromium",
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
});

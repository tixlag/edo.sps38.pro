import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // In sandboxes without browser download, point to a cached build:
        // PLAYWRIGHT_CHROMIUM_PATH=~/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : undefined,
      },
    },
  ],
  // Dev servers must be running: `pnpm dev` (web :5173) + API (:3001).
  webServer: undefined,
});

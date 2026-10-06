import { defineConfig, devices } from "@playwright/test";

const PORT = 3711;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/*
 * Acceptance runs against a production build in demo mode. The demo executes
 * the real pipeline on both revisions, so the timeouts below are sized for
 * genuine test execution rather than a simulated delay.
 */
export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === "true",
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 240_000 },
  reporter: process.env.CI === "true" ? "line" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @codeatlas/web build && pnpm --filter @codeatlas/web start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { CODEATLAS_DEMO_MODE: "true" },
  },
});

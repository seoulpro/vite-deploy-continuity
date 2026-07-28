import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? "line" : "list",
  outputDir: "output/playwright",
  use: {
    browserName: "chromium",
    headless: true,
  },
});

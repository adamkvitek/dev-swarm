import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Discord UX testing.
 *
 * This is for local/manual UX verification of the Discord bot.
 * Discord auth makes CI impractical — run these tests locally
 * after setting up auth with `npm run test:e2e:setup`.
 *
 * Env var: DISCORD_TEST_CHANNEL_URL — full URL to the test channel
 * e.g. https://discord.com/channels/SERVER_ID/CHANNEL_ID
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // Discord tests must run serially
  retries: 0,
  reporter: "list",

  use: {
    baseURL: "https://discord.com",
    storageState: "tests/e2e/.auth/discord.json",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    // Run once to save Discord login state
    {
      name: "setup",
      testMatch: "auth.setup.ts",
      use: {
        storageState: undefined, // No saved state — we're creating it
      },
    },
    {
      name: "discord-chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
      dependencies: [], // Don't auto-run setup — it requires manual login
    },
  ],
});

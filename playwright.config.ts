import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Discord UX testing.
 *
 * For contributors / testers — first-time setup:
 *
 *   1. Set env vars in .env (see .env.example):
 *      DISCORD_TEST_CHANNEL_URL=https://discord.com/channels/YOUR_SERVER_ID/YOUR_CHANNEL_ID
 *      DISCORD_BOT_NAME=YourBotName
 *
 *   2. Run the auth setup (opens a browser — log into Discord, then click Resume):
 *      npm run test:e2e:setup
 *
 *   3. Run the tests:
 *      npm run test:e2e
 *
 * The auth state (Discord cookies) is saved locally and gitignored.
 * Re-run step 2 if your session expires.
 */

// Ensure auth state file exists — Playwright validates the path at config load
// time even for projects that override storageState. The file is gitignored so
// it disappears on branch switches and fresh clones.
const AUTH_STATE_PATH = "tests/e2e/.auth/discord.json";
if (!existsSync(AUTH_STATE_PATH)) {
  mkdirSync("tests/e2e/.auth", { recursive: true });
  writeFileSync(AUTH_STATE_PATH, '{"cookies":[],"origins":[]}');
}

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // Discord tests must run serially
  retries: 0,
  reporter: "list",

  use: {
    baseURL: "https://discord.com",
    storageState: AUTH_STATE_PATH,
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

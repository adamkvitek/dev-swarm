import { test as setup } from "@playwright/test";

/**
 * Auth setup for Discord UX tests.
 *
 * Run once with: npm run test:e2e:setup
 *
 * This opens Discord in a browser and pauses so you can log in manually.
 * After logging in, press "Resume" in the Playwright inspector — the
 * browser state (cookies, localStorage) is saved to tests/e2e/.auth/discord.json.
 *
 * Subsequent test runs reuse the saved state and skip login.
 * Re-run this setup if your Discord session expires.
 */
setup("save Discord auth state", async ({ page }) => {
  // Navigate to Discord login
  await page.goto("https://discord.com/login");

  // Pause for manual login.
  // The user logs in with their Discord credentials in the browser,
  // then clicks "Resume" in the Playwright inspector panel.
  await page.pause();

  // Wait for Discord to fully load after login
  // The guild sidebar or friends list indicates successful auth
  await page.waitForSelector(
    '[class*="guilds"], [class*="sidebar"], [data-list-id="guildsnav"]',
    { timeout: 30_000 },
  );

  // Save the authenticated browser state
  await page.context().storageState({ path: "tests/e2e/.auth/discord.json" });
});

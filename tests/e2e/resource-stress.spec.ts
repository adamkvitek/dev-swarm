import { test, expect, type Page } from "@playwright/test";

/**
 * Resource stress tests for the dev-swarm bot.
 *
 * These tests verify that the bot's resource monitoring (memory + CPU)
 * is visible through Discord interactions. They are destructive and slow
 * — gated behind DISCORD_STRESS_TEST=true.
 *
 * Requirements:
 *   1. A running bot instance (`npm run dev`)
 *   2. Saved auth state (`npm run test:e2e:setup`)
 *   3. Environment variables:
 *
 *      DISCORD_TEST_CHANNEL_URL  — full URL to the test channel
 *      DISCORD_BOT_NAME          — display name of the bot
 *      DISCORD_STRESS_TEST=true  — opt-in flag for these tests
 *
 * Run with:
 *   DISCORD_TEST_CHANNEL_URL=YOUR_CHANNEL_URL \
 *   DISCORD_BOT_NAME=YOUR_BOT_NAME \
 *   DISCORD_STRESS_TEST=true \
 *   npm run test:e2e
 */

const CHANNEL_URL = process.env.DISCORD_TEST_CHANNEL_URL;
const BOT_NAME = process.env.DISCORD_BOT_NAME;
const STRESS_TEST = process.env.DISCORD_STRESS_TEST === "true";
const MSG_SELECTOR = 'li[id^="chat-messages-"]';
const BOT_TAG_SELECTOR = '[class*="botTag"], [class*="appTag"]';

test.beforeEach(async ({ page }) => {
  if (!CHANNEL_URL || !BOT_NAME || !STRESS_TEST) {
    test.skip(
      true,
      "DISCORD_TEST_CHANNEL_URL, DISCORD_BOT_NAME, or DISCORD_STRESS_TEST not set — skipping",
    );
    return;
  }

  await page.goto(CHANNEL_URL);
  await page.waitForSelector('[role="textbox"]', { timeout: 30_000 });
  await page.waitForTimeout(2_000);
});

// ---------------------------------------------------------------------------
// Helpers (same pattern as discord-ux.spec.ts)
// ---------------------------------------------------------------------------

/**
 * Send a message mentioning the bot.
 *
 * Types "@BOT_NAME" character by character to trigger Discord's autocomplete,
 * clicks the first match, then types the rest and presses Enter.
 * Returns the message count before sending (for waitForBotResponse).
 */
async function sendBotMessage(
  page: Page,
  message: string,
): Promise<number> {
  const textbox = page.locator('[role="textbox"]').last();
  await textbox.click();

  const prefix = BOT_NAME!.slice(0, 4);
  await textbox.pressSequentially(`@${prefix}`, { delay: 100 });
  await page.waitForTimeout(1_500);

  const option = page.locator(
    '[data-list-id="channel-autocomplete"] [role="option"]',
  ).first();
  await option.click();
  await page.waitForTimeout(500);

  await page.keyboard.type(` ${message}`, { delay: 30 });
  await page.waitForTimeout(300);

  const before = await page.locator(MSG_SELECTOR).count();
  await page.keyboard.press("Enter");
  return before;
}

/**
 * Wait for bot response(s) after sending a message.
 *
 * Collects ALL new bot messages (responses may be split across multiple
 * Discord messages for long content). Waits until no new bot messages
 * appear for 3 consecutive seconds, indicating the response is complete.
 */
async function waitForBotResponse(
  page: Page,
  msgCountBefore: number,
  timeoutMs: number = 90_000,
): Promise<{ text: string; ms: number; messageCount: number }> {
  const startTime = Date.now();
  let lastBotText = "";
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    await page.waitForTimeout(2_000);

    const currentCount = await page.locator(MSG_SELECTOR).count();
    if (currentCount <= msgCountBefore) continue;

    // Collect all new bot messages
    const botTexts: string[] = [];
    for (let i = msgCountBefore; i < currentCount; i++) {
      const msg = page.locator(MSG_SELECTOR).nth(i);
      const isBot = await msg.locator(BOT_TAG_SELECTOR).count();
      if (isBot > 0) {
        botTexts.push((await msg.textContent()) ?? "");
      }
    }

    if (botTexts.length === 0) continue;

    const combined = botTexts.join("\n");

    // Check if response has stabilized (no growth for 2 polls = 4s)
    if (combined === lastBotText) {
      stableCount++;
      if (stableCount >= 2) {
        return {
          text: combined,
          ms: Date.now() - startTime,
          messageCount: botTexts.length,
        };
      }
    } else {
      stableCount = 0;
      lastBotText = combined;
    }
  }

  // Return whatever we have, even if not fully stable
  if (lastBotText) {
    return { text: lastBotText, ms: Date.now() - startTime, messageCount: 1 };
  }

  throw new Error(`No bot response within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Discord Bot Resource Stress", () => {
  test("bot reports resource status including CPU", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME || !STRESS_TEST) return;

    const before = await sendBotMessage(
      page,
      "check your current resource status — report memory %, CPU %, and worker count",
    );
    const response = await waitForBotResponse(page, before, 90_000);

    expect(response.text.length).toBeGreaterThan(0);
    expect(response.text).not.toContain("Something went wrong");

    // Response should mention both memory and CPU metrics
    const lower = response.text.toLowerCase();
    expect(lower).toMatch(/memory|ram/);
    expect(lower).toMatch(/cpu/);
    expect(lower).toMatch(/worker/);
  });

  test("bot explains resource constraints when asked about spawning", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME || !STRESS_TEST) return;

    const before = await sendBotMessage(
      page,
      "can you spawn workers right now? explain your current resource constraints including CPU and memory",
    );
    const response = await waitForBotResponse(page, before, 90_000);

    expect(response.text.length).toBeGreaterThan(0);
    expect(response.text).not.toContain("Something went wrong");

    // Bot should reference resource status in its response
    const lower = response.text.toLowerCase();
    expect(lower).toMatch(/cpu|memory|worker|resource/);
  });
});

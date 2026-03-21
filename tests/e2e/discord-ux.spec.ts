import { test, expect, type Page } from "@playwright/test";

/**
 * Discord UX tests for the dev-swarm bot.
 *
 * These tests verify the bot's behavior in a real Discord channel.
 * They require:
 *
 *   1. A running bot instance connected to Discord (`npm run dev`)
 *   2. Saved auth state (run `npm run test:e2e:setup` first)
 *   3. Environment variables:
 *
 *      DISCORD_TEST_CHANNEL_URL
 *        Full URL to the test channel.
 *        Replace SERVER_ID and CHANNEL_ID with your values.
 *        Example: https://discord.com/channels/123456789/987654321
 *
 *      DISCORD_BOT_NAME
 *        Display name of the bot in your Discord server.
 *        Replace YOUR_BOT_NAME with the name you gave your bot.
 *        Example: dev-swarm
 *
 * Run with:
 *   DISCORD_TEST_CHANNEL_URL=YOUR_CHANNEL_URL \
 *   DISCORD_BOT_NAME=YOUR_BOT_NAME \
 *   npm run test:e2e
 */

const CHANNEL_URL = process.env.DISCORD_TEST_CHANNEL_URL;
const BOT_NAME = process.env.DISCORD_BOT_NAME;
const MSG_SELECTOR = 'li[id^="chat-messages-"]';
const BOT_TAG_SELECTOR = '[class*="botTag"], [class*="appTag"]';

test.beforeEach(async ({ page }) => {
  if (!CHANNEL_URL || !BOT_NAME) {
    test.skip(
      true,
      "DISCORD_TEST_CHANNEL_URL or DISCORD_BOT_NAME not set — skipping",
    );
    return;
  }

  await page.goto(CHANNEL_URL);
  await page.waitForSelector('[role="textbox"]', { timeout: 30_000 });
  await page.waitForTimeout(2_000);
});

// ---------------------------------------------------------------------------
// Helpers
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

test.describe("Discord Bot UX", () => {
  test("typing indicator appears after mention", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    await sendBotMessage(page, "hello");

    const typingIndicator = page.locator(
      '[class*="typing"], [class*="typingIndicator"]',
    ).first();
    await expect(typingIndicator).toBeVisible({ timeout: 5_000 });
  });

  test("no hardware banner in recent bot messages", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    // Only check bot messages, not user messages that may quote old banners
    const botMessages = await page.evaluate(
      (sel) => {
        const items = document.querySelectorAll(sel);
        return Array.from(items)
          .slice(-15)
          .filter((i) =>
            i.querySelector('[class*="botTag"], [class*="appTag"]'),
          )
          .map((i) => i.textContent?.toLowerCase() ?? "");
      },
      MSG_SELECTOR,
    );

    const botText = botMessages.join(" ");
    if (botText.length > 0) {
      expect(botText).not.toMatch(/system initialized.*detected.*cpu cores/);
      expect(botText).not.toMatch(/override with env vars/);
    }
  });

  test("responds within 90 seconds", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    const before = await sendBotMessage(page, "ping");
    const response = await waitForBotResponse(page, before, 90_000);

    expect(response.text.length).toBeGreaterThan(0);
    expect(response.text).not.toContain("Something went wrong");
  });

  test("responds with conversational text, not JSON or errors", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    const before = await sendBotMessage(page, "hello, how are you?");
    const response = await waitForBotResponse(page, before, 90_000);

    expect(response.text).not.toMatch(/^\s*\{/);
    expect(response.text).not.toMatch(/^\s*\[/);
    expect(response.text).not.toContain("ENOENT");
    expect(response.text).not.toContain("stack trace");
    expect(response.text).not.toContain("Something went wrong");

    // Has actual words
    expect(response.text.trim().split(/\s+/).length).toBeGreaterThan(2);
  });

  test("retains conversation context across messages", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    // First message: establish a topic
    const b1 = await sendBotMessage(
      page,
      "remember the word PINEAPPLE. Just confirm you got it.",
    );
    const r1 = await waitForBotResponse(page, b1, 90_000);
    expect(r1.text).not.toContain("Something went wrong");

    // Second message: ask about the topic
    const b2 = await sendBotMessage(
      page,
      "what was the word I asked you to remember?",
    );
    const r2 = await waitForBotResponse(page, b2, 90_000);

    expect(r2.text.toLowerCase()).toContain("pineapple");
  });

  test("messages are never dropped (always gets a response)", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    const before = await sendBotMessage(
      page,
      "respond with exactly: ACKNOWLEDGED",
    );
    const response = await waitForBotResponse(page, before, 90_000);

    expect(response.text).toContain("ACKNOWLEDGED");
  });

  test("long responses render correctly (multi-message splitting)", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    const before = await sendBotMessage(
      page,
      "explain how git worktrees work in detail with 3 practical examples. Be thorough.",
    );
    const response = await waitForBotResponse(page, before, 120_000);

    // Should be a substantial response
    expect(response.text.length).toBeGreaterThan(200);
    // Should mention git worktrees
    expect(response.text.toLowerCase()).toMatch(/worktree/);
    // No errors
    expect(response.text).not.toContain("Something went wrong");
  });
});

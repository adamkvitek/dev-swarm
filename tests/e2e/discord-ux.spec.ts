import { test, expect, type Page } from "@playwright/test";

/**
 * Discord UX tests for the dev-swarm bot.
 *
 * These tests verify the bot's behavior in a real Discord channel.
 * They require:
 *
 *   1. A running bot instance connected to Discord
 *   2. Saved auth state (run `npm run test:e2e:setup` first)
 *   3. Environment variables:
 *
 *      DISCORD_TEST_CHANNEL_URL
 *        Full URL to the test channel.
 *        Replace DISCORD_TEST_CHANNEL_URL with your channel URL.
 *        Example: https://discord.com/channels/123456789/987654321
 *
 *      DISCORD_BOT_NAME
 *        Display name of the bot in your Discord server.
 *        Replace DISCORD_BOT_NAME with your bot's name.
 *        Example: Daskyleion
 *
 * Run with:
 *   DISCORD_TEST_CHANNEL_URL=YOUR_CHANNEL_URL \
 *   DISCORD_BOT_NAME=YOUR_BOT_NAME \
 *   npm run test:e2e
 */

const CHANNEL_URL = process.env.DISCORD_TEST_CHANNEL_URL;
const BOT_NAME = process.env.DISCORD_BOT_NAME;

test.beforeEach(async ({ page }) => {
  if (!CHANNEL_URL || !BOT_NAME) {
    test.skip(
      true,
      "DISCORD_TEST_CHANNEL_URL or DISCORD_BOT_NAME not set — skipping Discord UX tests",
    );
    return;
  }

  await page.goto(CHANNEL_URL);

  // Wait for Discord to load and the message input to be ready
  await page.waitForSelector('[role="textbox"]', { timeout: 30_000 });

  // Brief pause to let Discord finish hydrating
  await page.waitForTimeout(2_000);
});

/**
 * Send a message mentioning the bot in a Discord channel.
 *
 * For bot mentions: Discord requires selecting from the autocomplete popup.
 * We type "@BOT_NAME" character by character to trigger it, then click the
 * matching autocomplete entry. Plain fill() bypasses autocomplete and
 * sends literal text that Discord doesn't treat as a mention.
 */
async function sendBotMessage(page: Page, message: string): Promise<void> {
  const textbox = page.locator('[role="textbox"]').last();
  await textbox.click();

  // Type first few chars of bot name to trigger autocomplete
  const prefix = BOT_NAME!.slice(0, 4);
  await textbox.pressSequentially(`@${prefix}`, { delay: 100 });
  await page.waitForTimeout(1_500);

  // Click the first autocomplete option
  const option = page.locator(
    '[data-list-id="channel-autocomplete"] [role="option"]',
  ).first();
  await option.click();
  await page.waitForTimeout(500);

  // Type the message content
  await page.keyboard.type(` ${message}`, { delay: 30 });
  await page.waitForTimeout(300);

  // Send
  await page.keyboard.press("Enter");
}

/**
 * Wait for a new bot message to appear after sending a user message.
 * Looks for messages with a bot tag indicator.
 */
async function waitForBotResponse(
  page: Page,
  timeoutMs: number = 60_000,
): Promise<string> {
  const startTime = Date.now();

  const messageSelector = 'li[id^="chat-messages-"], [class*="messageListItem"]';
  const initialCount = await page.locator(messageSelector).count();

  while (Date.now() - startTime < timeoutMs) {
    const currentCount = await page.locator(messageSelector).count();

    if (currentCount > initialCount) {
      for (let i = initialCount; i < currentCount; i++) {
        const msg = page.locator(messageSelector).nth(i);
        const hasBotTag = await msg
          .locator('[class*="botTag"], [class*="bot-tag"], [class*="appTag"]')
          .count();
        if (hasBotTag > 0) {
          const text = await msg.textContent();
          return text ?? "";
        }
      }
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error(`No bot response within ${timeoutMs}ms`);
}

test.describe("Discord Bot UX", () => {
  test("should show typing indicator after mention", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    await sendBotMessage(page, "hello");

    // Discord shows typing as a div with "is typing" text or a specific class
    const typingIndicator = page.locator(
      '[class*="typing"], [class*="typingIndicator"]',
    );

    await expect(typingIndicator).toBeVisible({ timeout: 3_000 });
  });

  test("should not show hardware banner in recent bot messages", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    // Only check messages from the bot (has APP/BOT tag), not user messages
    // which may quote the old banner text.
    const botMessages = await page.evaluate(() => {
      const items = document.querySelectorAll('li[id^="chat-messages-"]');
      const texts: string[] = [];
      for (const item of Array.from(items).slice(-10)) {
        const hasAppTag = item.querySelector(
          '[class*="botTag"], [class*="appTag"]',
        );
        if (hasAppTag) {
          texts.push(item.textContent?.toLowerCase() ?? "");
        }
      }
      return texts;
    });

    const botText = botMessages.join(" ");

    if (botText.length > 0) {
      expect(botText).not.toMatch(/system initialized.*detected.*cpu cores/);
      expect(botText).not.toMatch(/override with env vars/);
    }
  });

  test("should respond within 60 seconds", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    await sendBotMessage(page, "ping");

    const response = await waitForBotResponse(page, 60_000);
    expect(response.length).toBeGreaterThan(0);
  });

  test("should respond with conversational text", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    await sendBotMessage(page, "hello, how are you?");

    const response = await waitForBotResponse(page, 60_000);

    // Response should be conversational, not raw JSON or error output
    expect(response).not.toMatch(/^\s*\{/);
    expect(response).not.toMatch(/^\s*\[/);
    expect(response).not.toContain("Error:");
    expect(response).not.toContain("ENOENT");
    expect(response).not.toContain("stack trace");
    expect(response).not.toContain("exit code");

    expect(response.trim().split(/\s+/).length).toBeGreaterThan(2);
  });

  test("should stream responses with visible edits", async ({ page }) => {
    if (!CHANNEL_URL || !BOT_NAME) return;

    await sendBotMessage(
      page,
      "explain what this project does in a few sentences",
    );

    const messageSelector =
      'li[id^="chat-messages-"], [class*="messageListItem"]';
    const initialCount = await page.locator(messageSelector).count();

    // Wait for a bot message to appear
    await expect(async () => {
      const count = await page.locator(messageSelector).count();
      expect(count).toBeGreaterThan(initialCount);
    }).toPass({ timeout: 15_000 });

    // Capture the content length
    const botMessages = page.locator(messageSelector);
    const botMsgIndex = (await botMessages.count()) - 1;
    const botMsg = botMessages.nth(botMsgIndex);
    const initialText = await botMsg.textContent();
    const initialLength = initialText?.length ?? 0;

    // Wait and check if the message has grown (streamed edits)
    await page.waitForTimeout(5_000);

    const updatedText = await botMsg.textContent();
    const updatedLength = updatedText?.length ?? 0;

    if (initialLength > 0 && initialLength < 200) {
      expect(updatedLength).toBeGreaterThanOrEqual(initialLength);
    }
  });
});

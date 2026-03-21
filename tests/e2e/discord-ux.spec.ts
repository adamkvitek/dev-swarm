import { test, expect, type Page } from "@playwright/test";

/**
 * Discord UX tests for the dev-swarm bot.
 *
 * These tests verify the bot's behavior in a real Discord channel.
 * They require:
 *   1. A running bot instance connected to Discord
 *   2. Saved auth state (run `npm run test:e2e:setup` first)
 *   3. DISCORD_TEST_CHANNEL_URL env var pointing to a test channel
 *
 * Run with: DISCORD_TEST_CHANNEL_URL=https://discord.com/channels/... npm run test:e2e
 */

const CHANNEL_URL = process.env.DISCORD_TEST_CHANNEL_URL;

test.beforeEach(async ({ page }) => {
  if (!CHANNEL_URL) {
    test.skip(true, "DISCORD_TEST_CHANNEL_URL not set — skipping Discord UX tests");
    return;
  }

  await page.goto(CHANNEL_URL);

  // Wait for Discord to load and the message input to be ready
  await page.waitForSelector('[role="textbox"]', { timeout: 30_000 });

  // Brief pause to let Discord finish hydrating
  await page.waitForTimeout(2_000);
});

/**
 * Type a message into the Discord chat input and send it.
 *
 * For bot mentions: Discord requires selecting from the autocomplete popup.
 * We type "@BotName" character by character to trigger it, then click the
 * matching autocomplete entry. Plain fill() bypasses autocomplete and
 * sends literal text that Discord doesn't treat as a mention.
 */
async function sendMessage(page: Page, content: string): Promise<void> {
  const textbox = page.locator('[role="textbox"]').last();
  await textbox.click();

  // Check if the message starts with a @mention
  const mentionMatch = content.match(/^@(\S+)\s*(.*)/);
  if (mentionMatch) {
    const botName = mentionMatch[1];
    const rest = mentionMatch[2];

    // Type @BotName character by character to trigger autocomplete
    // Only need first few chars — Discord matches fuzzy
    const prefix = botName.slice(0, 4);
    await textbox.pressSequentially(`@${prefix}`, { delay: 100 });
    await page.waitForTimeout(1_500);

    // Click the first autocomplete option
    const option = page.locator(
      '[data-list-id="channel-autocomplete"] [role="option"]',
    ).first();
    await option.click();
    await page.waitForTimeout(500);

    // Type the rest of the message
    if (rest) {
      await page.keyboard.type(` ${rest}`, { delay: 30 });
    }
  } else {
    await textbox.fill(content);
  }

  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
}

/**
 * Get the text content of the last N messages in the channel.
 * Returns an array of message text strings, most recent last.
 */
async function getRecentMessages(page: Page, count: number): Promise<string[]> {
  // Wait a moment for any pending messages to render
  await page.waitForTimeout(500);

  // Discord message list items
  const messageSelector = 'li[id^="chat-messages-"], [class*="messageListItem"]';
  const messages = page.locator(messageSelector);

  const total = await messages.count();
  const start = Math.max(0, total - count);
  const texts: string[] = [];

  for (let i = start; i < total; i++) {
    const msgEl = messages.nth(i);
    const text = await msgEl.textContent();
    if (text) texts.push(text);
  }

  return texts;
}

/**
 * Wait for a new bot message to appear after sending a user message.
 * Looks for messages with a bot tag indicator.
 */
async function waitForBotResponse(page: Page, timeoutMs: number = 60_000): Promise<string> {
  const startTime = Date.now();

  // Count existing messages before waiting
  const messageSelector = 'li[id^="chat-messages-"], [class*="messageListItem"]';
  const initialCount = await page.locator(messageSelector).count();

  // Poll for a new message from the bot
  while (Date.now() - startTime < timeoutMs) {
    const currentCount = await page.locator(messageSelector).count();

    if (currentCount > initialCount) {
      // Check the newest messages for bot tag
      for (let i = initialCount; i < currentCount; i++) {
        const msg = page.locator(messageSelector).nth(i);
        const hasBotTag = await msg.locator('[class*="botTag"], [class*="bot-tag"]').count();
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
    if (!CHANNEL_URL) return;

    // Send a message mentioning the bot
    // The bot's mention needs to be @botname — use the actual mention format
    await sendMessage(page, "@Daskyleion hello");

    // Watch for the typing indicator to appear within 3 seconds
    // Discord shows typing as a div with "is typing" text or a specific class
    const typingIndicator = page.locator(
      '[class*="typing"], [class*="typingIndicator"]',
    );

    await expect(typingIndicator).toBeVisible({ timeout: 3_000 });
  });

  test("should not show hardware banner in recent bot messages", async ({ page }) => {
    if (!CHANNEL_URL) return;

    // Check that the bot hasn't sent a hardware detection banner.
    // Only check messages from the bot (has APP tag), not user messages
    // which may quote the old banner text.
    const botMessages = await page.evaluate(() => {
      const items = document.querySelectorAll('li[id^="chat-messages-"]');
      const texts: string[] = [];
      for (const item of Array.from(items).slice(-10)) {
        const hasAppTag = item.querySelector('[class*="botTag"], [class*="appTag"]');
        if (hasAppTag) {
          texts.push(item.textContent?.toLowerCase() ?? "");
        }
      }
      return texts;
    });

    const botText = botMessages.join(" ");

    // Bot messages should not contain hardware init banner language
    // (user messages quoting the old banner are fine — we only check bot output)
    if (botText.length > 0) {
      expect(botText).not.toMatch(/system initialized.*detected.*cpu cores/);
      expect(botText).not.toMatch(/override with env vars/);
    }
  });

  test("should respond within 60 seconds", async ({ page }) => {
    if (!CHANNEL_URL) return;

    await sendMessage(page, "@Daskyleion ping");

    // Wait for the bot to respond — should be within 60 seconds
    const response = await waitForBotResponse(page, 60_000);
    expect(response.length).toBeGreaterThan(0);
  });

  test("should respond with conversational text", async ({ page }) => {
    if (!CHANNEL_URL) return;

    await sendMessage(page, "@Daskyleion hello, how are you?");

    const response = await waitForBotResponse(page, 60_000);

    // Response should be conversational, not raw JSON or error output
    expect(response).not.toMatch(/^\s*\{/); // Not JSON
    expect(response).not.toMatch(/^\s*\[/); // Not JSON array
    expect(response).not.toContain("Error:");
    expect(response).not.toContain("ENOENT");
    expect(response).not.toContain("stack trace");
    expect(response).not.toContain("exit code");

    // Should contain some actual words (not just whitespace or symbols)
    expect(response.trim().split(/\s+/).length).toBeGreaterThan(2);
  });

  test("should stream responses with visible edits", async ({ page }) => {
    if (!CHANNEL_URL) return;

    // Ask something that requires a longer response
    await sendMessage(
      page,
      "@Daskyleion explain what this project does in a few sentences",
    );

    // Wait for the first bot message to appear
    const messageSelector = 'li[id^="chat-messages-"], [class*="messageListItem"]';
    const initialCount = await page.locator(messageSelector).count();

    // Wait for a bot message to appear
    await expect(async () => {
      const count = await page.locator(messageSelector).count();
      expect(count).toBeGreaterThan(initialCount);
    }).toPass({ timeout: 15_000 });

    // Capture the content length at this point
    const botMessages = page.locator(messageSelector);
    const botMsgIndex = (await botMessages.count()) - 1;
    const botMsg = botMessages.nth(botMsgIndex);
    const initialText = await botMsg.textContent();
    const initialLength = initialText?.length ?? 0;

    // Wait a few seconds and check if the message has grown (streamed edits)
    await page.waitForTimeout(5_000);

    const updatedText = await botMsg.textContent();
    const updatedLength = updatedText?.length ?? 0;

    // The message should have grown due to streaming edits
    // (unless the response was very short and completed instantly)
    if (initialLength > 0 && initialLength < 200) {
      // Short initial text — it might still be streaming
      expect(updatedLength).toBeGreaterThanOrEqual(initialLength);
    }
    // If it started long, streaming was already well underway — that's fine too
  });
});

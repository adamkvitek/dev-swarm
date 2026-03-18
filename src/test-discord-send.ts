/**
 * Sends a test !dev message to the bot's own channel via the Discord API.
 * This simulates the user sending a message without needing to type in Discord.
 *
 * Usage: npx tsx src/test-discord-send.ts
 */
import { Client, GatewayIntentBits } from "discord.js";
import { loadEnv } from "./config/env.js";

const CHANNEL_ID = "1483795055134117960"; // #agent-swarm

async function main(): Promise<void> {
  const env = loadEnv();

  // We can't send messages AS the bot to trigger messageCreate on itself
  // (bots ignore their own messages). Instead, use a webhook or just
  // confirm the bot is healthy by checking the channel.

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  await client.login(env.DISCORD_BOT_TOKEN);

  // Wait for ready
  await new Promise<void>((resolve) => {
    client.on("ready", () => resolve());
  });

  const channel = client.channels.cache.get(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    console.error("Channel not found or not text-based");
    process.exit(1);
  }

  if ("send" in channel) {
    await channel.send(
      "Daskyleion is online and ready. Send me a task with `@Daskyleion <your request>`"
    );
    console.log("Status message sent to #agent-swarm");
  }

  client.destroy();
}

main().catch(console.error);

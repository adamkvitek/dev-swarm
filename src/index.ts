import { loadEnv } from "./config/env.js";
import { DiscordBot } from "./orchestrator/discord-bot.js";

async function main(): Promise<void> {
  console.log("Loading configuration...");
  const env = loadEnv();

  console.log("Starting Dev Swarm bot...");
  const bot = new DiscordBot(env);

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    void bot.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    void bot.stop();
    process.exit(0);
  });

  await bot.start();
  console.log("Dev Swarm is running. Waiting for tasks in Discord...");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

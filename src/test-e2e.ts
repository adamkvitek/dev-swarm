/**
 * End-to-end test — triggers the full pipeline and posts results to Discord.
 * Bypasses message reception (already proven working) and tests everything else.
 *
 * Usage: npx tsx src/test-e2e.ts
 */
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  type TextChannel,
} from "discord.js";
import { loadEnv } from "./config/env.js";
import { Pipeline, type PipelineEvent } from "./orchestrator/pipeline.js";
import type { TaskPlan } from "./agents/cto.js";

const CHANNEL_ID = "1483795055134117960"; // #agent-swarm

async function main(): Promise<void> {
  const env = loadEnv();

  // Connect to Discord
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });
  await client.login(env.DISCORD_BOT_TOKEN);
  await new Promise<void>((resolve) => {
    client.on("ready", () => resolve());
  });

  const channel = client.channels.cache.get(CHANNEL_ID) as TextChannel;
  if (!channel) {
    console.error("Channel not found");
    process.exit(1);
  }

  await channel.send("**[E2E Test]** Starting automated pipeline test...");

  const truncate = (s: string, max: number): string =>
    s.length <= max ? s : s.slice(0, max - 3) + "...";

  let plan: TaskPlan | null = null;

  const pipeline = new Pipeline(env, async (event: PipelineEvent) => {
    console.log(`[EVENT] ${event.type}`);

    switch (event.type) {
      case "clarification":
        await channel.send(
          `**[CTO needs clarification]**\n${event.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
        );
        break;

      case "plan": {
        plan = event.plan;
        const embed = new EmbedBuilder()
          .setTitle("Task Plan")
          .setDescription(truncate(event.plan.summary, 4096))
          .addFields(
            {
              name: "Tech Stack",
              value: truncate(event.plan.techStack.join(", ") || "TBD", 1024),
            },
            {
              name: "Decisions",
              value: truncate(event.plan.decisions.join("\n") || "None yet", 1024),
            }
          )
          .setColor(0x5865f2);

        await channel.send({ embeds: [embed] });

        // Send subtasks in chunks
        const subtaskLines = event.plan.subtasks
          .map((s, i) => `**${i + 1}. ${s.title}**\n${truncate(s.description, 300)}`)
          .join("\n\n");

        const chunks: string[] = [];
        let current = "**Subtasks:**\n\n";
        for (const line of subtaskLines.split("\n\n")) {
          if (current.length + line.length + 2 > 1900) {
            chunks.push(current);
            current = "";
          }
          current += line + "\n\n";
        }
        if (current.trim()) chunks.push(current);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }

        await channel.send("**[E2E Test]** Plan received. Auto-approving and starting workers...");
        break;
      }

      case "iteration":
        await channel.send(`**Iteration ${event.current}/${event.max}**`);
        break;

      case "workers_started":
        await channel.send(`Dispatching ${event.subtaskCount} worker(s)...`);
        break;

      case "workers_completed": {
        const completed = event.results.filter((r) => r.status === "completed").length;
        const blocked = event.results.filter((r) => r.status === "blocked").length;
        await channel.send(`Workers done: ${completed} completed, ${blocked} blocked. Sending to reviewer...`);
        break;
      }

      case "review_completed": {
        const { scores, feedback, verdict } = event.review;
        const embed = new EmbedBuilder()
          .setTitle(`Review — ${verdict}`)
          .setDescription(truncate(feedback, 4096))
          .addFields({
            name: "Scores",
            value: [
              `Correctness: ${scores.correctness}/10`,
              `Code Quality: ${scores.codeQuality}/10`,
              `Test Coverage: ${scores.testCoverage}/10`,
              `Security: ${scores.security}/10`,
              `Completeness: ${scores.completeness}/10`,
              `**Average: ${scores.average.toFixed(1)}/10**`,
            ].join("\n"),
          })
          .setColor(verdict === "APPROVE" ? 0x57f287 : 0xed4245);
        await channel.send({ embeds: [embed] });
        break;
      }

      case "approved":
        await channel.send(
          `**Task complete!** Approved after ${event.finalReview.iteration} iteration(s) with average score ${event.finalReview.scores.average.toFixed(1)}/10.`
        );
        break;

      case "max_iterations_reached":
        await channel.send(
          `**Max iterations reached.** Best score: ${event.lastReview.scores.average.toFixed(1)}/10.`
        );
        break;

      case "error":
        await channel.send(`Pipeline error: ${event.message}`);
        break;
    }
  });

  // Step 1: Run CTO analysis
  const request = `In /Users/adamkvitek/Documents/GitHub/documentation-portal on branch feature/verify-code-samples-v2, read the phase docs and create a task plan for the proposed functionality.`;

  console.log("[E2E] Starting CTO analysis...");
  await pipeline.start(request);

  // Step 2: If we got a plan, auto-approve and run workers
  if (plan) {
    console.log("[E2E] Plan received, executing...");
    await pipeline.executePlan(plan);
  }

  console.log("[E2E] Done!");
  client.destroy();
}

main().catch(async (err) => {
  console.error("[E2E] Fatal:", err);
  process.exit(1);
});

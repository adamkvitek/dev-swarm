/**
 * Test script — runs the CTO agent directly without Discord.
 * Usage: npx tsx src/test-pipeline.ts
 */
import { loadEnv } from "./config/env.js";
import { CTOAgent } from "./agents/cto.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const cto = new CTOAgent(env);

  console.log("Testing CTO agent...\n");

  const request = `In /Users/adamkvitek/Documents/GitHub/documentation-portal on branch feature/verify-code-samples-v2, read the phase docs and propose a task plan to develop the functionality.`;

  console.log(`Request: ${request}\n`);
  console.log("Waiting for CTO response (this may take 60-120s)...\n");

  const result = await cto.analyze(request);

  if (result.clarifications) {
    console.log("CTO needs clarification:");
    result.clarifications.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  }

  if (result.plan) {
    console.log(`Plan: ${result.plan.summary}\n`);
    console.log(`Subtasks (${result.plan.subtasks.length}):`);
    result.plan.subtasks.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.title}`);
      // Test Discord-safe output
      const line = `- **${s.title}**: ${s.description}`;
      if (line.length > 200) {
        console.log(`     [${line.length} chars — would chunk in Discord]`);
      }
    });
    console.log(`\nTech Stack: ${result.plan.techStack.join(", ")}`);
    console.log(`Decisions: ${result.plan.decisions.join("; ")}`);
  }

  console.log("\nCTO agent test passed!");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

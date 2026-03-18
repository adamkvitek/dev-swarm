# Dev Swarm — Setup Guide

## Prerequisites

- Node.js >= 22
- npm >= 10
- A Discord account
- API keys for: Anthropic (Claude), OpenAI (Codex), and optionally Perplexity

## Step 1: Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, name it "Dev Swarm" (or whatever you like)
3. Go to **Bot** tab:
   - Click **Reset Token** and copy the token — this is your `DISCORD_BOT_TOKEN`
   - Enable **Message Content Intent** (required to read messages)
   - Enable **Server Members Intent**
4. Go to **OAuth2** tab:
   - Under **Scopes**, select `bot`
   - Under **Bot Permissions**, select:
     - Send Messages
     - Send Messages in Threads
     - Embed Links
     - Read Message History
     - Use Slash Commands
   - Copy the generated URL and open it in your browser to invite the bot to your server

## Step 2: Create a Discord Server (or use an existing one)

1. In Discord, create a new server (or use one you own)
2. Create a channel like `#dev-swarm` for the bot
3. Invite the bot using the URL from Step 1

## Step 3: Configure Environment

```bash
cp .env.example .env
```

Fill in your `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...      # From console.anthropic.com
OPENAI_API_KEY=sk-...              # From platform.openai.com
DISCORD_BOT_TOKEN=...              # From Step 1
PERPLEXITY_API_KEY=pplx-...        # From perplexity.ai/settings/api (optional)
```

## Step 4: Install and Run

```bash
npm install
npm run build
npm start
```

Or for development with hot reload:

```bash
npm run dev
```

## Step 5: Use It

In your Discord channel, either @mention the bot or use `!dev`:

```
!dev Build a REST API for a todo app with TypeScript, Express, and PostgreSQL
```

The bot will:
1. Ask clarifying questions if needed
2. Present a task plan for your approval
3. Reply "approve" to start
4. Run workers, review with Codex, iterate until quality threshold is met
5. Deliver the final code

### Commands

| Command | What it does |
|---------|-------------|
| `!dev <task>` | Start a new development task |
| `approve` | Approve the proposed plan |
| `cancel` | Cancel the current session |
| `@bot <message>` | Same as !dev |

## Step 6 (Optional): OpenClaw Integration

If you want to use this as an OpenClaw skill:

1. Install OpenClaw: `npx openclaw@latest onboard --install-daemon`
2. Copy the `skill/` directory to `~/.openclaw/workspace/skills/dev-swarm/`
3. The skill will be available to OpenClaw's agent across all connected channels

## Architecture

```
Discord message
  → Discord Bot (src/orchestrator/discord-bot.ts)
    → Pipeline (src/orchestrator/pipeline.ts)
      → CTO Agent (src/agents/cto.ts) — decomposes task
      → Worker Agents (src/agents/worker.ts) — implement in parallel
      → Reviewer Agent (src/agents/reviewer.ts) — Codex reviews
      → Researcher Agent (src/agents/researcher.ts) — Perplexity lookups
    → Back to Discord with results
```

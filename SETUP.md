# Dev Swarm — Setup Guide

## Prerequisites

- Node.js >= 22
- npm >= 10
- CLI tools: Claude (required), Codex (optional), Gemini (optional)
- A Discord account (only for Discord mode)

## Quick Start (Terminal Mode)

No Discord needed. Private, all data stays local.

```bash
git clone https://github.com/adamkvitek/dev-swarm.git
cd dev-swarm
npm install
npm run dev-swarm
```

## Discord Mode Setup

### Step 1: Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. **New Application** — name it (e.g. "Daskyleion")
3. **Bot** tab:
   - Click **Reset Token** — copy the token
   - Enable **Message Content Intent** (required to read messages)
4. **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Permissions: Send Messages, Read Message History
   - Copy the generated URL → open it → add bot to your server

### Step 2: Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
DISCORD_BOT_TOKEN=your-token-here
```

That's the only required value. Everything else auto-detects from your hardware.

### Step 3: Run

```bash
npm run dev    # development mode, human-readable logs
# or
npm start      # production mode, JSON logs
```

Run one of those commands, not both.

### Step 4: Use

Use the bot in Discord:

- In a DM with the bot, just type normally.
- In a server channel, @mention the bot.

```
@bot Review /Users/adam/projects/my-app for security issues. Use TypeScript standards.
@bot Add auth to /Users/adam/projects/api. Use council mode.
```

## Architecture

```
Terminal / Discord
        |
   Claude CLI (CTO)
        |
   MCP Tools (src/mcp/tools.ts)
        |
   HTTP API (src/adapter/http-api.ts)
        |
   Job Manager (src/adapter/job-manager.ts)
    +---+---+
 Claude Codex Gemini  <- workers in worktrees
    +---+---+
   Worktree Manager (src/workspace/worktree-manager.ts)
   Standards Loader (src/agents/standards-loader.ts)
```

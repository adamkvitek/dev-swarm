# Contributing

Thanks for your interest in dev-swarm. Here's how to contribute.

## Getting started

```bash
git clone https://github.com/AKTech-ai/dev-swarm.git
cd dev-swarm
npm install
```

## Development workflow

1. Fork the repo and create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature
   ```

2. Make your changes. Run checks before committing:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   ```

3. Commit with [conventional commits](https://www.conventionalcommits.org/):
   ```
   feat(worker): add retry logic for flaky CLI calls
   fix(adapter): prevent double-shutdown on rapid Ctrl+C
   ```

4. Open a pull request against `main`.

## Project structure

- `src/adapter/` — Discord adapter, HTTP API, job manager
- `src/agents/` — Worker, reviewer, CTO, CLI runner
- `src/config/` — Environment config
- `src/mcp/` — MCP server and tool definitions
- `src/workspace/` — Git worktree manager, safety guardrails
- `src/streaming/` — Discord live streaming
- `prompts/` — System prompts and coding standards

## Tests

```bash
npm test              # run all tests
npm test -- --watch   # watch mode
```

Tests live next to the code they test in `__tests__/` directories.

## Code style

- TypeScript with `strict: true`
- No `any` — use `unknown` and narrow
- Structured logging via `pino` (use `log.module.info(...)`, not `console.log`)
- Zod for runtime validation of external input

## What needs help

Check the [issues](https://github.com/AKTech-ai/dev-swarm/issues) for open tasks. Good first issues are labeled accordingly.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

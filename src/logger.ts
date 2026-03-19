import pino from "pino";

/**
 * Structured JSON logger for dev-swarm.
 *
 * Usage:
 *   import { logger } from "./logger.js";
 *   const log = logger.child({ module: "worker" });
 *   log.info({ subtaskId: "1" }, "Worker started");
 *
 * In development: pipe through pino-pretty for human-readable output:
 *   npm run dev | npx pino-pretty
 *
 * In production: logs are JSON to stdout, pipe wherever you want:
 *   node dist/index.js > /var/log/dev-swarm.json
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Pre-built child loggers for each module.
// Avoids repeating `logger.child(...)` in every file.
export const log = {
  config:    logger.child({ module: "config" }),
  adapter:   logger.child({ module: "adapter" }),
  worker:    logger.child({ module: "worker" }),
  reviewer:  logger.child({ module: "reviewer" }),
  cto:       logger.child({ module: "cto" }),
  jobMgr:    logger.child({ module: "job-manager" }),
  httpApi:   logger.child({ module: "http-api" }),
  worktree:  logger.child({ module: "worktree" }),
  mcp:       logger.child({ module: "mcp" }),
  shutdown:  logger.child({ module: "shutdown" }),
};

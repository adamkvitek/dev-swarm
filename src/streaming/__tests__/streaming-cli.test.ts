import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { parseStreamLine, StreamingClaudeSession } from "../streaming-cli.js";
import type { StreamCallbacks } from "../types.js";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock the logger to capture timing logs
vi.mock("../../logger.js", () => ({
  log: {
    adapter: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { spawn } from "node:child_process";
import { log } from "../../logger.js";

/**
 * Create a fake ChildProcess with EventEmitter-based stdin/stdout/stderr.
 * Allows tests to simulate CLI output and exit events.
 */
function createFakeProc(): {
  proc: ReturnType<typeof spawn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  emitClose: (code: number) => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
  });

  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 12345,
  }) as unknown as ReturnType<typeof spawn>;

  const emitClose = (code: number): void => {
    (proc as unknown as EventEmitter).emit("close", code);
  };

  return { proc, stdout, stderr, stdin, emitClose };
}

function noopCallbacks(): StreamCallbacks {
  return {
    onTextDelta: vi.fn(),
    onToolUseStart: vi.fn(),
    onToolUseEnd: vi.fn(),
  };
}

describe("parseStreamLine", () => {
  describe("content_block_delta (text_delta)", () => {
    it("should parse a text delta event", () => {
      const line = JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });

      const result = parseStreamLine(line);
      expect(result).toEqual({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });
    });

    it("should parse text delta with multi-word tokens", () => {
      const line = JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world! How are " },
      });

      const result = parseStreamLine(line);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("content_block_delta");
      if (result!.type === "content_block_delta") {
        expect(result!.delta.text).toBe(" world! How are ");
      }
    });

    it("should parse text delta with special characters", () => {
      const line = JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: '```typescript\nconst x = "hello";\n```' },
      });

      const result = parseStreamLine(line);
      expect(result).not.toBeNull();
      if (result!.type === "content_block_delta") {
        expect(result!.delta.text).toContain("```typescript");
      }
    });

    it("should return null for non-text delta types (input_json_delta)", () => {
      const line = JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"key": "val' },
      });

      expect(parseStreamLine(line)).toBeNull();
    });

    it("should default index to 0 when missing", () => {
      const line = JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "test" },
      });

      const result = parseStreamLine(line);
      expect(result).not.toBeNull();
      if (result!.type === "content_block_delta") {
        expect(result!.index).toBe(0);
      }
    });
  });

  describe("content_block_start (tool_use)", () => {
    it("should parse a tool use start event", () => {
      const line = JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_abc123",
          name: "spawn_workers",
        },
      });

      const result = parseStreamLine(line);
      expect(result).toEqual({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_abc123",
          name: "spawn_workers",
        },
      });
    });

    it("should return null for text content block start", () => {
      const line = JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });

      expect(parseStreamLine(line)).toBeNull();
    });

    it("should return null for tool_use without required fields", () => {
      const line = JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use" }, // missing id and name
      });

      expect(parseStreamLine(line)).toBeNull();
    });
  });

  describe("content_block_stop", () => {
    it("should parse a content block stop event", () => {
      const line = JSON.stringify({
        type: "content_block_stop",
        index: 1,
      });

      const result = parseStreamLine(line);
      expect(result).toEqual({
        type: "content_block_stop",
        index: 1,
      });
    });

    it("should default index to 0 when missing", () => {
      const line = JSON.stringify({ type: "content_block_stop" });

      const result = parseStreamLine(line);
      expect(result).toEqual({ type: "content_block_stop", index: 0 });
    });
  });

  describe("result", () => {
    it("should parse a successful result event", () => {
      const line = JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "sess-abc123",
        result: "Here is the final response text",
        cost_usd: 0.01,
        total_cost_usd: 0.05,
        duration_ms: 2000,
        total_duration_ms: 8000,
        is_error: false,
        num_turns: 2,
      });

      const result = parseStreamLine(line);
      expect(result).toEqual({
        type: "result",
        subtype: "success",
        session_id: "sess-abc123",
        result: "Here is the final response text",
        cost_usd: 0.01,
        total_cost_usd: 0.05,
        duration_ms: 2000,
        total_duration_ms: 8000,
        is_error: false,
        num_turns: 2,
      });
    });

    it("should handle result with error", () => {
      const line = JSON.stringify({
        type: "result",
        subtype: "error",
        session_id: "sess-abc123",
        result: "",
        cost_usd: 0,
        total_cost_usd: 0,
        duration_ms: 100,
        total_duration_ms: 100,
        is_error: true,
        num_turns: 0,
      });

      const result = parseStreamLine(line);
      expect(result).not.toBeNull();
      if (result!.type === "result") {
        expect(result!.is_error).toBe(true);
      }
    });

    it("should provide defaults for missing result fields", () => {
      const line = JSON.stringify({
        type: "result",
        session_id: "sess-xyz",
      });

      const result = parseStreamLine(line);
      expect(result).not.toBeNull();
      if (result!.type === "result") {
        expect(result!.session_id).toBe("sess-xyz");
        expect(result!.result).toBe("");
        expect(result!.cost_usd).toBe(0);
        expect(result!.total_cost_usd).toBe(0);
        expect(result!.is_error).toBe(false);
        expect(result!.num_turns).toBe(1);
      }
    });
  });

  describe("unrecognized and malformed events", () => {
    it("should return null for unknown event types", () => {
      const line = JSON.stringify({ type: "message_start", message: {} });
      expect(parseStreamLine(line)).toBeNull();
    });

    it("should return null for assistant event type", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [] },
      });
      expect(parseStreamLine(line)).toBeNull();
    });

    it("should return null for message_delta event type", () => {
      const line = JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      });
      expect(parseStreamLine(line)).toBeNull();
    });

    it("should return null for invalid JSON", () => {
      expect(parseStreamLine("{broken json")).toBeNull();
    });

    it("should return null for non-object JSON", () => {
      expect(parseStreamLine('"just a string"')).toBeNull();
    });

    it("should return null for JSON without type field", () => {
      expect(parseStreamLine('{"data": "something"}')).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(parseStreamLine("")).toBeNull();
    });

    it("should return null for array JSON", () => {
      expect(parseStreamLine("[1, 2, 3]")).toBeNull();
    });

    it("should return null for null JSON", () => {
      expect(parseStreamLine("null")).toBeNull();
    });
  });

  describe("realistic stream sequence", () => {
    it("should correctly parse a typical stream-json conversation", () => {
      const lines = [
        '{"type":"system","subtype":"init","session_id":"sess-1"}',
        '{"type":"assistant","message":{"id":"msg_1","content":[]}}',
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I'll"}}`,
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" help you"}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" with that."}}',
        '{"type":"content_block_stop","index":0}',
        '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"spawn_workers","input":{}}}',
        '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"subtasks\\""}}',
        '{"type":"content_block_stop","index":1}',
        '{"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}',
        '{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Workers spawned!"}}',
        '{"type":"content_block_stop","index":2}',
        `{"type":"result","subtype":"success","session_id":"sess-1","result":"I'll help you with that.\\nWorkers spawned!","cost_usd":0.01,"total_cost_usd":0.01,"duration_ms":3000,"total_duration_ms":3000,"is_error":false,"num_turns":2}`,
      ];

      const events = lines.map(parseStreamLine);

      // Line 0: system init — unknown type, null
      expect(events[0]).toBeNull();
      // Line 1: assistant — unknown type, null
      expect(events[1]).toBeNull();
      // Line 2: content_block_start (text) — not tool_use, null
      expect(events[2]).toBeNull();
      // Lines 3-5: text deltas
      expect(events[3]?.type).toBe("content_block_delta");
      expect(events[4]?.type).toBe("content_block_delta");
      expect(events[5]?.type).toBe("content_block_delta");
      // Line 6: content_block_stop
      expect(events[6]?.type).toBe("content_block_stop");
      // Line 7: tool_use start
      expect(events[7]?.type).toBe("content_block_start");
      if (events[7]?.type === "content_block_start") {
        expect(events[7].content_block.name).toBe("spawn_workers");
      }
      // Line 8: input_json_delta — not text_delta, null
      expect(events[8]).toBeNull();
      // Line 9: content_block_stop (tool_use)
      expect(events[9]?.type).toBe("content_block_stop");
      // Line 10: content_block_start (text) — not tool_use, null
      expect(events[10]).toBeNull();
      // Line 11: text delta
      expect(events[11]?.type).toBe("content_block_delta");
      // Line 12: content_block_stop
      expect(events[12]?.type).toBe("content_block_stop");
      // Line 13: result
      expect(events[13]?.type).toBe("result");
      if (events[13]?.type === "result") {
        expect(events[13].session_id).toBe("sess-1");
        expect(events[13].num_turns).toBe(2);
      }
    });
  });
});

describe("StreamingClaudeSession", () => {
  const mockedSpawn = vi.mocked(spawn);
  const mockedLogInfo = vi.mocked(log.adapter.info);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("buildArgs (via spawn inspection)", () => {
    it("should include --verbose in CLI args (required by stream-json)", () => {
      const { proc } = createFakeProc();
      mockedSpawn.mockReturnValue(proc);

      const session = new StreamingClaudeSession("claude");
      const promise = session.send("test", noopCallbacks(), { timeoutMs: 1000 });

      const spawnArgs = mockedSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain("--verbose");

      // Clean up: emit close to settle the promise
      const fakeProc = mockedSpawn.mock.results[0]!.value as unknown as EventEmitter;
      (fakeProc as unknown as ReturnType<typeof createFakeProc>["proc"]).stdout!.emit(
        "data",
        Buffer.from(JSON.stringify({
          type: "result", subtype: "success", session_id: "s1",
          result: "ok", cost_usd: 0, total_cost_usd: 0,
          duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
        }) + "\n"),
      );
      fakeProc.emit("close", 0);

      return promise;
    });

    it("should include --print and --output-format stream-json", () => {
      const { proc, stdout, emitClose } = createFakeProc();
      mockedSpawn.mockReturnValue(proc);

      const session = new StreamingClaudeSession("claude");
      const promise = session.send("test", noopCallbacks(), { timeoutMs: 1000 });

      const spawnArgs = mockedSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain("--print");
      expect(spawnArgs).toContain("--output-format");
      expect(spawnArgs[spawnArgs.indexOf("--output-format") + 1]).toBe("stream-json");

      // Settle
      stdout.emit("data", Buffer.from(JSON.stringify({
        type: "result", subtype: "success", session_id: "s1",
        result: "ok", cost_usd: 0, total_cost_usd: 0,
        duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
      }) + "\n"));
      emitClose(0);

      return promise;
    });

    it("should include extra args", () => {
      const { proc, stdout, emitClose } = createFakeProc();
      mockedSpawn.mockReturnValue(proc);

      const session = new StreamingClaudeSession("claude", ["--dangerously-skip-permissions"]);
      const promise = session.send("test", noopCallbacks(), { timeoutMs: 1000 });

      const spawnArgs = mockedSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain("--dangerously-skip-permissions");

      stdout.emit("data", Buffer.from(JSON.stringify({
        type: "result", subtype: "success", session_id: "s1",
        result: "ok", cost_usd: 0, total_cost_usd: 0,
        duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
      }) + "\n"));
      emitClose(0);

      return promise;
    });

    it("should include --append-system-prompt on first message", () => {
      const { proc, stdout, emitClose } = createFakeProc();
      mockedSpawn.mockReturnValue(proc);

      const session = new StreamingClaudeSession("claude", [], undefined, "You are a bot");
      const promise = session.send("test", noopCallbacks(), { timeoutMs: 1000 });

      const spawnArgs = mockedSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain("--append-system-prompt");
      expect(spawnArgs[spawnArgs.indexOf("--append-system-prompt") + 1]).toBe("You are a bot");

      stdout.emit("data", Buffer.from(JSON.stringify({
        type: "result", subtype: "success", session_id: "s1",
        result: "ok", cost_usd: 0, total_cost_usd: 0,
        duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
      }) + "\n"));
      emitClose(0);

      return promise;
    });

    it("should include --resume with session ID on subsequent messages", async () => {
      // First message — captures session ID
      const fake1 = createFakeProc();
      mockedSpawn.mockReturnValue(fake1.proc);

      const session = new StreamingClaudeSession("claude", [], undefined, "You are a bot");
      const p1 = session.send("first", noopCallbacks(), { timeoutMs: 1000 });

      fake1.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "result", subtype: "success", session_id: "sess-abc",
        result: "ok", cost_usd: 0, total_cost_usd: 0,
        duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
      }) + "\n"));
      fake1.emitClose(0);
      await p1;

      expect(session.isActive).toBe(true);
      expect(session.id).toBe("sess-abc");

      // Second message — should use --resume, no system prompt
      const fake2 = createFakeProc();
      mockedSpawn.mockReturnValue(fake2.proc);

      const p2 = session.send("second", noopCallbacks(), { timeoutMs: 1000 });

      const args2 = mockedSpawn.mock.calls[1][1] as string[];
      expect(args2).toContain("--resume");
      expect(args2[args2.indexOf("--resume") + 1]).toBe("sess-abc");
      // System prompt should NOT be repeated on subsequent messages
      expect(args2).not.toContain("--append-system-prompt");

      fake2.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "result", subtype: "success", session_id: "sess-abc",
        result: "ok2", cost_usd: 0, total_cost_usd: 0,
        duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
      }) + "\n"));
      fake2.emitClose(0);
      await p2;
    });

    it("should include --mcp-config when configured", () => {
      const { proc, stdout, emitClose } = createFakeProc();
      mockedSpawn.mockReturnValue(proc);

      const session = new StreamingClaudeSession("claude", [], "/tmp/mcp.json");
      const promise = session.send("test", noopCallbacks(), { timeoutMs: 1000 });

      const spawnArgs = mockedSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain("--mcp-config");
      expect(spawnArgs[spawnArgs.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json");

      stdout.emit("data", Buffer.from(JSON.stringify({
        type: "result", subtype: "success", session_id: "s1",
        result: "ok", cost_usd: 0, total_cost_usd: 0,
        duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
      }) + "\n"));
      emitClose(0);

      return promise;
    });
  });

  describe("timing logs", () => {
    it("should log spawn-to-first-data timing on first stdout data", async () => {
      const { proc, stdout, emitClose } = createFakeProc();
      mockedSpawn.mockReturnValue(proc);

      const session = new StreamingClaudeSession("claude");
      const promise = session.send("test", noopCallbacks(), { timeoutMs: 5000 });

      // Emit first stdout data
      stdout.emit("data", Buffer.from(JSON.stringify({
        type: "result", subtype: "success", session_id: "s1",
        result: "ok", cost_usd: 0, total_cost_usd: 0,
        duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
      }) + "\n"));
      emitClose(0);

      await promise;

      // Find the "first stdout data" log call
      const firstDataLog = mockedLogInfo.mock.calls.find(
        (call) => call[1] === "Streaming CLI first stdout data",
      );
      expect(firstDataLog).toBeDefined();
      expect(firstDataLog![0]).toHaveProperty("spawnToFirstDataMs");
      expect(typeof (firstDataLog![0] as Record<string, unknown>).spawnToFirstDataMs).toBe("number");
    });

    it("should log completion timing with all fields", async () => {
      const { proc, stdout, emitClose } = createFakeProc();
      mockedSpawn.mockReturnValue(proc);

      const session = new StreamingClaudeSession("claude");
      const promise = session.send("test", noopCallbacks(), { timeoutMs: 5000 });

      stdout.emit("data", Buffer.from(JSON.stringify({
        type: "result", subtype: "success", session_id: "s1",
        result: "ok", cost_usd: 0, total_cost_usd: 0,
        duration_ms: 10, total_duration_ms: 3500, is_error: false, num_turns: 1,
      }) + "\n"));
      emitClose(0);

      await promise;

      // Find the "completed" log call
      const completedLog = mockedLogInfo.mock.calls.find(
        (call) => call[1] === "Streaming CLI completed",
      );
      expect(completedLog).toBeDefined();
      const logData = completedLog![0] as Record<string, unknown>;
      expect(logData).toHaveProperty("sessionId", "s1");
      expect(logData).toHaveProperty("totalElapsedMs");
      expect(typeof logData.totalElapsedMs).toBe("number");
      expect(logData).toHaveProperty("spawnToFirstDataMs");
      expect(logData).toHaveProperty("firstDataToResultMs");
      expect(logData).toHaveProperty("cliDurationMs", 3500);
    });

    it("should report null timing when no stdout data received before close", async () => {
      const { proc, emitClose } = createFakeProc();
      mockedSpawn.mockReturnValue(proc);

      const session = new StreamingClaudeSession("claude");
      const promise = session.send("test", noopCallbacks(), { timeoutMs: 5000 });

      // Close without any stdout data — this triggers the error path
      emitClose(1);

      await expect(promise).rejects.toThrow("Streaming CLI failed");
    });
  });

  describe("session ID persistence", () => {
    it("should preserve session ID across error on subsequent send", async () => {
      // First send — establishes session
      const fake1 = createFakeProc();
      mockedSpawn.mockReturnValue(fake1.proc);

      const session = new StreamingClaudeSession("claude");
      const p1 = session.send("first", noopCallbacks(), { timeoutMs: 1000 });

      fake1.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "result", subtype: "success", session_id: "sess-keep",
        result: "ok", cost_usd: 0, total_cost_usd: 0,
        duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
      }) + "\n"));
      fake1.emitClose(0);
      await p1;

      expect(session.id).toBe("sess-keep");

      // Second send — process fails with no result
      const fake2 = createFakeProc();
      mockedSpawn.mockReturnValue(fake2.proc);

      const p2 = session.send("second", noopCallbacks(), { timeoutMs: 1000 });
      fake2.emitClose(1);

      await expect(p2).rejects.toThrow("Streaming CLI failed");

      // Session ID should still be preserved
      expect(session.id).toBe("sess-keep");
    });

    it("should reset session ID when reset() is called", async () => {
      const fake1 = createFakeProc();
      mockedSpawn.mockReturnValue(fake1.proc);

      const session = new StreamingClaudeSession("claude");
      const p1 = session.send("first", noopCallbacks(), { timeoutMs: 1000 });

      fake1.stdout.emit("data", Buffer.from(JSON.stringify({
        type: "result", subtype: "success", session_id: "sess-reset",
        result: "ok", cost_usd: 0, total_cost_usd: 0,
        duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
      }) + "\n"));
      fake1.emitClose(0);
      await p1;

      expect(session.isActive).toBe(true);
      session.reset();
      expect(session.isActive).toBe(false);
      expect(session.id).toBeNull();
    });
  });

  describe("callbacks", () => {
    it("should invoke onTextDelta for text tokens", async () => {
      const { proc, stdout, emitClose } = createFakeProc();
      mockedSpawn.mockReturnValue(proc);

      const callbacks = noopCallbacks();
      const session = new StreamingClaudeSession("claude");
      const promise = session.send("test", callbacks, { timeoutMs: 1000 });

      stdout.emit("data", Buffer.from(
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }) + "\n" +
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }) + "\n" +
        JSON.stringify({
          type: "result", subtype: "success", session_id: "s1",
          result: "Hello world", cost_usd: 0, total_cost_usd: 0,
          duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
        }) + "\n",
      ));
      emitClose(0);

      const result = await promise;
      expect(callbacks.onTextDelta).toHaveBeenCalledWith("Hello");
      expect(callbacks.onTextDelta).toHaveBeenCalledWith(" world");
      expect(result.text).toBe("Hello world");
    });

    it("should invoke onToolUseStart and onToolUseEnd", async () => {
      const { proc, stdout, emitClose } = createFakeProc();
      mockedSpawn.mockReturnValue(proc);

      const callbacks = noopCallbacks();
      const session = new StreamingClaudeSession("claude");
      const promise = session.send("test", callbacks, { timeoutMs: 1000 });

      stdout.emit("data", Buffer.from(
        JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "read_file" } }) + "\n" +
        JSON.stringify({ type: "content_block_stop", index: 1 }) + "\n" +
        JSON.stringify({
          type: "result", subtype: "success", session_id: "s1",
          result: "", cost_usd: 0, total_cost_usd: 0,
          duration_ms: 10, total_duration_ms: 10, is_error: false, num_turns: 1,
        }) + "\n",
      ));
      emitClose(0);

      await promise;
      expect(callbacks.onToolUseStart).toHaveBeenCalledWith("read_file");
      expect(callbacks.onToolUseEnd).toHaveBeenCalledTimes(1);
    });
  });
});

import { describe, it, expect } from "vitest";
import { parseStreamLine } from "../streaming-cli.js";

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

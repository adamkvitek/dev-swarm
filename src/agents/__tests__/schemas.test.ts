import { describe, it, expect } from "vitest";
import {
  claudeSessionResponseSchema,
  ctoResponseSchema,
  reviewerResponseSchema,
  parseCliJson,
} from "../schemas.js";

describe("parseCliJson", () => {
  it("should extract and validate JSON from text", () => {
    const text = 'Some prefix {"result": "hello", "session_id": "s1", "total_cost_usd": 0.01, "duration_ms": 500} suffix';
    const result = parseCliJson(text, claudeSessionResponseSchema);
    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data.result).toBe("hello");
      expect(result.data.session_id).toBe("s1");
    }
  });

  it("should return error when no JSON found", () => {
    const result = parseCliJson("no json here", claudeSessionResponseSchema);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("No JSON object found");
    }
  });

  it("should return error for incomplete JSON (no closing brace)", () => {
    const result = parseCliJson("{broken json", claudeSessionResponseSchema);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("No JSON object found");
    }
  });

  it("should return error for invalid JSON with matching braces", () => {
    const result = parseCliJson("{broken: json}", claudeSessionResponseSchema);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Invalid JSON");
    }
  });

  it("should return error when schema validation fails", () => {
    const text = '{"result": "hello"}'; // missing required fields
    const result = parseCliJson(text, claudeSessionResponseSchema);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Schema validation failed");
    }
  });
});

describe("claudeSessionResponseSchema", () => {
  it("should accept valid response", () => {
    const valid = {
      result: "Hello world",
      session_id: "sess-123",
      total_cost_usd: 0.0042,
      duration_ms: 1200,
    };
    expect(claudeSessionResponseSchema.parse(valid)).toEqual(valid);
  });

  it("should reject missing fields", () => {
    expect(() => claudeSessionResponseSchema.parse({ result: "hi" })).toThrow();
  });

  it("should reject wrong types", () => {
    expect(() => claudeSessionResponseSchema.parse({
      result: "hi",
      session_id: 123, // should be string
      total_cost_usd: 0,
      duration_ms: 0,
    })).toThrow();
  });
});

describe("ctoResponseSchema", () => {
  it("should accept clarification response", () => {
    const valid = {
      clarifications_needed: ["What language?", "What framework?"],
      plan: null,
    };
    expect(ctoResponseSchema.parse(valid)).toEqual(valid);
  });

  it("should accept plan response", () => {
    const valid = {
      clarifications_needed: null,
      plan: {
        summary: "Add auth",
        subtasks: [{ id: "1", title: "JWT", description: "Add JWT", dependencies: [] }],
        techStack: ["TypeScript"],
        decisions: ["Use JWT"],
      },
    };
    const parsed = ctoResponseSchema.parse(valid);
    expect(parsed.plan?.subtasks).toHaveLength(1);
  });

  it("should reject plan with missing subtask fields", () => {
    const invalid = {
      clarifications_needed: null,
      plan: {
        summary: "test",
        subtasks: [{ id: "1" }], // missing title, description, dependencies
        techStack: [],
        decisions: [],
      },
    };
    expect(() => ctoResponseSchema.parse(invalid)).toThrow();
  });
});

describe("reviewerResponseSchema", () => {
  it("should accept valid review", () => {
    const valid = {
      verdict: "APPROVE",
      scores: {
        correctness: 9,
        codeQuality: 8,
        testCoverage: 7,
        security: 9,
        completeness: 8,
      },
      feedback: "Good work",
      issuesBySubtask: { "1": ["minor: naming"] },
    };
    expect(reviewerResponseSchema.parse(valid)).toEqual(valid);
  });

  it("should reject invalid verdict", () => {
    expect(() => reviewerResponseSchema.parse({
      verdict: "MAYBE",
      scores: { correctness: 5, codeQuality: 5, testCoverage: 5, security: 5, completeness: 5 },
      feedback: "ok",
      issuesBySubtask: {},
    })).toThrow();
  });

  it("should reject scores out of range", () => {
    expect(() => reviewerResponseSchema.parse({
      verdict: "APPROVE",
      scores: { correctness: 15, codeQuality: 5, testCoverage: 5, security: 5, completeness: 5 },
      feedback: "ok",
      issuesBySubtask: {},
    })).toThrow();
  });

  it("should reject negative scores", () => {
    expect(() => reviewerResponseSchema.parse({
      verdict: "REVISE",
      scores: { correctness: -1, codeQuality: 5, testCoverage: 5, security: 5, completeness: 5 },
      feedback: "ok",
      issuesBySubtask: {},
    })).toThrow();
  });
});

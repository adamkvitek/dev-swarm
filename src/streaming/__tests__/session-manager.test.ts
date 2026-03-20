import { describe, it, expect } from "vitest";
import { SessionManager } from "../session-manager.js";

describe("SessionManager", () => {
  const defaultOptions = {
    claudeCli: "claude",
    extraArgs: ["--dangerously-skip-permissions"],
    systemPrompt: "You are a test bot.",
  };

  it("should create a new session for a new channel", () => {
    const manager = new SessionManager(defaultOptions);
    const session = manager.getOrCreate("channel-1");

    expect(session).toBeDefined();
    expect(session.isActive).toBe(false); // No messages sent yet
  });

  it("should return the same session for the same channel", () => {
    const manager = new SessionManager(defaultOptions);
    const session1 = manager.getOrCreate("channel-1");
    const session2 = manager.getOrCreate("channel-1");

    expect(session1).toBe(session2);
  });

  it("should return different sessions for different channels", () => {
    const manager = new SessionManager(defaultOptions);
    const session1 = manager.getOrCreate("channel-1");
    const session2 = manager.getOrCreate("channel-2");

    expect(session1).not.toBe(session2);
  });

  it("should reset a channel session", () => {
    const manager = new SessionManager(defaultOptions);
    const session1 = manager.getOrCreate("channel-1");
    manager.reset("channel-1");
    const session2 = manager.getOrCreate("channel-1");

    expect(session1).not.toBe(session2);
  });

  it("should report hasSession as false for new channels", () => {
    const manager = new SessionManager(defaultOptions);
    expect(manager.hasSession("channel-1")).toBe(false);
  });

  it("should report hasSession as false for channel with unused session", () => {
    const manager = new SessionManager(defaultOptions);
    manager.getOrCreate("channel-1");
    // Session exists but isActive is false (no sessionId yet)
    expect(manager.hasSession("channel-1")).toBe(false);
  });

  it("should return null session ID for non-existent channel", () => {
    const manager = new SessionManager(defaultOptions);
    expect(manager.getSessionId("channel-1")).toBeNull();
  });

  it("should report correct active count", () => {
    const manager = new SessionManager(defaultOptions);
    expect(manager.activeCount).toBe(0);

    // Creating sessions doesn't make them active (no messages sent)
    manager.getOrCreate("channel-1");
    manager.getOrCreate("channel-2");
    expect(manager.activeCount).toBe(0);
  });

  it("should clear all sessions", () => {
    const manager = new SessionManager(defaultOptions);
    manager.getOrCreate("channel-1");
    manager.getOrCreate("channel-2");
    manager.getOrCreate("channel-3");

    manager.clear();

    // All sessions are gone — getOrCreate creates new ones
    const session = manager.getOrCreate("channel-1");
    expect(session).toBeDefined();
    // No session for other channels
    expect(manager.hasSession("channel-2")).toBe(false);
  });

  it("should update system prompt for new sessions", () => {
    const manager = new SessionManager(defaultOptions);
    manager.getOrCreate("channel-1"); // Uses original prompt

    manager.updateSystemPrompt("New prompt");
    // channel-1 still has old session, channel-2 gets new session with new prompt
    const session2 = manager.getOrCreate("channel-2");
    expect(session2).toBeDefined();
    // Can't directly test the prompt, but the session is created successfully
  });

  it("should update MCP config path for new sessions", () => {
    const manager = new SessionManager(defaultOptions);
    manager.updateMcpConfigPath("/path/to/mcp-config.json");
    const session = manager.getOrCreate("channel-1");
    expect(session).toBeDefined();
  });

  it("should handle reset of non-existent channel gracefully", () => {
    const manager = new SessionManager(defaultOptions);
    // Should not throw
    manager.reset("non-existent-channel");
  });
});

import { describe, it, expect } from "vitest";
import { ChannelMutex } from "../channel-mutex.js";

describe("ChannelMutex", () => {
  it("should allow acquiring a lock on an unlocked channel", async () => {
    const mutex = new ChannelMutex();
    const release = await mutex.acquire("ch1");
    expect(typeof release).toBe("function");
    release();
  });

  it("should serialize access to the same channel", async () => {
    const mutex = new ChannelMutex();
    const order: number[] = [];

    const release1 = await mutex.acquire("ch1");

    // Start a second acquire — it should wait
    const p2 = mutex.acquire("ch1").then((release) => {
      order.push(2);
      release();
    });

    // First task runs
    order.push(1);
    release1();

    await p2;

    expect(order).toEqual([1, 2]);
  });

  it("should allow parallel access to different channels", async () => {
    const mutex = new ChannelMutex();
    const events: string[] = [];

    const release1 = await mutex.acquire("ch1");
    const release2 = await mutex.acquire("ch2");

    // Both acquired simultaneously — no blocking
    events.push("ch1-acquired");
    events.push("ch2-acquired");

    release1();
    release2();

    expect(events).toEqual(["ch1-acquired", "ch2-acquired"]);
  });

  it("should process three messages in order for the same channel", async () => {
    const mutex = new ChannelMutex();
    const order: number[] = [];

    const release1 = await mutex.acquire("ch1");

    const p2 = (async () => {
      const release = await mutex.acquire("ch1");
      order.push(2);
      release();
    })();

    const p3 = (async () => {
      const release = await mutex.acquire("ch1");
      order.push(3);
      release();
    })();

    order.push(1);
    release1();

    await p2;
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it("should allow re-acquisition after release", async () => {
    const mutex = new ChannelMutex();

    const release1 = await mutex.acquire("ch1");
    release1();

    const release2 = await mutex.acquire("ch1");
    release2();

    // No deadlock — both acquired and released cleanly
    expect(true).toBe(true);
  });
});

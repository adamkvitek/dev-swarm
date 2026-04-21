/**
 * Per-channel mutex to serialize message processing.
 *
 * Prevents race conditions where multiple messages for the same channel
 * are processed concurrently (which caused the runaway agent incident).
 * Different channels can still process in parallel.
 */
export class ChannelMutex {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire the lock for a channel. Returns a release function.
   * If the channel is already locked, waits for the previous holder to finish.
   *
   * Uses promise-chaining to avoid the TOCTOU race in a while/await/set pattern.
   * `this.locks.set()` runs synchronously before the first `await`, so two
   * concurrent callers cannot both read the same `prev` promise.
   */
  async acquire(channelId: string): Promise<() => void> {
    let release!: () => void; // assigned synchronously by Promise constructor
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    const prev = this.locks.get(channelId) ?? Promise.resolve();
    const chain = prev.then(() => next);
    this.locks.set(channelId, chain);

    await prev;
    return () => {
      release();
      // Clean up if we're still the tail of the chain — prevents slow leak
      if (this.locks.get(channelId) === chain) {
        this.locks.delete(channelId);
      }
    };
  }
}

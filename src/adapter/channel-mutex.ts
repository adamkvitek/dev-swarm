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
   * If the channel is already locked, waits for the previous message to finish.
   */
  async acquire(channelId: string): Promise<() => void> {
    // Wait for any existing lock on this channel
    while (this.locks.has(channelId)) {
      await this.locks.get(channelId);
    }

    // Create a new lock
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = () => {
        this.locks.delete(channelId);
        resolve();
      };
    });

    this.locks.set(channelId, promise);
    return release;
  }
}

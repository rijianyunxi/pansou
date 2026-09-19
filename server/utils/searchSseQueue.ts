import type { SearchSourceUpdate } from "../core/types/models";

export const SEARCH_SSE_INTERVAL_MS = 16;

type PushUpdate = (update: SearchSourceUpdate) => Promise<void>;

/**
 * Sends the first completed source immediately, then keeps every later source
 * in FIFO order and emits at most one result event per 16ms interval.
 */
export class SearchSseQueue {
  private readonly pending: Array<{ update: SearchSourceUpdate; resolve: () => void; reject: (error: unknown) => void }> = [];
  private draining?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private resolveTimer?: () => void;
  private lastSentAt?: number;
  private failure?: unknown;
  private cancelled = false;

  constructor(
    private readonly pushUpdate: PushUpdate,
    private readonly intervalMs = SEARCH_SSE_INTERVAL_MS,
  ) {}

  enqueue(update: SearchSourceUpdate): void {
    void this.enqueueAndWait(update).catch(() => undefined);
  }

  /** Enqueue an update and resolve only after it has been pushed to SSE. */
  enqueueAndWait(update: SearchSourceUpdate): Promise<void> {
    if (this.cancelled || this.failure) return Promise.reject(this.failure || new Error("search stream cancelled"));
    return new Promise((resolve, reject) => {
      this.pending.push({ update, resolve, reject });
      this.startDrain();
    });
  }

  async finish(): Promise<void> {
    while (!this.cancelled && (this.pending.length > 0 || this.draining)) {
      if (this.failure) throw this.failure;
      if (!this.draining) this.startDrain();
      await this.draining;
    }
    if (this.failure) throw this.failure;
  }

  cancel(): void {
    this.cancelled = true;
    const reason = new Error("search stream cancelled");
    for (const item of this.pending) item.reject(reason);
    this.pending.length = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.resolveTimer?.();
    this.resolveTimer = undefined;
  }

  private startDrain(): void {
    if (this.cancelled || this.failure || this.draining || this.pending.length === 0) return;
    this.draining = this.drain()
      .catch((error) => {
        this.failure = error;
        for (const item of this.pending) item.reject(error);
        this.pending.length = 0;
      })
      .finally(() => {
        this.draining = undefined;
        if (this.pending.length > 0 && !this.cancelled && !this.failure) this.startDrain();
      });
  }

  private async drain(): Promise<void> {
    while (!this.cancelled && this.pending.length > 0) {
      if (this.lastSentAt !== undefined) {
        const remaining = this.intervalMs - (Date.now() - this.lastSentAt);
        if (remaining > 0) await this.wait(remaining);
      }
      if (this.cancelled) return;
      const item = this.pending.shift();
      if (!item) continue;
      await this.pushUpdate(item.update);
      item.resolve();
      this.lastSentAt = Date.now();
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.resolveTimer = resolve;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.resolveTimer = undefined;
        resolve();
      }, ms);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    });
  }
}

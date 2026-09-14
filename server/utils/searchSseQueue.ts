import type { NormalizedSearchSourceUpdate } from "../core/types/models";

export const SEARCH_SSE_INTERVAL_MS = 300;

type PushUpdate = (update: NormalizedSearchSourceUpdate) => Promise<void>;

/**
 * Sends the first completed source immediately, then keeps every later source
 * in FIFO order and emits exactly one result event per 300ms interval.
 */
export class SearchSseQueue {
  private readonly pending: NormalizedSearchSourceUpdate[] = [];
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

  enqueue(update: NormalizedSearchSourceUpdate): void {
    if (this.cancelled || this.failure) return;
    this.pending.push(update);
    this.startDrain();
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
      const update = this.pending.shift();
      if (!update) continue;
      await this.pushUpdate(update);
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

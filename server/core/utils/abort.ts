/** Shared cancellation primitives for DNS, transport loading and body reads. */
export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("操作已取消");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

export function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    // Handle late rejections even if the caller has already stopped waiting.
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** One total deadline, with explicit ownership of the timer and parent listener. */
export function createAbortScope(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  timeoutError = new Error("操作超时"),
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

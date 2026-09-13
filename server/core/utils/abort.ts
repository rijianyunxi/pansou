/** A disposable deadline that also follows caller cancellation. */
export function createAbortScope(
  timeoutMs: number,
  message: string,
  parent?: AbortSignal,
) {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;

  const timer = signal.aborted || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ? undefined : setTimeout(() => {
    const error = new Error(message);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);

  return {
    signal,
    abort(reason: unknown) { controller.abort(reason); },
    dispose() {
      clearTimeout(timer);
    },
  };
}

/** Stop waiting even for a non-cooperative source, without unhandled rejections. */
export async function runWithSignal<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }),
      aborted,
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

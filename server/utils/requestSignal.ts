import type { H3Event } from "h3";

/** Follow transport cancellation; a normally completed request body is not a disconnect. */
export async function withRequestSignal<T>(
  event: H3Event,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const { req, res } = event.node;
  const onAbort = () => controller.abort(new DOMException("客户端已断开搜索连接", "AbortError"));
  const onClose = () => { if (!res.writableEnded) onAbort(); };
  req.once?.("aborted", onAbort);
  res.once?.("close", onClose);
  if (req.aborted || res.destroyed) onAbort();
  const webSignal = event.web?.request?.signal;
  const signal = webSignal ? AbortSignal.any([controller.signal, webSignal]) : controller.signal;
  try {
    signal.throwIfAborted();
    return await operation(signal);
  } finally {
    req.off?.("aborted", onAbort);
    res.off?.("close", onClose);
  }
}

import { EventEmitter } from "node:events";
import type { H3Event } from "h3";
import { expect, it } from "vitest";
import { withRequestSignal } from "../../server/utils/requestSignal";
function event() {
  const req = Object.assign(new EventEmitter(), { aborted: false });
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
  return { node: { req, res } } as unknown as H3Event;
}
it("does not mistake a complete request body for a disconnected client", async () => {
  const e = event();
  await withRequestSignal(e, async (signal) => {
    e.node.req.emit("close");
    expect(signal.aborted).toBe(false);
    return 1;
  });
  expect(e.node.req.listenerCount("aborted")).toBe(0);
  expect(e.node.res.listenerCount("close")).toBe(0);
});
it("cancels an unfinished response and detaches listeners after failure", async () => {
  const e = event();
  await expect(withRequestSignal(e, async (signal) => {
    e.node.res.emit("close");
    signal.throwIfAborted();
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(e.node.req.listenerCount("aborted")).toBe(0);
  expect(e.node.res.listenerCount("close")).toBe(0);
});
it("ignores normal response completion", async () => {
  const e = event();
  await withRequestSignal(e, async (signal) => {
    Object.assign(e.node.res, { writableEnded: true });
    e.node.res.emit("close");
    expect(signal.aborted).toBe(false);
  });
});
it("follows the web request signal in non-Node adapters", async () => {
  const e = event();
  const controller = new AbortController();
  e.web = { request: new Request("https://example.com", { signal: controller.signal }) };
  await withRequestSignal(e, async (signal) => {
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

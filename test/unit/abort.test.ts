import { afterEach, expect, it, vi } from "vitest";
import { abortableDelay, createAbortScope, runWithSignal } from "../../server/core/utils/abort";
afterEach(() => vi.useRealTimers());
it("cleans up timers and abort listeners after success", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const scope = createAbortScope(100, "timeout", parent.signal);
  const add = vi.spyOn(scope.signal, "addEventListener");
  const remove = vi.spyOn(scope.signal, "removeEventListener");
  expect(await runWithSignal(async () => 42, scope.signal)).toBe(42);
  scope.dispose();
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  expect(vi.getTimerCount()).toBe(0);
  expect(parent.signal.aborted).toBe(false);
});
it("handles a synchronous throw and removes the listener", async () => {
  const signal = new AbortController().signal;
  const remove = vi.spyOn(signal, "removeEventListener");
  await expect(runWithSignal(() => { throw new Error("sync"); }, signal)).rejects.toThrow("sync");
  expect(remove).toHaveBeenCalledTimes(1);
});
it("does not invoke operations if cancelled before their microtask starts", async () => {
  const controller = new AbortController();
  const operation = vi.fn(async () => 1);
  const promise = runWithSignal(operation, controller.signal);
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  expect(operation).not.toHaveBeenCalled();
});
it("observes late failures after cancellation without unhandled rejections", async () => {
  const controller = new AbortController();
  let rejectLate!: (error: Error) => void;
  const promise = runWithSignal(() => new Promise((_, reject) => { rejectLate = reject; }), controller.signal);
  await Promise.resolve(); controller.abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  rejectLate(new Error("late upstream failure"));
  await Promise.resolve();
});
it("cleans up a cancelled delay and a pre-cancelled scope", async () => {
  vi.useFakeTimers();
  const controller = new AbortController(); controller.abort();
  const scope = createAbortScope(100, "timeout", controller.signal);
  await expect(abortableDelay(100, scope.signal)).rejects.toMatchObject({ name: "AbortError" });
  scope.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

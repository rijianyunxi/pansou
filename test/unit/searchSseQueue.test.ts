import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SearchSourceUpdate } from "../../server/core/types/models";
import { SearchSseQueue } from "../../server/utils/searchSseQueue";

function update(id: string): SearchSourceUpdate {
  return {
    source: { kind: "plugin", id },
    request: { keyword: "test", phase: "variant" },
    results: [],
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("sends every successful source once in FIFO order with a 300ms minimum interval", async () => {
  const pushes: Array<{ at: number; id: string }> = [];
  const queue = new SearchSseQueue(async (item) => {
    pushes.push({ at: Date.now(), id: item.source.id });
  });

  queue.enqueue(update("first"));
  await vi.advanceTimersByTimeAsync(0);
  const firstAt = pushes[0]!.at;
  expect(pushes).toEqual([{ at: firstAt, id: "first" }]);

  queue.enqueue(update("second"));
  await vi.advanceTimersByTimeAsync(120);
  queue.enqueue(update("third"));
  await vi.advanceTimersByTimeAsync(179);
  expect(pushes).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(pushes[1]).toEqual({ at: firstAt + 300, id: "second" });
  await vi.advanceTimersByTimeAsync(300);
  expect(pushes[2]).toEqual({ at: firstAt + 600, id: "third" });
  await queue.finish();
});

it("finish waits until every queued source has been pushed", async () => {
  const pushes: string[] = [];
  const queue = new SearchSseQueue(async (item) => { pushes.push(item.source.id); });
  queue.enqueue(update("first"));
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(100);
  queue.enqueue(update("second"));
  queue.enqueue(update("third"));
  const finished = queue.finish();
  await vi.advanceTimersByTimeAsync(199);
  expect(pushes).toEqual(["first"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(pushes).toEqual(["first", "second"]);
  await vi.advanceTimersByTimeAsync(300);
  await finished;
  expect(pushes).toEqual(["first", "second", "third"]);
  expect(vi.getTimerCount()).toBe(0);
});


it("surfaces transport failures without hanging finish", async () => {
  const queue = new SearchSseQueue(async () => { throw new Error("write failed"); });
  queue.enqueue(update("first"));
  queue.enqueue(update("second"));
  await expect(queue.finish()).rejects.toThrow("write failed");
  expect(vi.getTimerCount()).toBe(0);
});

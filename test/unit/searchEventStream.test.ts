import { expect, it } from "vitest";
import { consumeSearchEventStream } from "../../utils/searchEventStream";

it("parses fragmented CRLF SSE events and multiline data", async () => {
  const encoder = new TextEncoder();
  const fragments = [
    "id: 1\r\nevent: result\r\nda",
    "ta: {\"line\":\r\ndata: \"one\"}\r\n\r",
    "\nevent: complete\ndata: {\"code\":0}\n\n",
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const fragment of fragments) controller.enqueue(encoder.encode(fragment));
      controller.close();
    },
  });
  const events: Array<{ event: string; data: string; id?: string }> = [];
  await consumeSearchEventStream(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    (event) => { events.push(event); },
  );
  expect(events).toEqual([
    { id: "1", event: "result", data: "{\"line\":\n\"one\"}" },
    { event: "complete", data: "{\"code\":0}" },
  ]);
});

it("cancels the response body when an event consumer fails", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: error\ndata: {}\n\n"));
    },
    cancel() { cancelled = true; },
  });
  await expect(consumeSearchEventStream(new Response(body), () => {
    throw new Error("consumer failed");
  })).rejects.toThrow("consumer failed");
  expect(cancelled).toBe(true);
});

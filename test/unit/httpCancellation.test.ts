import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fetchWithRetry } from "../../server/core/utils/fetch";

let server: Server;
let base: string;
let onStarted: () => void;
let onClosed: () => void;
beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("unfinished body");
    response.once("close", () => onClosed());
    onStarted();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it.each(["caller", "deadline"])("%s cancellation closes a real in-flight ofetch response", async (mode) => {
  const started = new Promise<void>((resolve) => { onStarted = resolve; });
  const closed = new Promise<void>((resolve) => { onClosed = resolve; });
  const controller = new AbortController();
  const request = fetchWithRetry(base, { signal: controller.signal }, {
    timeout: mode === "deadline" ? 100 : 5000, maxRetries: 0,
  });
  const assertion = expect(request).rejects.toMatchObject({ name: mode === "deadline" ? "TimeoutError" : "AbortError" });
  await started;
  if (mode === "caller") controller.abort();
  await assertion;
  await closed;
  if (mode === "deadline") expect(controller.signal.aborted).toBe(false);
});

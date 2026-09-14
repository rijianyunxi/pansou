export interface ServerSentEvent {
  event: string;
  data: string;
  id?: string;
}

function parseEvent(block: string): ServerSentEvent | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
}

/** Consumes a fetch-based SSE response, including POST streams. */
export async function consumeSearchEventStream(
  response: Response,
  onEvent: (event: ServerSentEvent) => void | Promise<void>,
): Promise<void> {
  if (!response.body) throw new Error("搜索流没有响应体");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/^\uFEFF/, "");
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || "\n\n";
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator.length);
        const event = parseEvent(block);
        if (event) await onEvent(event);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
    const event = parseEvent(buffer.trim());
    if (event) await onEvent(event);
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The response stream may already be closed or aborted.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

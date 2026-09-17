import { awaitWithAbort } from "../utils/abort";

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Best-effort cleanup: an source cancellation failure is not the root error. */
export function discardResponseBody(response: Response): void {
  if (response.body && !response.body.locked && !response.bodyUsed) {
    void response.body.cancel().catch(() => undefined);
  }
}

export async function readResponseBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ body: string; bytes: number }> {
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? undefined : Number(declaredHeader);
  if (
    declared !== undefined &&
    (!Number.isSafeInteger(declared) || declared < 0)
  ) {
    discardResponseBody(response);
    throw new Error("响应包含无效的 Content-Length");
  }
  if (declared !== undefined && declared > maxBytes) {
    discardResponseBody(response);
    throw new Error(`响应超过大小限制 (${maxBytes} bytes)`);
  }
  if (!response.body) {
    const body = await awaitWithAbort(response.text(), signal);
    const bytes = byteLength(body);
    if (bytes > maxBytes) {
      throw new Error(`响应超过大小限制 (${maxBytes} bytes)`);
    }
    return { body, bytes };
  }

  const reader = response.body.getReader();
  // When the server declares a valid length, write directly into one exact
  // buffer. This avoids retaining `chunks` and then allocating/copying into a
  // second `merged` buffer after the download completes.
  let buffer = new Uint8Array(declared ?? Math.min(maxBytes, 64 * 1024));
  let bytes = 0;

  try {
    while (true) {
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      if (done) break;

      const nextBytes = bytes + value.byteLength;
      if (nextBytes > maxBytes) {
        throw new Error(`响应超过大小限制 (${maxBytes} bytes)`);
      }

      // For chunked responses, grow geometrically but never beyond the
      // configured limit. The old buffer is released after each resize; no
      // unbounded chunk list is retained.
      if (nextBytes > buffer.byteLength) {
        if (declared !== undefined) {
          throw new Error("响应实际大小超过 Content-Length");
        }
        const nextCapacity = Math.min(
          maxBytes,
          Math.max(nextBytes, Math.max(1, buffer.byteLength * 2)),
        );
        const nextBuffer = new Uint8Array(nextCapacity);
        nextBuffer.set(buffer.subarray(0, bytes));
        buffer = nextBuffer;
      }

      buffer.set(value, bytes);
      bytes = nextBytes;
    }

    return {
      body: new TextDecoder().decode(buffer.subarray(0, bytes)),
      bytes,
    };
  } catch (error) {
    // Cleanup must not mask the original rejection or prolong a deadline.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function isExpectedContentType(
  contentType: string,
  expected: readonly string[]
): boolean {
  return expected.some((allowed) => {
    const normalized = allowed.toLowerCase();
    if (normalized === "application/*+json") {
      return contentType.startsWith("application/") && contentType.endsWith("+json");
    }
    return contentType === normalized;
  });
}


import { resolveSafeHostAddresses, type HostResolver } from "../security/dnsGuard";
import { awaitWithAbort, createAbortScope, throwIfAborted } from "../utils/abort";
import { logSourceRequest } from "../utils/sourceDebug";
import { loadPinnedHttpTransport, type PinnedHttpTransport } from "./pinnedTransport";
import { discardResponseBody, readResponseBody } from "./responseBody";
import { prepareSafeHttpRequest, redirectTarget, validateResponseType } from "./requestPolicy";
import type { SafeHttpRequest, SafeHttpResponse } from "./types";

// Compatibility exports for existing callers.
export type { SafeHttpRequest, SafeHttpResponse } from "./types";
export { FORBIDDEN_OUTBOUND_HEADERS, isForbiddenOutboundHeader } from "../security/outboundHeaders";

export interface SafeHttpDependencies {
  loadTransport(): Promise<PinnedHttpTransport | null>;
  resolveHost: HostResolver;
  log: typeof logSourceRequest;
}

/** Single outbound boundary; injected I/O keeps its policy testable offline. */
export function createSafeHttpExecutor(dependencies: SafeHttpDependencies) {
  return async function execute(request: SafeHttpRequest): Promise<SafeHttpResponse> {
    throwIfAborted(request.signal);
    const { url, headers, urlOptions } = prepareSafeHttpRequest(request);
    let requestUrl = url;

    const timeoutError = new Error("安全 HTTP 请求超时 (" + request.timeoutMs + "ms)");
    timeoutError.name = "TimeoutError";
    const scope = createAbortScope(request.signal, request.timeoutMs, timeoutError);
    const started = Date.now();
    try {
      dependencies.log("start", { method: request.method, url: requestUrl.toString(), body: request.body });
      // Never fall back to native fetch, including for IP literals.
      const transport = await awaitWithAbort(dependencies.loadTransport(), scope.signal);
      if (!transport) throw new Error("当前运行时不支持安全出站传输，已拒绝请求");
      let redirects = 0;
      for (;;) {
        throwIfAborted(scope.signal);
        // Revalidate and pin every hop; transport must not resolve the host again.
        const pinned = await awaitWithAbort(dependencies.resolveHost(requestUrl.hostname, scope.signal), scope.signal);
        throwIfAborted(scope.signal);
        const pendingResponse = transport.request(requestUrl, {
          method: request.method,
          headers,
          body: request.body,
          signal: scope.signal,
        }, pinned);
        // Injected transports may ignore cancellation. Release a late response
        // and enforce the same total deadline while waiting for headers.
        void pendingResponse.then(response => {
          if (scope.signal.aborted) discardResponseBody(response);
        }, () => undefined);
        const response = await awaitWithAbort(pendingResponse, scope.signal);
        try {
          throwIfAborted(scope.signal);
          if (response.status >= 300 && response.status < 400) {
            requestUrl = redirectTarget(response, requestUrl, redirects, request, urlOptions);
            redirects++;
            continue;
          }
          const contentType = validateResponseType(response, request.expectedContentTypes);
          const payload = await readResponseBody(response, request.maxResponseBytes, scope.signal);
          const elapsedMs = Date.now() - started;
          dependencies.log("success", {
            method: request.method, url: requestUrl.toString(), status: response.status,
            elapsedMs, bytes: payload.bytes, contentType, responsePreview: payload.body,
          });
          return { response, url: requestUrl, ...payload, contentType, redirects, elapsedMs };
        } finally {
          discardResponseBody(response);
        }
      }
    } catch (error) {
      dependencies.log("error", {
        method: request.method, url: requestUrl.toString(), elapsedMs: Date.now() - started, error,
      });
      throw error;
    } finally {
      scope.dispose();
    }
  };
}

export const executeSafeHttp = createSafeHttpExecutor({
  loadTransport: loadPinnedHttpTransport,
  resolveHost: resolveSafeHostAddresses,
  log: logSourceRequest,
});

import { describe, expect, it } from "vitest";
import { isAllowedAdminOrigin } from "../../server/core/security/adminOrigin";
import { MemoryRateLimiter } from "../../server/core/security/rateLimit";

describe("admin request security", () => {
  it("rejects cross-site mutations and accepts same-origin or CLI requests", () => {
    expect(
      isAllowedAdminOrigin({
        method: "POST",
        host: "panhub.example",
        origin: "https://evil.example",
        secFetchSite: "cross-site",
      })
    ).toBe(false);
    expect(
      isAllowedAdminOrigin({
        method: "POST",
        host: "panhub.example",
        origin: "https://panhub.example",
        secFetchSite: "same-origin",
      })
    ).toBe(true);
    expect(
      isAllowedAdminOrigin({ method: "POST", host: "panhub.example" })
    ).toBe(true);
  });

  it("enforces a fixed-window request limit", () => {
    const limiter = new MemoryRateLimiter();
    expect(limiter.check("login:ip", { limit: 2, windowMs: 1000 }, 0).allowed).toBe(true);
    expect(limiter.check("login:ip", { limit: 2, windowMs: 1000 }, 1).allowed).toBe(true);
    const denied = limiter.check("login:ip", { limit: 2, windowMs: 1000 }, 2);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(998);
    expect(limiter.check("login:ip", { limit: 2, windowMs: 1000 }, 1001).allowed).toBe(true);
  });
});

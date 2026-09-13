import { describe, expect, it } from "vitest";
import { validateOutboundUrl } from "../../server/core/security/outboundUrl";

describe("validateOutboundUrl", () => {
  it.each([
    "https://127.0.0.1/path",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/path",
    "https://198.18.0.1/path",
    "https://224.0.0.1/path",
    "https://[::1]/path",
    "https://[::ffff:127.0.0.1]/path",
  ])("blocks private and reserved address %s", (url) => {
    expect(() => validateOutboundUrl(url)).toThrow(/禁止访问/);
  });

  it("requires HTTPS and standard ports by default", () => {
    expect(() => validateOutboundUrl("http://example.com")).toThrow(/HTTPS/);
    expect(() => validateOutboundUrl("https://example.com:444/path")).toThrow(
      /端口/
    );
    expect(validateOutboundUrl("https://example.com/path").hostname).toBe(
      "example.com"
    );
  });

  it("allows explicitly audited HTTP URLs only on the standard port", () => {
    expect(
      validateOutboundUrl("http://example.com/path", { allowHttp: true }).protocol
    ).toBe("http:");
    expect(() =>
      validateOutboundUrl("http://example.com:8080/path", { allowHttp: true })
    ).toThrow(/端口/);
  });
});

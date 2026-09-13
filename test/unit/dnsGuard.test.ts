import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeHostResolution,
  resolveSafeHostAddresses,
  setDohResolver,
  type HostResolver,
} from "../../server/core/security/dnsGuard";

const resolveTo = (addresses: string[]): HostResolver => async () =>
  addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));

afterEach(() => {
  setDohResolver(undefined);
});

describe("assertSafeHostResolution", () => {
  it("rejects when any resolved address is private", async () => {
    await expect(
      assertSafeHostResolution(
        "rebind.example",
        resolveTo(["93.184.216.34", "192.168.1.10"])
      )
    ).rejects.toThrow(/DNS 解析到内网或保留地址/);
  });

  it("rejects loopback, link-local, metadata and v4-mapped addresses", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.7",
      "169.254.169.254",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.2",
    ]) {
      await expect(
        assertSafeHostResolution("rebind.example", resolveTo([address]))
      ).rejects.toThrow(/内网或保留地址/);
    }
  });

  it("allows public addresses", async () => {
    await expect(
      assertSafeHostResolution(
        "example.com",
        resolveTo(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
      )
    ).resolves.toBeUndefined();
  });

  it("fails open when the resolver itself is unavailable", async () => {
    await expect(
      assertSafeHostResolution(
        "example.com",
        async () => {
          throw new Error("EAI_AGAIN");
        }
      )
    ).resolves.toBeUndefined();
  });

  it("validates IP literals without touching the resolver", async () => {
    await expect(
      assertSafeHostResolution(
        "169.254.169.254",
        async () => {
          throw new Error("should not resolve");
        }
      )
    ).rejects.toThrow(/内网或保留地址/);
    await expect(
      assertSafeHostResolution("example.com", null)
    ).resolves.toBeUndefined();
  });
});

describe("resolveSafeHostAddresses", () => {
  it("returns the validated records so callers can pin the connection", async () => {
    const records = await resolveSafeHostAddresses(
      "example.com",
      resolveTo(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
    );
    expect(records).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
  });

  it("re-resolves synthetic 198.18/15 answers through the DoH fallback", async () => {
    setDohResolver(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);

    await expect(
      resolveSafeHostAddresses("example.com", resolveTo(["198.18.0.119"]))
    ).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("does not bypass mixed or ordinary private resolutions", async () => {
    setDohResolver(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);

    await expect(
      resolveSafeHostAddresses(
        "rebind.example",
        resolveTo(["198.18.0.119", "192.168.1.10"])
      )
    ).rejects.toThrow(/DNS 解析到内网或保留地址/);
  });

  it("still rejects private resolutions", async () => {
    await expect(
      resolveSafeHostAddresses("rebind.example", resolveTo(["192.168.1.10"]))
    ).rejects.toThrow(/DNS 解析到内网或保留地址/);
  });

  it("returns the address for public IP literals without a lookup", async () => {
    const records = await resolveSafeHostAddresses(
      "93.184.216.34",
      async () => {
        throw new Error("should not resolve");
      }
    );
    expect(records).toEqual([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      resolveSafeHostAddresses("169.254.169.254", async () => [])
    ).rejects.toThrow(/内网或保留地址/);
  });

  it("returns null when the resolver is unavailable or fails (fail-open)", async () => {
    await expect(
      resolveSafeHostAddresses("example.com", null)
    ).resolves.toBeNull();
    await expect(
      resolveSafeHostAddresses("example.com", async () => {
        throw new Error("EAI_AGAIN");
      })
    ).resolves.toBeNull();
    await expect(
      resolveSafeHostAddresses("example.com", async () => [])
    ).resolves.toBeNull();
  });
});

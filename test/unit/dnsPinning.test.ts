/**
 * DNS 钉住传输（server/core/utils/fetch.ts）单元测试。
 *
 * 全部流量走本地 127.0.0.1 http server；主机名使用保留 TLD "pinning.test"
 * （系统 DNS 必然无法解析），因此请求成功当且仅当 socket 真正连到了
 * 注入的已校验 IP —— 以此证明"解析结果与实际连接一致"。
 */
import * as nodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as nodeStream from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createNodePinnedHttpTransport,
  loadPinnedHttpTransport,
  setPinnedHttpTransport,
  type NodePinnedHttpModule,
  type NodePinnedTransportModules,
  type PinnedHttpTransport,
} from "../../server/core/utils/fetch";
import type { DnsLookupRecord } from "../../server/core/security/dnsGuard";

const LOOPBACK: DnsLookupRecord = { address: "127.0.0.1", family: 4 };
const FAKE_HOST = "pinning.test";

interface CapturedRequest {
  remoteAddress?: string;
  host?: string;
  url?: string;
  method?: string;
  contentLength?: string;
  body: string;
  closed: Promise<void>;
}

let server: nodeHttp.Server;
let port = 0;
let transport: PinnedHttpTransport | null;
const requests: CapturedRequest[] = [];

beforeAll(async () => {
  server = nodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const closed = new Promise<void>((resolve) => {
        response.once("close", () => resolve());
      });
      requests.push({
        remoteAddress: request.socket.remoteAddress,
        host: request.headers.host,
        url: request.url,
        method: request.method,
        contentLength: request.headers["content-length"],
        body: Buffer.concat(chunks).toString("utf8"),
        closed,
      });
      if (request.url === "/hang") {
        // 收到请求但永不响应：用于验证请求发起后的取消。
        return;
      }
      if (request.url === "/hang-body") {
        // 发送头部与部分 body 后挂起：用于验证响应流读取中的取消。
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("chunk");
        return;
      }
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/final" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/plain",
        "x-test": "yes",
      });
      response.end("ok-body");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  port = address.port;
  transport = await loadPinnedHttpTransport();
});

afterEach(() => {
  requests.length = 0;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function mustTransport(): PinnedHttpTransport {
  if (!transport) {
    throw new Error("pinned transport unavailable in test environment");
  }
  return transport;
}

describe("node pinned http transport", () => {
  it("connects to the pinned address while keeping the original Host header, path and query", async () => {
    const response = await mustTransport().request(
      new URL(`http://${FAKE_HOST}:${port}/hello?q=pin`),
      { method: "GET", headers: {} },
      [LOOPBACK]
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-test")).toBe("yes");
    await expect(response.text()).resolves.toBe("ok-body");
    expect(requests).toHaveLength(1);
    // "pinning.test" 无法被系统 DNS 解析：请求成功即证明连接钉在 127.0.0.1。
    expect(requests[0]!.remoteAddress).toBe("127.0.0.1");
    expect(requests[0]!.host).toBe(`${FAKE_HOST}:${port}`);
    expect(requests[0]!.url).toBe("/hello?q=pin");
  });

  it("never falls back to system DNS or a different address", async () => {
    // 占住一个端口后立即释放：钉住地址指向该已关闭端口时必然立刻
    // ECONNREFUSED。错误码同时证明 socket 确实连向了钉住的
    // 127.0.0.1:closedPort —— 若回退到系统 DNS，"pinning.test" 无法解析，
    // 只会得到 ENOTFOUND 而非 ECONNREFUSED。
    // （不能用无监听的 127.0.0.2 之类地址：macOS 对 127.0.0.1 以外的环回
    // 地址不回 RST，connect 会静默挂起直到超时。）
    const probe = nodeHttp.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await expect(
      mustTransport().request(
        new URL(`http://${FAKE_HOST}:${closedPort}/hello`),
        { method: "GET", headers: {} },
        [LOOPBACK]
      )
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(requests).toHaveLength(0);
  });

  it("keeps SNI, Host and secure certificate defaults for https requests", async () => {
    const captured: Array<Record<string, unknown>> = [];
    // https 模块替身：记录真实选项后委托给明文 http 模块，避免依赖 TLS 服务器。
    const httpsStub: NodePinnedHttpModule = {
      request(options, callback) {
        captured.push(options);
        return nodeHttp.request(
          options as unknown as nodeHttp.RequestOptions,
          callback
        );
      },
    };
    const modules: NodePinnedTransportModules = {
      http: nodeHttp,
      https: httpsStub,
      stream: nodeStream,
    };
    const stubbed = createNodePinnedHttpTransport(modules);
    expect(stubbed).not.toBeNull();
    await expect(
      stubbed!.request(
        new URL("https://secure.test/hello"),
        { method: "GET", headers: {} },
        [LOOPBACK]
      )
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(captured).toHaveLength(1);
    // 连接目标是主机名而非 IP（Host/SNI/证书校验都基于原始域名）……
    expect(captured[0]!.host).toBe("secure.test");
    expect(captured[0]!.servername).toBe("secure.test");
    // ……证书校验保持安全默认值，未被削弱。
    expect(captured[0]!.rejectUnauthorized).not.toBe(false);
    // lookup 被替换为钉住实现：无论 options.all 与否都返回已校验地址。
    const lookup = captured[0]!.lookup as (
      hostname: string,
      options: { all?: boolean },
      callback: (
        err: Error | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number
      ) => void
    ) => void;
    lookup(
      "secure.test",
      { all: true },
      (_err, addresses) => {
        expect(addresses).toEqual([LOOPBACK]);
      }
    );
    lookup("secure.test", {}, (_err, address, family) => {
      expect(address).toBe("127.0.0.1");
      expect(family).toBe(4);
    });
  });

  it("rejects with the caller's abort reason and closes the socket before any response", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const request = mustTransport().request(
      new URL(`http://${FAKE_HOST}:${port}/hang`),
      { method: "GET", headers: {}, signal: controller.signal },
      [LOOPBACK]
    );
    const assertion = expect(request).rejects.toBe(reason);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort(reason);
    await assertion;
    await requests[0]!.closed;
  });

  it("aborts an in-flight response body read with the caller's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("mid-body abort");
    const response = await mustTransport().request(
      new URL(`http://${FAKE_HOST}:${port}/hang-body`),
      { method: "GET", headers: {}, signal: controller.signal },
      [LOOPBACK]
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value!)).toContain("chunk");
    const pending = reader.read();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await requests[0]!.closed;
  });

  it("sends POST bodies with an explicit content-length", async () => {
    const body = JSON.stringify({ q: "pan" });
    const response = await mustTransport().request(
      new URL(`http://${FAKE_HOST}:${port}/echo`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
      [LOOPBACK]
    );
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.body).toBe(body);
    expect(requests[0]!.contentLength).toBe(
      String(new TextEncoder().encode(body).byteLength)
    );
  });

  it("propagates upstream status and headers without following redirects", async () => {
    const response = await mustTransport().request(
      new URL(`http://${FAKE_HOST}:${port}/redirect`),
      { method: "GET", headers: {} },
      [LOOPBACK]
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/final");
  });

  it("loadPinnedHttpTransport honors the override hook", async () => {
    const fake: PinnedHttpTransport = {
      request: async () => new Response("override"),
    };
    setPinnedHttpTransport(fake);
    expect(await loadPinnedHttpTransport()).toBe(fake);
    setPinnedHttpTransport(null);
    expect(await loadPinnedHttpTransport()).toBeNull();
    setPinnedHttpTransport(undefined);
    expect(await loadPinnedHttpTransport()).not.toBeNull();
  });
});

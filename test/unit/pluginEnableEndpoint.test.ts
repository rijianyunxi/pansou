import { createServer, type Server } from "node:http";
import { createApp, createRouter, toNodeListener } from "h3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthToken } from "../../server/utils/auth";

/** /api/plugins/:id/enable：仓库 mock，鉴权走真实链路。 */
const mocks = vi.hoisted(() => ({ enable: vi.fn() }));
vi.mock("../../server/core/plugins/repository", () => ({
  getPluginRepository: () => ({ enable: mocks.enable }),
}));

import enableRoute from "../../server/api/plugins/[id]/enable.post";

const ADMIN_PASSWORD = "secret";
let server: Server;
let base: string;

beforeAll(async () => {
  vi.stubGlobal("useRuntimeConfig", () => ({ adminPassword: ADMIN_PASSWORD }));
  const app = createApp();
  const router = createRouter();
  router.use("/api/plugins/:id/enable", enableRoute);
  app.use(router);
  server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
});

const cookie = () => `panhub_admin=${createAuthToken(ADMIN_PASSWORD)}`;

async function post(id: string, options: { auth?: boolean; body?: unknown } = {}) {
  const response = await fetch(`${base}/api/plugins/${id}/enable`, {
    method: "POST",
    headers: {
      ...(options.auth === false ? {} : { cookie: cookie() }),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { response, body: await response.json().catch(() => null) };
}

describe("POST /api/plugins/:id/enable", () => {
  it("未管理员时 401", async () => {
    const { response } = await post("ruleplugin", { auth: false });
    expect(response.status).toBe(401);
  });

  it("恢复停用插件并写审计（actor 透传）", async () => {
    const record = { id: "ruleplugin", status: "published", publishedVersion: "1.0.0" };
    mocks.enable.mockResolvedValueOnce(record);
    const { response, body } = await post("ruleplugin", { body: { actor: "tester" } });
    expect(response.status).toBe(200);
    expect(body).toEqual({ code: 0, message: "enabled", data: record });
    expect(mocks.enable).toHaveBeenCalledWith("ruleplugin", "tester");
  });

  it("未提供 actor 时默认 admin", async () => {
    mocks.enable.mockResolvedValueOnce({ id: "a", status: "published" });
    await post("a");
    expect(mocks.enable).toHaveBeenCalledWith("a", "admin");
  });

  it("仓库抛错时映射为 400", async () => {
    mocks.enable.mockRejectedValueOnce(new Error("插件从未发布过，无法启用"));
    const { response, body } = await post("never-published");
    expect(response.status).toBe(400);
    expect(body.message ?? body.statusMessage).toContain("无法启用");
  });
});

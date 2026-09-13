import { createServer, type Server } from "node:http";
import { createApp, createRouter, toNodeListener } from "h3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthToken } from "../../server/utils/auth";

/**
 * 频道启停/删除端点：searchSettingsService 走 mock（可变对象），
 * tgChannelSettings 用真实实现 + mock fs（不落盘），鉴权走真实链路。
 */
const fs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock("fs", () => fs);

const settingsState = vi.hoisted(() => ({
  value: {
    channels: ["customone", "sharedone"] as string[] | null,
    plugins: null,
    concurrency: null,
    pluginTimeoutMs: null,
    trashedPlugins: [] as string[],
  },
}));
vi.mock("../../server/core/services/searchSettingsService", () => ({
  getSearchSettings: () => settingsState.value,
  saveSearchSettings: (patch: Record<string, unknown>) => {
    settingsState.value = { ...settingsState.value, ...patch } as typeof settingsState.value;
    return settingsState.value;
  },
}));

import deleteRoute from "../../server/api/tg/channels/[channel].delete";
import disableRoute from "../../server/api/tg/channels/[channel]/disable.post";
import enableRoute from "../../server/api/tg/channels/[channel]/enable.post";
import {
  clearTgChannelState,
  getTgChannelPoliciesVersion,
  getTgChannelStates,
} from "../../server/core/services/tgChannelSettings";
import { getSqliteDatabase } from "../../server/core/storage/sqlite";

const ADMIN = { adminPassword: "secret", defaultChannels: ["SharedOne", "BuiltinOne"] };

let server: Server;
let base: string;

beforeAll(async () => {
  vi.stubGlobal("useRuntimeConfig", () => ADMIN);
  const app = createApp();
  const router = createRouter();
  router.use("/api/tg/channels/:channel", deleteRoute);
  router.use("/api/tg/channels/:channel/disable", disableRoute);
  router.use("/api/tg/channels/:channel/enable", enableRoute);
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

beforeEach(() => {
  Object.values(fs).forEach((fn) => fn.mockReset());
  fs.existsSync.mockReturnValue(false);
  settingsState.value = {
    channels: ["customone", "sharedone"],
    plugins: null,
    concurrency: null,
    pluginTimeoutMs: null,
    trashedPlugins: [],
  };
  for (const name of Object.keys(getTgChannelStates())) clearTgChannelState(name);
});

function cookieHeader(): string {
  return `panhub_admin=${createAuthToken(ADMIN.adminPassword)}`;
}

async function call(method: string, path: string, options: { auth?: boolean } = { auth: true }) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: options.auth === false ? {} : { cookie: cookieHeader() },
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

describe("频道启停/删除端点", () => {
  it("未管理员时 401（disable / enable / delete 一致）", async () => {
    expect((await call("POST", "/api/tg/channels/OffChan/disable", { auth: false })).response.status).toBe(401);
    expect((await call("POST", "/api/tg/channels/OffChan/enable", { auth: false })).response.status).toBe(401);
    expect((await call("DELETE", "/api/tg/channels/OffChan", { auth: false })).response.status).toBe(401);
  });

  it("频道名非法时 400", async () => {
    expect((await call("POST", "/api/tg/channels/bad%20name%21/disable")).response.status).toBe(400);
    expect((await call("POST", "/api/tg/channels/abc/enable")).response.status).toBe(400);
    expect((await call("DELETE", "/api/tg/channels/%40legal%3Fname")).response.status).toBe(400);
  });

  it("disable：任意 pattern 合法频道写入覆盖状态并返回生效频道数", async () => {
    const versionBefore = getTgChannelPoliciesVersion();
    const { response, body } = await call("POST", "/api/tg/channels/OffChan/disable");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toEqual({
      code: 0,
      message: "disabled",
      data: {
        channel: "offchan",
        enabled: false,
        deleted: false,
        origin: "custom", // 不在自定义/内置清单中 → 按 custom 兜底
        effectiveCount: 2, // customone + sharedone
      },
    });
    expect(getTgChannelStates().offchan).toEqual({ enabled: false, deleted: false });
    expect(getTgChannelPoliciesVersion()).toBeGreaterThan(versionBefore);
  });

  it("disable 内置默认频道 origin=builtin；enable 恢复（启用=清除覆盖）", async () => {
    const disabled = await call("POST", "/api/tg/channels/BuiltinOne/disable");
    expect(disabled.body.data).toMatchObject({ channel: "builtinone", enabled: false, origin: "builtin" });
    const enabled = await call("POST", "/api/tg/channels/builtinone/enable");
    expect(enabled.body).toEqual({
      code: 0,
      message: "enabled",
      data: {
        channel: "builtinone",
        enabled: true,
        deleted: false,
        origin: "builtin",
        effectiveCount: 2,
      },
    });
    expect(getTgChannelStates().builtinone).toBeUndefined();
  });

  it("delete 内置默认频道：置 deleted=true 覆盖，enable 可恢复", async () => {
    const { body } = await call("DELETE", "/api/tg/channels/BuiltinOne");
    expect(body).toEqual({
      code: 0,
      message: "deleted",
      data: {
        channel: "builtinone",
        enabled: true,
        deleted: true,
        origin: "builtin",
        effectiveCount: 2,
      },
    });
    // 已删除频道 enable = 恢复
    const revived = await call("POST", "/api/tg/channels/builtinone/enable");
    expect(revived.body.data).toMatchObject({ enabled: true, deleted: false });
    expect(getTgChannelStates().builtinone).toBeUndefined();
  });

  it("delete 自定义频道：从清单移除并清除覆盖状态", async () => {
    const { body } = await call("DELETE", "/api/tg/channels/customone");
    expect(body).toEqual({
      code: 0,
      message: "deleted",
      data: {
        channel: "customone",
        enabled: true,
        deleted: false,
        origin: "custom",
        effectiveCount: 1, // 清单只剩 sharedone
      },
    });
    expect(settingsState.value.channels).toEqual(["sharedone"]);
    expect(getTgChannelStates().customone).toBeUndefined();
  });

  it("delete 同时存在于自定义与内置清单的频道按自定义处理", async () => {
    const { body } = await call("DELETE", "/api/tg/channels/SharedOne");
    // 从自定义清单移除后仍是内置默认频道 → 按当前清单计算 origin 为 builtin
    expect(body.data).toMatchObject({ channel: "sharedone", origin: "builtin", deleted: false });
    expect(settingsState.value.channels).toEqual(["customone"]);
  });

  it("delete 不在两个清单中的频道 404", async () => {
    const { response } = await call("DELETE", "/api/tg/channels/unknownch");
    expect(response.status).toBe(404);
  });

  it("持久化失败时返回非 0 code 与 message", async () => {
    vi.spyOn(getSqliteDatabase(), "transaction").mockImplementationOnce(() => {
      throw new Error("read only");
    });
    const { body } = await call("POST", "/api/tg/channels/offchan/disable");
    expect(body.code).not.toBe(0);
    expect(typeof body.message).toBe("string");
  });
});

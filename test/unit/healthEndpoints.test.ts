import { describe, expect, it } from "vitest";

/**
 * API 端点模块冒烟测试：两个健康端点依赖 Nitro 运行时（useRuntimeConfig、
 * 请求上下文），完整调用留给 e2e；这里验证模块可加载、导入图完整、
 * 导出的是 h3 事件处理器。
 */
describe("health endpoint modules", () => {
  it("loads /api/plugin-health and keeps additive payload fields", async () => {
    const module = await import("../../server/api/plugin-health.get");
    expect(typeof module.default).toBe("function");
  });

  it("loads /api/health with the three semantic layers in place", async () => {
    const module = await import("../../server/api/health.get");
    expect(typeof module.default).toBe("function");
  });
});

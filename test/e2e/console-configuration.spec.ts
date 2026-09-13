import { expect, test, type Page } from "@playwright/test";
test.use({ reducedMotion: "reduce" });
async function unlock(page: Page, url = "/admin") {
  await page.goto(url);
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "进入管理控制台" }).click();
  await expect(page.getByRole("button", { name: "退出管理" })).toBeVisible();
}

test("TG 配置频道目录：增删、启停即时生效；其他设置不覆盖频道", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (reason) => errors.push(reason.message));
  // 系统/手动频道的"删除"都会弹确认框，统一接受
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await unlock(page, "/admin?view=telegram");
  const manager = page.getByRole("region", { name: "TG 频道管理" });
  await expect(manager).toBeVisible();
  const original = (await (await page.request.get("/api/settings/telegram")).json()).data;
  expect(original.channels).toBeNull();
  expect((await page.request.put("/api/settings/telegram", { data: { channels: ["https://t.me/badchannel"] } })).status()).toBe(400);
  expect((await page.request.put("/api/settings/search", { data: { channels: ["not/a/name"] } })).status()).toBe(400);
  expect(original.effectiveChannels.length).toBeGreaterThan(0);
  // 关闭 TG：即时生效
  await manager.getByRole("switch", { name: "TG 参与本站搜索" }).click();
  await expect(manager.getByText("TG 已关闭，下一次本站搜索不再追加已配置频道。")).toBeVisible();
  expect((await (await page.request.get("/api/settings/telegram")).json()).data.effectiveChannels).toEqual([]);
  await page.reload();
  await expect(manager.getByRole("switch", { name: "TG 参与本站搜索" })).toHaveAttribute("aria-checked", "false");
  // 重新开启 = 恢复默认频道
  await manager.getByRole("switch", { name: "TG 参与本站搜索" }).click();
  await expect(manager.getByText("TG 已开启（默认配置），下一次本站搜索生效。")).toBeVisible();
  // 新增频道：立即保存并进入统一目录
  await manager.getByLabel("新增公开频道").fill("https://t.me/s/AdminChannel/123");
  await manager.getByRole("button", { name: "添加频道", exact: true }).click();
  await expect(manager.getByText("@adminchannel 已添加并保存，下一次本站搜索生效。")).toBeVisible();
  expect((await (await page.request.get("/api/settings/telegram")).json()).data.channels).toContain("adminchannel");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "搜索设置" }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByText("搜索设置已保存，下一次搜索立即生效。")).toBeVisible();
  expect((await (await page.request.get("/api/settings/telegram")).json()).data.channels).toContain("adminchannel");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "TG 频道管理" }).click();
  await expect(manager.getByText("@adminchannel", { exact: true })).toBeVisible();
  await expect(page.locator(".console-toast")).not.toBeVisible();
  await page.screenshot({ path: ".tmp/tg-manager-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".tmp/tg-manager-mobile.png", fullPage: true });
  await manager.getByRole("button", { name: "调试报文 adminchannel" }).click();
  await expect(page).toHaveURL(/\/admin\?view=telegram$/);
  const drawer = page.getByRole("dialog", { name: "调试报文 · @adminchannel" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "关闭频道调试" }).click();
  // 删除自定义频道：确认后立即保存
  await manager.getByRole("button", { name: "删除频道 adminchannel" }).click();
  await expect(manager.getByText("@adminchannel 已移除并保存，下一次本站搜索生效。")).toBeVisible();
  expect((await (await page.request.get("/api/settings/telegram")).json()).data.channels).not.toContain("adminchannel");
  // 恢复默认配置
  await manager.getByRole("button", { name: "恢复默认配置" }).click();
  await expect(manager.getByText("已恢复默认频道配置。")).toBeVisible();
  expect((await (await page.request.get("/api/settings/telegram")).json()).data.channels).toBeNull();
  expect(errors).toEqual([]);
});

test("上游目录只负责配置入口，详情和调试通过抽屉打开", async ({ page }) => {
  await unlock(page, "/admin?view=sources");
  const nav = page.getByRole("navigation", { name: "工作台导航" });
  await expect(nav.getByRole("button", { name: "适配器映射" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "在线调试" })).toHaveCount(0);

  const pluginId = "e2e-directory-source";
  const definition = {
    schemaVersion: 1,
    manifest: { id: pluginId, name: "E2E 目录上游", version: "1.0.0", kind: "instructions", priority: 50, timeoutMs: 3000, maxResults: 20, schemaVersion: 1, outputTypes: [] },
    request: { method: "GET", url: "https://example.com/search", allowedDomains: ["example.com"], query: { keyword: "{{keyword}}" } },
    response: { format: "json", transform: "function transform(payload, $, context) { return []; }", items: "data", fields: { title: "title" }, links: { url: "url" } },
  };
  const create = await page.request.post("/api/plugins", { data: { definition } });
  expect(create.ok()).toBe(true);
  await page.reload();

  const sourceRow = page.getByRole("row", { name: /E2E 目录上游/ });
  await expect(sourceRow).toBeVisible();
  await expect(page.getByRole("button", { name: "导入 JS" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导出 JS" })).toHaveCount(0);
  await expect(page.locator("table").getByText("解析函数")).toHaveCount(0);

  await sourceRow.getByRole("button", { name: "详情" }).click();
  const detail = page.locator(".detail-drawer");
  await expect(detail).toBeVisible();
  await expect(detail).not.toContainText("解析函数");
  await detail.getByRole("button", { name: "关闭上游详情" }).click();

  await sourceRow.getByRole("button", { name: "修改 E2E 目录上游" }).click();
  const editor = page.getByRole("dialog", { name: "编辑上游" });
  await expect(editor).toBeVisible();
  await expect(editor.getByText("transform(payload, $, context)")).toBeVisible();
  const editorSections = editor.locator("details > summary");
  await expect(editorSections.nth(0)).toHaveText("请求配置");
  await expect(editorSections.nth(1)).toHaveText("解析函数");
  await expect(editor.getByLabel("绑定适配器")).toHaveCount(0);
  await expect(editor.getByText("结果映射")).toHaveCount(0);
  await editor.getByRole("button", { name: "关闭配置" }).click();

  await sourceRow.getByRole("button", { name: "调试" }).click();
  const debug = page.locator(".debug-drawer");
  await expect(debug).toBeVisible();
  await expect(debug).toContainText("调试 E2E 目录上游");
  await debug.getByRole("button", { name: "关闭调试抽屉" }).click();

  await page.request.delete(`/api/plugins/${pluginId}`);
});

test("接口文档页面已下线，管理接口仍要求管理员身份", async ({ page }) => {
  expect((await page.request.get("/api")).status()).toBe(404);
  expect((await page.request.get("/api/settings/telegram")).status()).toBe(401);
  expect((await page.request.put("/api/settings/telegram", { data: { channels: [] } })).status()).toBe(401);
  expect((await page.request.put("/api/plugins/unknown/response", { data: {} })).status()).toBe(401);
});

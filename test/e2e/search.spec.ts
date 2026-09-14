import { expect, test } from "@playwright/test";
test.use({ reducedMotion: "reduce" });

function searchSse(payload: unknown): { contentType: string; body: string } {
  return {
    contentType: "text/event-stream; charset=utf-8",
    body: `event: complete\ndata: ${JSON.stringify(payload)}\n\n`,
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/tg/validate-channel", (route) => route.fulfill({
    json: { ok: true, channel: "ownchan", kind: "available", message: "ok", route: "telegram" },
  }));
});

test("本站搜索使用最小请求；自定义频道只搜索用户频道；开关、校验和移动布局", async ({ page }) => {
  const requests: any[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/hot-searches**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { enabled: false, locked: false } }));
  await page.route("**/api/search", async (route) => {
    requests.push(route.request().postDataJSON());
    expect(route.request().method()).toBe("POST");
    await route.fulfill(searchSse({ code: 0, message: "success", data: { total: 0, results: [] } }));
  });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "接口文档", exact: true })).toHaveCount(0);
  await page.getByLabel("搜索关键词").fill("三体");
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ kw: "三体" });
  await page.getByRole("button", { name: "开始搜索" }).waitFor();
  await page.getByRole("button", { name: /^自定义频道/ }).click();
  await expect(page.getByRole("button", { name: "开始搜索" })).toBeDisabled();
  const configurationNotice = page.locator(".search-workspace .channel-configuration-notice");
  await expect(configurationNotice).toBeInViewport();
  await expect(configurationNotice).toContainText("添加公开频道");
  await page.getByLabel("搜索关键词").press("Enter");
  await expect(page.locator(".error-alert")).toHaveCount(0);
  expect(requests.length).toBe(1);
  await page.locator(".channel-configuration-notice").getByRole("button", { name: "添加频道", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "自定义频道" });
  await drawer.getByLabel("频道用户名").fill("https://t.me/+invalid");
  await drawer.getByRole("button", { name: "添加频道", exact: true }).click();
  await expect(drawer.getByRole("alert")).toBeVisible();
  await drawer.getByLabel("频道用户名").fill("https://t.me/s/OwnChan/123?single");
  await drawer.getByRole("button", { name: "添加频道", exact: true }).click();
  await expect(drawer.getByText("@ownchan", { exact: false }).first()).toBeVisible();
  await drawer.getByLabel("频道用户名").fill("@OWNCHAN");
  await drawer.getByLabel("频道用户名").press("Enter");
  await expect(drawer.getByText("@ownchan 已在列表中，无需重复添加。")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "移除频道 ownchan" })).toHaveCount(1);
  await drawer.getByRole("button", { name: "关闭设置" }).click();
  await expect(configurationNotice).not.toBeVisible();
  await expect(page.getByRole("button", { name: "开始搜索" })).toBeEnabled();
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ kw: "三体", channels: ["ownchan"], channels_mode: "only" });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("panhub.settings") || "{}"))).toEqual({ userTgChannels: ["ownchan"] });
  await page.reload();
  await expect(page.getByRole("button", { name: "本站搜索", exact: true })).toHaveAttribute("aria-pressed", "true");
  // 本站搜索不展示、也不暗示会使用用户的自定义频道。
  await expect(page.getByLabel("已添加的自定义频道")).toHaveCount(0);
  await page.getByRole("button", { name: /^自定义频道/ }).click();
  await expect(page.getByLabel("已添加的自定义频道")).toContainText("@ownchan");
  await page.getByRole("button", { name: "本站搜索", exact: true }).click();
  await expect(page.getByLabel("已添加的自定义频道")).toHaveCount(0);
  await page.getByLabel("搜索关键词").fill("test");
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toEqual({ kw: "test" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: /^自定义频道/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByText("设置已保存", { exact: true })).not.toBeVisible();
  await page.screenshot({ path: ".tmp/search-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "管理频道", exact: true }).click();
  await expect(drawer.getByLabel("频道用户名")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".tmp/search-drawer-mobile.png", fullPage: false });
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole("button", { name: "管理频道", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: ".tmp/search-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "清空关键词" }).click();
  await page.getByLabel("搜索关键词").blur();
  await expect(page.getByText("搜索热度加载中…", { exact: true })).not.toBeVisible();
  await page.screenshot({ path: ".tmp/search-home-desktop.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".search-workspace")).toHaveCSS("background-color", "rgb(15, 18, 24)");
  await expect(page.locator(".topnav")).toHaveCSS("background-color", "rgb(15, 18, 24)");
  await page.screenshot({ path: ".tmp/search-home-dark.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("失败不是空结果；部分成功可见", async ({ page }) => {
  let call = 0;
  const requests: any[] = [];
  await page.route("**/api/hot-searches**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/search", async (route) => {
    requests.push(route.request().postDataJSON()); call++;
    if (call === 1) return route.fulfill({ status: 503, json: { statusMessage: "upstream unavailable" } });
    return route.fulfill(searchSse({ code: 0, warnings: [{ message: "partial failure" }], data: { total: 0, results: [] } }));
  });
  await page.goto("/");
  await page.getByLabel("搜索关键词").fill("test");
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect(page.getByText("upstream unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("未找到相关资源", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect(page.getByText(/部分来源未完成/)).toBeVisible();
});

test("暂停后继续使用原始搜索快照而不是修改后的设置", async ({ page }) => {
  const bodies: any[] = [];
  let finishFirst!: () => Promise<void>;
  await page.route("**/api/hot-searches**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/search", async (route) => {
    bodies.push(route.request().postDataJSON());
    const complete = () => route.fulfill(searchSse({ code: 0, data: { total: 0 } }));
    if (bodies.length === 1) { finishFirst = complete; return; }
    await complete();
  });
  await page.goto("/");
  await page.getByLabel("搜索关键词").fill("original");
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  await page.getByRole("button", { name: "暂停搜索" }).click();
  await page.getByLabel("搜索关键词").fill("changed");
  await page.getByRole("button", { name: "打开设置" }).click();
  const drawer = page.getByRole("dialog", { name: "自定义频道" });
  await drawer.getByLabel("频道用户名").fill("laterchan");
  await drawer.getByRole("button", { name: "添加频道", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "本站搜索", exact: true })).toHaveCount(0);
  await drawer.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("button", { name: "继续搜索" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual({ kw: "original" });
  await finishFirst().catch(() => {}); // Browser has already cancelled this request.
  await expect(page.getByRole("button", { name: "开始搜索" })).toBeVisible();
});

test("存储失败可见，个人频道仍保留在内存；切换页面不丢失；本站搜索不发送个人频道", async ({ page }) => {
  const requests: any[] = [];
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "panhub.settings") throw new DOMException("blocked", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.route("**/api/hot-searches**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/search", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill(searchSse({ code: 0, data: { total: 0, results: [] } }));
  });
  await page.goto("/");
  await page.locator(".manage-channels").click();
  const drawer = page.getByRole("dialog", { name: "自定义频道" });
  await drawer.getByLabel("频道用户名").fill("@OwnChan");
  await drawer.getByLabel("频道用户名").press("Enter");
  await expect(drawer.getByRole("alert")).toContainText("无法保存到浏览器");
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await page.getByRole("button", { name: "管理频道", exact: true }).click();
  await expect(drawer.getByText("@ownchan", { exact: false }).first()).toBeVisible();
  await drawer.getByRole("button", { name: "关闭设置" }).click();
  await page.getByLabel("搜索关键词").fill("test");
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ kw: "test" });
  await page.getByRole("button", { name: "管理频道", exact: true }).click();
  await drawer.getByRole("button", { name: "移除频道 ownchan" }).click();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ kw: "test" });
});


test("自定义频道空状态就近引导；删除最后一个频道禁用，切回本站可搜索", async ({ page }) => {
  const requests: any[] = [];
  await page.route("**/api/hot-searches**", (route) => route.fulfill({ json: { code: 0, data: { hotSearches: [{ term: "三体", score: 1 }] } } }));
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { enabled: false, locked: false } }));
  await page.route("**/api/search", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill(searchSse({ code: 0, data: { total: 0, results: [] } }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^自定义频道/ }).click();
  const search = page.getByRole("button", { name: "开始搜索" });
  const notice = page.locator(".channel-configuration-notice");
  await page.getByLabel("搜索关键词").fill("test");
  await expect(search).toBeDisabled();
  await expect(search).toHaveAttribute("aria-describedby", "channel-configuration-hint");
  await expect(notice).toBeInViewport();
  await page.screenshot({ path: ".tmp/search-empty-channels-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice).toBeInViewport({ ratio: 1 });
  await expect(notice.getByRole("button", { name: "添加频道", exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".tmp/search-empty-channels-mobile.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(search).toHaveCSS("color", "rgb(107, 114, 128)");
  await page.screenshot({ path: ".tmp/search-empty-channels-dark.png" });
  await page.getByLabel("搜索关键词").fill("三体");
  await page.getByLabel("搜索关键词").press("Enter");
  await expect(page.locator(".error-alert")).toHaveCount(0);
  expect(requests).toHaveLength(0);
  await page.locator(".channel-configuration-notice").getByRole("button", { name: "添加频道", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "自定义频道" });
  await drawer.getByLabel("频道用户名").fill("ownchan");
  await drawer.getByRole("button", { name: "添加频道", exact: true }).click();
  await drawer.getByRole("button", { name: "关闭设置" }).click();
  await expect(search).toBeEnabled();
  await expect(notice).not.toBeVisible();
  await page.getByRole("button", { name: "管理频道", exact: true }).click();
  await drawer.getByRole("button", { name: "移除频道 ownchan" }).click();
  await drawer.getByRole("button", { name: "关闭设置" }).click();
  await expect(search).toBeDisabled();
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "本站搜索", exact: true }).click();
  await expect(search).toBeEnabled();
  await expect(notice).not.toBeVisible();
  await search.click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ kw: "三体" });
});

test("个人搜索暂停后移除最后一个频道，仍可按原始快照继续", async ({ page }) => {
  const bodies: any[] = [];
  let finishFirst!: () => Promise<void>;
  await page.addInitScript(() => localStorage.setItem("panhub.settings", JSON.stringify({ userTgChannels: ["ownchan"] })));
  await page.route("**/api/hot-searches**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { enabled: false, locked: false } }));
  await page.route("**/api/search", async (route) => {
    bodies.push(route.request().postDataJSON());
    const complete = () => route.fulfill(searchSse({ code: 0, data: { total: 0 } }));
    if (bodies.length === 1) { finishFirst = complete; return; }
    await complete();
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^自定义频道/ }).click();
  await page.getByLabel("搜索关键词").fill("original");
  await page.getByRole("button", { name: "开始搜索" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  await page.getByRole("button", { name: "暂停搜索" }).click();
  await page.getByRole("button", { name: "管理频道", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "自定义频道" });
  await drawer.getByRole("button", { name: "移除频道 ownchan" }).click();
  await drawer.getByRole("button", { name: "关闭设置" }).click();
  await expect(page.locator(".channel-configuration-notice")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "继续搜索" })).toBeEnabled();
  await page.getByRole("button", { name: "继续搜索" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual({ kw: "original", channels: ["ownchan"], channels_mode: "only" });
  await finishFirst().catch(() => {});
  await expect(page.getByRole("button", { name: "开始搜索" })).toBeDisabled();
  await expect(page.locator(".channel-configuration-notice")).toBeVisible();
});

test("SSE 未结束时页面已经展示增量结果", async ({ page }) => {
  await page.route("**/api/hot-searches**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { enabled: false, locked: false } }));
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/api/search")) return nativeFetch(input, init);

      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: start\ndata: {\"code\":0,\"message\":\"started\",\"data\":{\"intervalMs\":300}}\n\n"));
          controller.enqueue(encoder.encode(`event: result\ndata: ${JSON.stringify({
            code: 0,
            message: "source_success",
            data: {
              update: {
                source: { kind: "plugin", id: "stream-test", version: "1.0.0" },
                request: { keyword: "stream", phase: "variant" },
                results: [{
                  message_id: "stream-1",
                  unique_id: "stream-1",
                  channel: "",
                  datetime: "2026-09-14T00:00:00.000Z",
                  title: "流中结果",
                  content: "",
                  links: [{ type: "quark", url: "https://example.com/stream", password: "" }],
                  source: "plugin",
                  pluginId: "stream-test",
                  pluginVersion: "1.0.0",
                }],
              },
            },
          })}\n\n`));
          (window as any).__finishSearch = () => {
            controller.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify({
              code: 0,
              message: "success",
              data: { total: 1, meta: { registryVersion: 1, pluginVersions: { "stream-test": "1.0.0" } } },
            })}\n\n`));
            controller.close();
          };
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    };
  });

  await page.goto("/");
  await page.getByLabel("搜索关键词").fill("stream");
  await page.getByRole("button", { name: "开始搜索" }).click();

  await expect(page.getByRole("link", { name: "流中结果" })).toBeVisible();
  await expect(page.getByRole("button", { name: "暂停搜索" })).toBeVisible();
  await expect(page.locator(".stat-value").first()).toHaveText("1");
  await page.evaluate(() => (window as any).__finishSearch());
  await expect(page.getByRole("button", { name: "开始搜索" })).toBeVisible();
  await expect(page.getByRole("link", { name: "流中结果" })).toHaveCount(1);
});

import { expect, test, type Page } from "@playwright/test";
test.use({ reducedMotion: "reduce" });

function report(channel: string, keyword: string) {
  const upstreamUrl = new URL(`https://t.me/s/${channel}`);
  upstreamUrl.searchParams.set("q", keyword);
  const request = { method: "GET", url: upstreamUrl.toString(), headers: { accept: "text/html" } };
  const failed = { status: 503, headers: { "content-type": "text/plain" }, body: "direct unavailable", bodyLength: 18, bodyTruncated: false };
  const body = '<div class="tgme_widget_message">sample raw</div><script>window.__tgScriptExecuted = true</script>';
  const response = { status: 200, headers: { "content-type": "text/html" }, body, bodyLength: 90000, bodyTruncated: true };
  return {
    channel, keyword, state: "available", message: "解析到 1 条结果", elapsedMs: 123, checkedAt: "2026-09-12T08:00:00Z", route: "jina", httpStatus: 200,
    results: [{ unique_id: `${channel}-1`, title: `${channel} result`, channel, links: [{ type: "quark", url: "https://pan.quark.cn/s/example" }] }],
    attempts: [
      { route: "telegram", request, response: failed, elapsedMs: 50, error: "direct unavailable" },
      { route: "jina", request: { ...request, url: `https://r.jina.ai/${request.url}` }, response, elapsedMs: 73 },
    ],
    upstreamRequest: request, upstreamResponse: response,
  };
}
async function enter(page: Page) {
  await page.route("**/api/settings/telegram", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      return route.fulfill({ json: { data: { channels: body.channels, defaultChannels: ["defaultchan"], effectiveChannels: body.channels ?? ["defaultchan"] } } });
    }
    return route.fulfill({ json: { data: { channels: ["firstchan", "secondchan"], defaultChannels: ["defaultchan"], effectiveChannels: ["firstchan", "secondchan"] } } });
  });
  await page.goto("/admin?view=telegram");
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "进入管理控制台" }).click();
  await expect(page.getByRole("button", { name: "调试报文 firstchan" })).toBeVisible();
}

test("本页报文抽屉保留未保存配置，展示真实参数快照及各次原始报文", async ({ page }) => {
  const bodies: any[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/tg/probe", route => {
    const body = route.request().postDataJSON(); bodies.push(body);
    return route.fulfill({ json: report(body.channel, body.keyword) });
  });
  await enter(page);
  const manager = page.getByRole("region", { name: "TG 频道管理" });
  await manager.getByLabel("新增公开频道").fill("unsavedchan");
  await manager.getByRole("button", { name: "添加频道", exact: true }).click();
  await expect(manager.getByText("@unsavedchan 已添加并保存，下一次本站搜索生效。")).toBeVisible();
  await manager.getByRole("button", { name: "调试报文 firstchan" }).click();
  const drawer = page.getByRole("dialog", { name: "调试报文 · @firstchan" });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/\/admin\?view=telegram$/);
  expect(bodies).toEqual([]); // Merely inspecting must not make a new upstream request.
  await drawer.getByLabel("调试关键词", { exact: true }).fill("  新关键词  ");
  await drawer.getByLabel("最多结果", { exact: true }).selectOption("50");
  await drawer.getByRole("button", { name: "发送调试请求" }).click();
  await expect(drawer.getByLabel("频道调试结果")).toContainText("123 ms");
  expect(bodies).toEqual([{ channel: "firstchan", keyword: "新关键词", limit: 50 }]);
  await drawer.getByLabel("调试关键词", { exact: true }).fill("尚未发送");
  await expect(drawer.getByLabel("接口入参报文")).toContainText('"keyword": "新关键词"');
  await expect(drawer.getByLabel("接口入参报文")).not.toContainText("尚未发送");
  await drawer.getByRole("button", { name: "接口出参", exact: true }).click();
  await expect(drawer.getByLabel("接口出参报文")).toContainText('"channel": "firstchan"');
  await drawer.getByRole("button", { name: "原始报文", exact: true }).click();
  await expect(drawer.getByLabel("格式化后的上游正文")).toContainText("direct unavailable");
  await drawer.getByLabel("上游请求", { exact: true }).selectOption("1");
  await expect(drawer.getByLabel("上游原始请求")).toContainText("https://r.jina.ai/https://t.me/s/firstchan?q=%E6%96%B0%E5%85%B3%E9%94%AE%E8%AF%8D");
  await expect(drawer.getByLabel("格式化后的上游正文")).toContainText("<script>");
  await expect(drawer.getByText(/已截断，不是完整报文/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__tgScriptExecuted)).toBeUndefined();
  await page.screenshot({ path: ".tmp/tg-debug-drawer-desktop.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await drawer.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: ".tmp/tg-debug-drawer-mobile.png", fullPage: false });
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(manager.getByRole("button", { name: "调试报文 firstchan" })).toBeFocused();
  await expect(manager.getByText("@unsavedchan", { exact: true })).toBeVisible();
  await manager.getByRole("button", { name: "调试报文 firstchan" }).click();
  await expect(drawer.getByLabel("频道调试结果")).toContainText("123 ms");
  expect(bodies.length).toBe(1);
  expect(errors).toEqual([]);
});

test("原始正文支持文本/HTML 渲染切换，并可沙箱方式在新标签页打开", async ({ page }) => {
  await page.route("**/api/tg/probe", route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: report(body.channel, body.keyword) });
  });
  await enter(page);
  await page.getByRole("button", { name: "调试报文 firstchan" }).click();
  const drawer = page.getByRole("dialog", { name: "调试报文 · @firstchan" });
  await drawer.getByRole("button", { name: "发送调试请求" }).click();
  await expect(drawer.getByLabel("频道调试结果")).toContainText("123 ms");
  await drawer.getByRole("button", { name: "原始报文", exact: true }).click();
  await expect(drawer.getByLabel("格式化后的上游正文")).toContainText("direct unavailable");
  await drawer.getByLabel("上游请求", { exact: true }).selectOption("1");
  await expect(drawer.getByLabel("格式化后的上游正文")).toContainText("sample raw");
  await expect(drawer.getByRole("button", { name: "新标签打开" })).toBeEnabled();

  await drawer.getByRole("button", { name: "页面渲染" }).click();
  const htmlFrame = drawer.locator("iframe.tg-raw-frame");
  await expect(htmlFrame).toHaveAttribute("sandbox", "");
  await expect(page.frameLocator("iframe.tg-raw-frame").locator(".tgme_widget_message")).toHaveText("sample raw");
  expect(await page.evaluate(() => (window as any).__tgScriptExecuted)).toBeUndefined();

  await drawer.getByRole("button", { name: "源码视图" }).click();
  await expect(drawer.getByLabel("上游正文源码")).toContainText("sample raw");
});

test("新标签打开不依赖调试请求，直接以镜像前缀在浏览器打开频道", async ({ page }) => {
  await page.context().route("https://r.jina.ai/**", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<html><body><p>mirrored page</p></body></html>" }));
  await enter(page);
  await page.getByRole("button", { name: "调试报文 firstchan" }).click();
  const drawer = page.getByRole("dialog", { name: "调试报文 · @firstchan" });
  await expect(drawer).toBeVisible();
  const openButton = drawer.getByRole("button", { name: "新标签打开" });
  await expect(openButton).toBeEnabled(); // 尚未发送调试请求也可用
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    openButton.click(),
  ]);
  await expect(popup).toHaveURL("https://r.jina.ai/https://t.me/s/firstchan?q=%E4%B8%89%E4%BD%93");
  await expect(popup.getByText("mirrored page")).toBeVisible();
  await popup.close();
});
test("列表检测报文复用；关闭期间的响应不串频道，失败不展示旧结果", async ({ page }) => {
  let calls = 0;
  let completePending!: () => Promise<void>;
  await page.route("**/api/tg/probe", route => {
    const body = route.request().postDataJSON(); calls++;
    if (calls === 2) { completePending = () => route.fulfill({ json: report(body.channel, body.keyword) }); return; }
    if (calls === 3) return route.fulfill({ status: 503, json: { statusMessage: "probe unavailable" } });
    return route.fulfill({ json: report(body.channel, body.keyword) });
  });
  await enter(page);
  await page.getByRole("button", { name: "检测 firstchan", exact: true }).click();
  await expect(page.getByText("可提取结果 · 123 ms · 1 条", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "调试报文 firstchan" }).click();
  const first = page.getByRole("dialog", { name: "调试报文 · @firstchan" });
  await expect(first.getByLabel("频道调试结果")).toBeVisible();
  expect(calls).toBe(1);
  await first.getByLabel("调试关键词", { exact: true }).fill("pending");
  await first.getByRole("button", { name: "发送调试请求" }).click();
  await expect.poll(() => calls).toBe(2);
  await expect(first.getByLabel("频道调试结果")).toHaveCount(0);
  await first.getByRole("button", { name: "关闭频道调试" }).click();
  await page.getByRole("button", { name: "调试报文 secondchan" }).click();
  const second = page.getByRole("dialog", { name: "调试报文 · @secondchan" });
  await expect(second.getByRole("button", { name: "发送调试请求" })).toBeDisabled();
  await completePending();
  await expect(second.getByRole("button", { name: "发送调试请求" })).toBeEnabled();
  await expect(second.getByLabel("频道调试结果")).toHaveCount(0);
  await second.getByRole("button", { name: "关闭频道调试" }).click();
  await page.getByRole("button", { name: "调试报文 firstchan" }).click();
  await expect(first.getByLabel("频道调试结果")).toContainText("pending");
  await first.getByRole("button", { name: "发送调试请求" }).click();
  await expect(first.getByRole("alert")).toContainText("probe unavailable");
  await first.getByRole("button", { name: "接口出参", exact: true }).click();
  await expect(first.getByText("本次请求失败，未取得诊断结果。")).toBeVisible();
  await expect(first.getByLabel("接口出参报文")).toHaveCount(0);
  expect(calls).toBe(3);
});

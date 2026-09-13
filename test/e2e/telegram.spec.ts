import { expect, test } from "@playwright/test";

test("Telegram 诊断页使用独立管理员门禁并可退出", async ({ page }) => {
  await page.goto("/telegram");
  await expect(
    page.getByRole("heading", { name: "Telegram 管理员验证" }),
  ).toBeVisible();
  await expect(page.getByText("已配置频道")).toHaveCount(0);
  await expect(page.getByLabel("管理员密码")).toBeEnabled();

  const anonymousProbe = await page.request.post("/api/tg/probe", {
    data: { channel: "tgsearchers3", keyword: "三体", limit: 10 },
  });
  expect(anonymousProbe.status()).toBe(401);

  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "进入管理控制台" }).click();
  await expect(
    page.getByRole("heading", { name: "Telegram 频道测试" }),
  ).toBeVisible();
  await expect(page.getByText("已配置频道", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "退出管理" }).click();
  await expect(
    page.getByRole("heading", { name: "Telegram 管理员验证" }),
  ).toBeVisible();
});

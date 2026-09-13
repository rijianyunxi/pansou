import { expect, test } from "@playwright/test";

test("Telegram 管理台移动端无横向溢出且关键操作可触控", async ({ page }) => {
  await page.goto("/telegram");
  await expect(page.getByLabel("管理员密码")).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();

  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "进入管理控制台" }).click();
  await expect(
    page.getByRole("heading", { name: "Telegram 频道测试" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();

  const logout = page.getByRole("button", { name: "退出管理" });
  const box = await logout.boundingBox();
  expect(box?.height || 0).toBeGreaterThanOrEqual(44);
});

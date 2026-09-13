import { expect, test } from "@playwright/test";

test("移动端登录门禁和管理工作台无横向溢出", async ({ page }) => {
  await page.goto("/admin?view=sources");
  await expect(
    page.getByRole("heading", { name: "管理员身份验证" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();

  await expect(page.getByLabel("管理员密码")).toBeEnabled();
  await page.getByLabel("管理员密码").fill("e2e-admin-password");
  await page.getByRole("button", { name: "进入管理控制台" }).click();
  await expect(page.getByRole("heading", { name: /上游接口/ })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();

  await expect(page.getByRole("button", { name: /垃圾箱/ })).toBeVisible();
  const createButton = page.getByRole("button", { name: "新增上游" });
  const box = await createButton.boundingBox();
  expect(box?.height || 0).toBeGreaterThanOrEqual(44);
});

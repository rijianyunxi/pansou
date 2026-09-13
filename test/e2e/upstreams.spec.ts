import { expect, test, type Page } from "@playwright/test";

const password = "e2e-admin-password";
const pluginId = "e2e-lifecycle-source";

async function unlock(page: Page) {
  await page.goto("/admin?view=sources");
  await expect(
    page.getByRole("heading", { name: "管理员身份验证" }),
  ).toBeVisible();
  await expect(page.getByLabel("管理员密码")).toBeEnabled();
  await page.getByLabel("管理员密码").fill(password);
  await page.getByRole("button", { name: "进入管理控制台" }).click();
  await expect(page.getByRole("heading", { name: /上游接口/ })).toBeVisible();
}

function definition() {
  return {
    schemaVersion: 1,
    manifest: {
      id: pluginId,
      name: "E2E 生命周期上游",
      version: "1.0.0",
      kind: "instructions",
      priority: 50,
      timeoutMs: 3000,
      maxResults: 20,
      schemaVersion: 1,
      outputTypes: [],
    },
    request: {
      method: "GET",
      url: "https://example.com/search",
      allowedDomains: ["example.com"],
      query: { keyword: "{{keyword}}" },
    },
    response: {
      format: "json",
      items: "items",
      fields: { title: "title" },
      links: { url: "url" },
    },
  };
}

test("未认证时隔离管理界面，登录和退出形成完整会话", async ({ page }) => {
  await page.goto("/admin?view=sources");

  await expect(
    page.getByRole("heading", { name: "管理员身份验证" }),
  ).toBeVisible();
  await expect(page.getByLabel("管理员密码")).toBeEnabled();
  await expect(page.getByRole("button", { name: "新增上游" })).toHaveCount(0);

  await page.getByLabel("管理员密码").fill("wrong-password");
  await page.getByRole("button", { name: "进入管理控制台" }).click();
  await expect(page.getByRole("alert")).toContainText("管理员密码错误");

  await page.getByLabel("管理员密码").fill(password);
  await page.getByRole("button", { name: "进入管理控制台" }).click();
  await expect(page.getByRole("heading", { name: /上游接口/ })).toBeVisible();

  await page.getByRole("button", { name: "退出管理" }).click();
  await expect(
    page.getByRole("heading", { name: "管理员身份验证" }),
  ).toBeVisible();
  const protectedResponse = await page.request.get("/api/plugins");
  expect(protectedResponse.status()).toBe(401);
});

test("自定义上游支持归档、恢复和带 ID 确认的永久删除", async ({ page }) => {
  await unlock(page);

  const createResponse = await page.request.post("/api/plugins", {
    data: { definition: definition(), actor: "playwright" },
  });
  expect(createResponse.ok()).toBeTruthy();
  await page.reload();

  const sourceRow = page.getByRole("row", { name: /E2E 生命周期上游/ });
  await expect(sourceRow).toBeVisible();
  await sourceRow.getByRole("button", { name: "详情" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除上游" }).click();
  await expect(
    page.getByRole("heading", { name: "删除此上游？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(sourceRow).toHaveCount(0);

  await page.getByRole("button", { name: /垃圾箱/ }).click();
  const archivedItem = page.getByRole("listitem").filter({
    hasText: "E2E 生命周期上游",
  });
  await expect(archivedItem).toBeVisible();
  await archivedItem.getByRole("button", { name: "恢复" }).click();
  await expect(sourceRow).toBeVisible();
  await page.locator(".detail-drawer").getByRole("button", { name: "关闭上游详情" }).click();

  await sourceRow.getByRole("button", { name: "详情" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除上游" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await page.getByRole("button", { name: /垃圾箱/ }).click();

  const purgeItem = page.getByRole("listitem").filter({
    hasText: "E2E 生命周期上游",
  });
  await purgeItem.getByRole("button", { name: "永久删除" }).click();
  const destructiveButton = page
    .getByRole("alertdialog")
    .getByRole("button", { name: "永久删除" });
  await expect(destructiveButton).toBeDisabled();
  await page.locator("#purge-confirmation").fill(pluginId);
  await expect(destructiveButton).toBeEnabled();
  await destructiveButton.click();
  await expect(purgeItem).toHaveCount(0);

  const deletedResponse = await page.request.get(`/api/plugins/${pluginId}`);
  expect(deletedResponse.status()).toBe(404);
});

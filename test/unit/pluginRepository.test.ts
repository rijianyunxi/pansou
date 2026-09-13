import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonPluginRepository,
  resolvePublishedDefinition,
} from "../../server/core/plugins/repository";
import type { InstructionPluginDefinition } from "../../server/core/instructions/types";

const definition = (
  version: string,
  url = "https://example.com/search"
): InstructionPluginDefinition => ({
  schemaVersion: 1,
  manifest: {
    id: "repo-fixture",
    name: "Repo fixture",
    version,
    kind: "instructions",
    priority: 1,
    timeoutMs: 1000,
    maxResults: 10,
    schemaVersion: 1,
    outputTypes: [],
  },
  request: { method: "GET", url },
  response: {
    format: "json",
    items: "items",
    fields: { title: "title" },
    links: { url: "url" },
  },
});

describe("JsonPluginRepository", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("requires sample validation before publish and supports disable/rollback", async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-repository-"));
    const repo = new JsonPluginRepository(join(dir, "plugins.json"));
    await repo.saveDraft(definition("1.0.0"), "alice", "initial");
    await expect(repo.publish("repo-fixture", "alice")).rejects.toThrow(
      "样本解析验证"
    );
    await expect(repo.validate("repo-fixture", "alice")).rejects.toThrow(
      "样本解析测试"
    );
    await repo.validate("repo-fixture", "alice", {
      sampleParsed: true,
      sampleResultCount: 2,
    });
    await repo.publish("repo-fixture", "alice");
    await repo.saveDraft(definition("2.0.0"), "bob", "change");
    const record = await repo.get("repo-fixture");
    expect(record?.status).toBe("draft");
    expect(record?.publishedVersion).toBe("1.0.0");
    expect(record?.versions).toHaveLength(2);
    expect(resolvePublishedDefinition(record!)?.manifest.version).toBe("1.0.0");

    await repo.validate("repo-fixture", "bob", { sampleParsed: true });
    await repo.publish("repo-fixture", "bob");
    await repo.rollback("repo-fixture", "1.0.0", "alice");
    expect((await repo.get("repo-fixture"))?.publishedVersion).toBe("1.0.0");
    await repo.disable("repo-fixture");
    const disabled = await repo.get("repo-fixture");
    expect(disabled?.status).toBe("disabled");
    expect(resolvePublishedDefinition(disabled!)).toBeUndefined();
    await repo.audit("repo-fixture", "debugged", "carol", {
      resultCount: 3,
    });
    const reloaded = new JsonPluginRepository(join(dir, "plugins.json"));
    const persisted = await reloaded.get("repo-fixture");
    expect(persisted?.versions).toHaveLength(2);
    expect(persisted?.auditTrail.map((entry) => entry.action)).toEqual([
      "draft_saved",
      "validation_failed",
      "validated",
      "published",
      "draft_saved",
      "validated",
      "published",
      "rolled_back",
      "disabled",
      "debugged",
    ]);
    expect(persisted?.auditTrail.at(-1)).toMatchObject({
      actor: "carol",
      metadata: { resultCount: 3 },
    });
  });

  it("does not allow an existing immutable version to be overwritten", async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-repository-"));
    const repo = new JsonPluginRepository(join(dir, "plugins.json"));
    await repo.saveDraft(definition("1.0.0"));

    await expect(
      repo.saveDraft(definition("1.0.0", "https://example.org/changed"))
    ).rejects.toThrow("不可修改");
  });

  it("only permanently deletes archived plugins", async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-repository-"));
    const repo = new JsonPluginRepository(join(dir, "plugins.json"));
    await repo.saveDraft(definition("1.0.0"));

    await expect(repo.purge("repo-fixture", "admin")).rejects.toThrow(
      "永久删除前必须先归档"
    );
    await repo.archive("repo-fixture", "admin");
    await repo.purge("repo-fixture", "admin");

    expect(await repo.get("repo-fixture")).toBeUndefined();
    expect(await repo.list({ includeArchived: true })).toEqual([]);
  });

  it("restores archived plugins without enabling them", async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-repository-"));
    const repo = new JsonPluginRepository(join(dir, "plugins.json"));
    await repo.saveDraft(definition("1.0.0"));
    await repo.validate("repo-fixture", "system", { sampleParsed: true });
    await repo.publish("repo-fixture");
    await repo.archive("repo-fixture");

    const restored = await repo.restore("repo-fixture");
    expect(restored.status).toBe("disabled");
    expect(restored.publishedVersion).toBe("1.0.0");
  });

  it("re-enables a disabled published plugin and audits the action", async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-repository-"));
    const repo = new JsonPluginRepository(join(dir, "plugins.json"));
    await repo.saveDraft(definition("1.0.0"));
    await repo.validate("repo-fixture", "system", { sampleParsed: true });
    await repo.publish("repo-fixture");
    await repo.disable("repo-fixture");

    const enabled = await repo.enable("repo-fixture", "admin");
    expect(enabled.status).toBe("published");
    expect(enabled.publishedVersion).toBe("1.0.0");
    expect(resolvePublishedDefinition(enabled)?.manifest.version).toBe("1.0.0");
    expect(enabled.auditTrail.at(-1)).toMatchObject({
      action: "enabled",
      actor: "admin",
      metadata: { version: "1.0.0" },
    });

    // enable 后重新落盘可恢复（新实例读取到 enabled 状态）
    const reloaded = new JsonPluginRepository(join(dir, "plugins.json"));
    expect((await reloaded.get("repo-fixture"))?.status).toBe("published");
  });

  it("refuses to enable a plugin that was never published", async () => {
    dir = await mkdtemp(join(tmpdir(), "panhub-repository-"));
    const repo = new JsonPluginRepository(join(dir, "plugins.json"));
    await repo.saveDraft(definition("1.0.0"));

    await expect(repo.enable("repo-fixture")).rejects.toThrow("从未发布");
  });
});

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonPluginSecretStore } from "../../server/core/plugins/secretStore";

async function tempStore(): Promise<{ store: JsonPluginSecretStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "panhub-secrets-"));
  const path = join(dir, "plugin-secrets.json");
  return { store: new JsonPluginSecretStore(path), path };
}

describe("JsonPluginSecretStore", () => {
  it("round-trips values per plugin and persists them outside the definition", async () => {
    const { store, path } = await tempStore();
    await store.set("plugin-a", "apiKey", "sk-abc");
    await store.set("plugin-a", "token", "tkn-1");

    expect(await store.list("plugin-a")).toEqual(["apiKey", "token"]);
    expect(await store.get("plugin-a", "apiKey")).toBe("sk-abc");
    expect(await store.get("plugin-b", "apiKey")).toBeNull();
    expect(await store.getMany("plugin-a", ["apiKey", "token", "missing"])).toEqual({
      apiKey: "sk-abc",
      token: "tkn-1",
    });

    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.secrets["plugin-a"].apiKey).toBe("sk-abc");
  });

  it("deletes without touching other plugins or names", async () => {
    const { store } = await tempStore();
    await store.set("a", "k", "v1");
    await store.set("b", "k", "v2");
    await store.delete("a", "k");

    expect(await store.get("a", "k")).toBeNull();
    expect(await store.get("b", "k")).toBe("v2");
    expect(await store.list("a")).toEqual([]);
  });
});

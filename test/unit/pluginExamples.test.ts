import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateInstructionDefinition } from "../../server/core/instructions/validator";

// examples/plugins/ 下的示例定义是 M10 文档任务的一部分：本测试用与
// 生产一致的 validator 逐个校验，保证文档示例始终符合真实 schema。
const examplesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "plugins"
);

const exampleFiles = readdirSync(examplesDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

describe("examples/plugins instruction definitions", () => {
  it("provides the three documented examples", () => {
    expect(exampleFiles).toEqual(["html-selector.json", "json-basic.json", "multi-stage.json"]);
  });

  for (const file of exampleFiles) {
    it(`passes validateInstructionDefinition: ${file}`, () => {
      const raw = JSON.parse(readFileSync(join(examplesDir, file), "utf8"));
      const definition = validateInstructionDefinition(raw);

      expect(definition.schemaVersion).toBe(1);
      expect(definition.manifest.kind).toBe("instructions");
      expect(definition.manifest.id).toBeTruthy();
      expect(definition.manifest.version).toBeTruthy();
      expect(definition.request.url.startsWith("https://")).toBe(true);
      expect(definition.response.fields.title).toBeTruthy();
      expect(definition.response.links.url).toBeTruthy();
    });
  }

  it("multi-stage example only stages the main request host", () => {
    const raw = JSON.parse(readFileSync(join(examplesDir, "multi-stage.json"), "utf8"));
    const definition = validateInstructionDefinition(raw);
    const mainHost = new URL(definition.request.url).hostname;
    for (const stage of definition.request.stages ?? []) {
      expect(new URL(stage.url).hostname).toBe(mainHost);
    }
    // 密钥只允许出现在请求头/请求体，不允许进入 URL 或 query。
    expect(JSON.stringify(definition.request.query)).not.toContain("secret.");
    expect(definition.request.url).not.toContain("secret.");
  });
});

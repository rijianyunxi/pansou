import { describe, expect, it } from "vitest";
import { buildTgSourceUrl } from "../../utils/tgSourceUrl";

describe("browser TG source URL builder", () => {
  it("uses the configured route template and preserves query parameters", () => {
    expect(buildTgSourceUrl("jina", "@Demo_Channel", "三体", "123", {
      jinaTemplate: "https://reader.example.com/telegram/{{channel}}",
    })).toBe("https://reader.example.com/telegram/Demo_Channel?q=%E4%B8%89%E4%BD%93&before=123");
  });

  it("matches the default direct and mirror URLs", () => {
    expect(buildTgSourceUrl("direct", "channel", "hello")).toBe(
      "https://t.me/s/channel?q=hello",
    );
    expect(buildTgSourceUrl("jina", "channel", "hello")).toBe(
      "https://r.jina.ai/https://t.me/s/channel?q=hello",
    );
  });
});

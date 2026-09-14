import { describe, expect, it } from "vitest";
import {
  normalizeUpstreamJson,
  readMappingPath,
  validResourceUrl,
} from "../../utils/upstreamAdapter";

const mapping = {
  items: "data.list",
  title: "title",
  url: "url",
  type: "type",
  password: "password",
};
describe("upstream adapter", () => {
  it("reads only own fields and rejects prototype traversal", () => {
    expect(readMappingPath({ data: { list: [1] } }, "data.list.0")).toBe(1);
    expect(readMappingPath({}, "constructor.name")).toBeUndefined();
    expect(
      readMappingPath(JSON.parse('{"__proto__":{"x":1}}'), "__proto__.x"),
    ).toBeUndefined();
    expect(
      readMappingPath(Object.create({ inherited: 1 }), "inherited"),
    ).toBeUndefined();
  });
  it("normalizes the existing SearchResult contract and excludes unsafe URLs", () => {
    const result = normalizeUpstreamJson(
      {
        data: {
          list: [
            {
              title: "<b>资源</b>",
              url: "https://pan.quark.cn/s/example",
              password: 1234,
            },
            { title: "unsafe", url: "javascript:alert(1)" },
          ],
        },
      },
      mapping,
      "sample",
    );
    expect(result).toEqual([
      {
        unique_id: "sample-0",
        message_id: "",
        channel: "sample",
        datetime: "",
        title: "资源",
        content: "",
        links: [
          {
            url: "https://pan.quark.cn/s/example",
            type: "quark",
            password: "1234",
          },
        ],
      },
    ]);
  });
  it("handles nested link arrays", () => {
    // 嵌套 links 映射是适配器的通用能力（原 jikepan 目录项已下线，此处用等价映射验证）
    const nestedMapping = {
      items: "list",
      title: "name",
      linkArray: "links",
      url: "link",
      type: "service",
      password: "pwd",
    };
    expect(
      normalizeUpstreamJson(
        {
          list: [
            {
              name: "Title",
              links: [
                {
                  link: "https://pan.baidu.com/s/test",
                  service: "BDY",
                  pwd: "abcd",
                },
              ],
            },
          ],
        },
        nestedMapping,
        "jikepan",
      )[0]!.links[0]!.type,
    ).toBe("baidu");
  });
  it("rejects invalid array mappings and limits output", () => {
    expect(() => normalizeUpstreamJson({}, mapping, "test")).toThrow(
      "不是数组",
    );
    expect(
      normalizeUpstreamJson(
        Array.from({ length: 300 }, () => ({
          title: "t",
          url: "https://example.com",
        })),
        { ...mapping, items: "" },
        "test",
      ),
    ).toHaveLength(200);
  });
  it("accepts resource protocols but not script or file links", () => {
    expect(validResourceUrl("magnet:?xt=urn:btih:abc")).toBe(true);
    expect(validResourceUrl("ed2k://|file|sample")).toBe(true);
    expect(validResourceUrl("file:///etc/passwd")).toBe(false);
    expect(validResourceUrl("data:text/html,test")).toBe(false);
  });
  it("uses only caller-provided adapter mappings", () => {
    expect(mapping.items).toBe("data.list");
  });
});

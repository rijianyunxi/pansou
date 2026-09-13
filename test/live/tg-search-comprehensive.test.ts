import { describe, it, expect } from "vitest";
import { fetchTgChannelPosts } from "../../server/core/services/tg";

describe("TG 综合搜索测试", () => {
  it("搜索更多消息查看是否有千与千寻", async () => {
    const results = await fetchTgChannelPosts("Quark_Movies", "千与千寻", {
      limitPerChannel: 100,
    });

    console.log(`搜索"千与千寻"结果数量: ${results.length}`);
    if (results.length > 0) {
      results.forEach((r, i) => {
        console.log(`${i + 1}. ${r.title}`);
      });
    } else {
      console.log("未找到结果");
    }

    expect(results.length).toBeGreaterThan(0);
  }, 60000);

  it("搜索肖申克的救赎（更多消息）", async () => {
    const results = await fetchTgChannelPosts("Quark_Movies", "肖申克", {
      limitPerChannel: 100,
    });

    console.log(`搜索"肖申克"结果数量: ${results.length}`);
    if (results.length > 0) {
      results.forEach((r, i) => {
        console.log(`${i + 1}. ${r.title}`);
      });
    } else {
      console.log("未找到结果");
    }

    expect(results.length).toBeGreaterThan(0);
  }, 60000);

  it("搜索泰坦尼克（更多消息）", async () => {
    const results = await fetchTgChannelPosts("Quark_Movies", "泰坦尼克", {
      limitPerChannel: 100,
    });

    console.log(`搜索"泰坦尼克"结果数量: ${results.length}`);
    if (results.length > 0) {
      results.forEach((r, i) => {
        console.log(`${i + 1}. ${r.title}`);
      });
    } else {
      console.log("未找到结果");
    }

    expect(results.length).toBeGreaterThan(0);
  }, 60000);

});

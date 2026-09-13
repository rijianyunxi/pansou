import { describe, expect, it } from "vitest";
import { parseSystemChannels, telegramSettingsView } from "../../server/utils/telegramSettings";
import { resolveSearchDefaults } from "../../server/utils/searchDefaults";
const settings = { channels: null, plugins: null, concurrency: null, pluginTimeoutMs: null, trashedPlugins: [] };
describe("system Telegram configuration", () => {
  it("distinguishes default, disabled and a custom list", () => {
    expect(parseSystemChannels(null)).toBeNull();
    expect(telegramSettingsView(null, ["@SysChan"]).effectiveChannels).toEqual(["syschan"]);
    expect(telegramSettingsView([], ["syschan"]).effectiveChannels).toEqual([]);
    expect(parseSystemChannels(["@OwnChan", "ownchan"])).toEqual(["ownchan"]);
  });
  it.each([undefined, "foo", ["https://t.me/ownchan"], [""], [null], ["abc"], Array(201).fill("ownchan")])("rejects invalid settings %j", (value) => { expect(() => parseSystemChannels(value)).toThrow(); });
  it("saved system list is merged by default but never in personal-only mode", () => {
    const configured = { ...settings, channels: parseSystemChannels(["@SystemChan"]) };
    const config = { defaultChannels: ["defaultchan"] };
    expect(resolveSearchDefaults({ channels: ["ownchan"] }, configured, config).channels).toEqual(["systemchan", "ownchan"]);
    expect(resolveSearchDefaults({ channels: ["ownchan"], channelsMode: "only" }, configured, config).channels).toEqual(["ownchan"]);
    expect(resolveSearchDefaults({ channels: ["ownchan"] }, { ...configured, channels: [] }, config).channels).toEqual(["ownchan"]);
  });
});

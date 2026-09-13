import { describe, expect, it } from "vitest";
import { parseTelegramChannelInput } from "../../utils/telegramChannelInput";

describe("personal channel UI input", () => {
  it.each([" OwnChan ", "@OwnChan", "https://t.me/OwnChan", "t.me/OwnChan/", "https://t.me/s/OwnChan", "https://t.me/s/OwnChan/123?single", "https://telegram.me/OwnChan/123", "http://t.me/OwnChan"]) ("normalizes %s to a username, never a URL", (input) => {
    expect(parseTelegramChannelInput(input)).toBe("ownchan");
  });
  it.each(["", "abcd", "https://t.me/+abcde", "https://t.me/joinchat/abcde", "https://t.me/c/123/456", "https://example.com/ownchan", "https://t.me.evil.test/ownchan", "https://t.me@evil.test/ownchan", "https://t.me/ownchan/path", "https://t.me/share/url?url=test", "https://t.me/ownchan/1/more", "tg://resolve?domain=ownchan", "a".repeat(65), "https://t.me/own%63han"]) ("rejects %s", (input) => {
    expect(parseTelegramChannelInput(input)).toBeNull();
  });
});

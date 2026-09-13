import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useSettings } from "../../composables/useSettings";

vi.mock("vue", async (load) => ({ ...await load<typeof import("vue")>(), onMounted: vi.fn() }));

describe("personal channel persistence", () => {
  const getItem = vi.fn();
  const setItem = vi.fn();
  beforeEach(() => {
    const state = new Map();
    vi.stubGlobal("useState", (key: string, init: () => unknown) => {
      if (!state.has(key)) state.set(key, ref(init()));
      return state.get(key);
    });
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem, setItem });
    getItem.mockReset(); setItem.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());
  it("sanitizes saved channels and only loads once across page remounts", () => {
    getItem.mockReturnValue(JSON.stringify({ userTgChannels: ["@OwnChan", "ownchan", null, "https://t.me/another", "abcd"], onlyUserTg: true }));
    const first = useSettings(); first.loadSettings();
    expect(first.settings.value).toEqual({ userTgChannels: ["ownchan"] });
    first.settings.value.userTgChannels.push("newchan");
    const second = useSettings(); second.loadSettings();
    expect(second.settings.value.userTgChannels).toEqual(["ownchan", "newchan"]);
    expect(getItem).toHaveBeenCalledTimes(1);
  });
  it("reports write failures but preserves in-memory channels and can retry", () => {
    const prefs = useSettings(); prefs.loadSettings();
    prefs.settings.value.userTgChannels = ["ownchan"];
    setItem.mockImplementationOnce(() => { throw new Error("storage blocked"); });
    expect(prefs.saveSettings()).toBe(false);
    expect(prefs.storageError.value).toContain("无法保存");
    expect(prefs.settings.value.userTgChannels).toEqual(["ownchan"]);
    expect(prefs.saveSettings()).toBe(true);
    expect(prefs.storageError.value).toBe("");
    expect(setItem).toHaveBeenLastCalledWith("panhub.settings", JSON.stringify(prefs.settings.value));
  });
  it("handles corrupt storage without blocking settings changes", () => {
    getItem.mockReturnValue("{broken");
    const prefs = useSettings(); prefs.loadSettings();
    expect(prefs.settingsReady.value).toBe(true);
    expect(prefs.storageError.value).toContain("无法读取");
    expect(prefs.settings.value.userTgChannels).toEqual([]);
    prefs.resetToDefault();
    expect(prefs.storageError.value).toBe("");
  });
});

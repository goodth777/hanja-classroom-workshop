import { describe, expect, it } from "vitest";
import { searchCharacterCatalog, searchableHanziCount } from "./character-catalog.js";

describe("character catalog", () => {
  it("separates verified, available-unverified, and unavailable Han characters", () => {
    const result = searchCharacterCatalog("木龍龘A나木");
    expect(result.availableDataCount).toBe(searchableHanziCount());
    expect(result.availableDataCount).toBeGreaterThan(9_000);
    expect(result.entries).toEqual([
      expect.objectContaining({ char: "木", status: "verified", strokeCount: 4 }),
      expect.objectContaining({ char: "龍", status: "available_unverified", suggestedLabel: expect.stringContaining("용"), strokeCount: 16 }),
      expect.objectContaining({ char: "龘", status: "unavailable" }),
    ]);
  });

  it("accepts only unique Han characters and caps a query at twenty", () => {
    const query = "一二三四五六七八九十百千萬天地人日月火水木金土";
    const result = searchCharacterCatalog(query);
    expect(result.entries).toHaveLength(20);
    expect(new Set(result.entries.map((entry) => entry.char)).size).toBe(20);
    expect(searchCharacterCatalog(undefined).entries).toEqual([]);
  });
  it("finds available characters by Korean sound reading", () => {
    const result = searchCharacterCatalog("\uBAA9");
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries).toContainEqual(
      expect.objectContaining({ char: "\u6728", status: "verified", suggestedLabel: expect.stringContaining("\uBAA9") }),
    );
    expect(result.entries.every((entry) => /[\uAC00-\uD7A3]/u.test(entry.suggestedLabel ?? entry.label ?? ""))).toBe(true);
  });


  it("prioritizes playable Korean sound results before unavailable entries", () => {
    const result = searchCharacterCatalog("\uC778");
    expect(result.entries.length).toBeGreaterThan(10);
    expect(result.entries[0]).toEqual(
      expect.objectContaining({ char: "\u4EBA", status: "verified", suggestedLabel: expect.stringContaining("\uC778") }),
    );
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ char: "\u4EC1", status: "available_unverified", strokeCount: 4 }),
        expect.objectContaining({ char: "\u5370", status: "available_unverified", strokeCount: 5 }),
        expect.objectContaining({ char: "\u56E0", status: "available_unverified", strokeCount: 6 }),
        expect.objectContaining({ char: "\u5F15", status: "available_unverified", strokeCount: 4 }),
        expect.objectContaining({ char: "\u8A8D", status: "available_unverified", strokeCount: 14 }),
      ]),
    );
    const firstUnavailableIndex = result.entries.findIndex((entry) => entry.status === "unavailable");
    const lastPlayableIndex = Math.max(
      ...result.entries
        .map((entry, index) => entry.status === "verified" || entry.status === "available_unverified" ? index : -1)
        .filter((index) => index >= 0),
    );
    expect(firstUnavailableIndex).toBeGreaterThan(lastPlayableIndex);
  });

});

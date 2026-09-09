import { describe, expect, it } from "vitest";
import {
  CURATED_CHARACTERS,
  getCuratedCharacter,
  HANZI_WRITER_COORDINATE_SYSTEM,
  normalizeHanziWriterPoint,
  simplifyMedian,
} from "./index.js";

describe("curated Hanzi Writer data", () => {
  it("provides the 20-character validation set without duplicates", () => {
    expect(CURATED_CHARACTERS).toHaveLength(20);
    expect(new Set(CURATED_CHARACTERS.map((character) => character.char)).size).toBe(20);
    expect(CURATED_CHARACTERS.map((character) => character.char)).toEqual([
      "木", "水", "人", "十", "一", "二", "三", "四", "五", "六",
      "七", "八", "九", "日", "月", "山", "火", "口", "大", "小",
    ]);
  });

  it("provides 木 as four ordered outline and median strokes", () => {
    const wood = getCuratedCharacter("木");
    expect(wood?.source).toBe("hanzi-writer");
    expect(wood?.pathCoordinateSystem).toEqual(HANZI_WRITER_COORDINATE_SYSTEM);
    expect(wood?.strokeData).toHaveLength(4);
    expect(wood?.strokeData.map((stroke) => stroke.order)).toEqual([1, 2, 3, 4]);
    expect(wood?.strokeData.every((stroke) => stroke.svgPath?.startsWith("M "))).toBe(true);
    expect(wood?.strokeData.every((stroke) => (stroke.median?.length ?? 0) >= 2)).toBe(true);
  });

  it("keeps all curated medians normalized", () => {
    for (const character of CURATED_CHARACTERS) {
      for (const stroke of character.strokeData) {
        expect(stroke.median?.every(({ x, y }) => x >= 0 && x <= 1 && y >= 0 && y <= 1)).toBe(true);
      }
    }
  });

  it("keeps labels and declared stroke counts aligned with source data", () => {
    for (const character of CURATED_CHARACTERS) {
      expect(character.label).toContain(`${character.strokeData.length}획`);
      expect(character.strokeData.map((stroke) => stroke.order)).toEqual(
        Array.from({ length: character.strokeData.length }, (_, index) => index + 1),
      );
      expect(character.strokeData.every((stroke) => Boolean(stroke.svgPath))).toBe(true);
    }
  });

  it("maps the Cartesian baseline into top-down canvas coordinates", () => {
    expect(normalizeHanziWriterPoint([0, 900])).toEqual({ x: 0, y: 0 });
    expect(normalizeHanziWriterPoint([1024, -124])).toEqual({ x: 1, y: 1 });
  });

  it("preserves a meaningful bend when simplifying a median", () => {
    const simplified = simplifyMedian([
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.5 },
    ]);
    expect(simplified).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.5 },
    ]);
  });
});

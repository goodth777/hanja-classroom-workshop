import { describe, expect, it } from "vitest";
import { CURATED_CHARACTERS, validateCharacterData } from "./index.js";

describe("character definitions", () => {
  it("validates every curated character", () => {
    expect(CURATED_CHARACTERS.every(validateCharacterData)).toBe(true);
  });

  it("rejects non-sequential orders and unsafe paths", () => {
    const clone = structuredClone(CURATED_CHARACTERS[0]!);
    clone.source = "custom";
    clone.strokeData[0]!.order = 3;
    expect(validateCharacterData(clone)).toBe(false);

    clone.strokeData[0]!.order = 1;
    clone.strokeData[0]!.svgPath = "<script>alert(1)</script>";
    expect(validateCharacterData(clone)).toBe(false);
  });
});

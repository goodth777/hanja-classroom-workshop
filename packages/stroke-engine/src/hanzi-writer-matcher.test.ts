import type { Stroke } from "@hanja/contracts";
import { describe, expect, it } from "vitest";
import { CURATED_CHARACTERS, judgeStroke, matchHanziWriterStroke } from "./index.js";

function line(y: number, order: number): Stroke {
  const median = [
    { x: 0.1, y },
    { x: 0.5, y },
    { x: 0.9, y },
  ];
  return {
    order,
    startPoint: median[0]!,
    endPoint: median[median.length - 1]!,
    median,
    toleranceRadius: 0.13,
    angleTolerance: 48,
    lengthToleranceRatio: [0.55, 1.9],
  };
}

function studentLikePath(points: readonly { x: number; y: number }[], seed: number) {
  const dense = points.flatMap((point, index) => {
    const next = points[index + 1];
    if (!next) return [point];
    return [0, 0.25, 0.5, 0.75].map((ratio) => ({
      x: point.x + (next.x - point.x) * ratio,
      y: point.y + (next.y - point.y) * ratio,
    }));
  });
  return dense.map((point, index) => {
    const endpoint = index === 0 || index === dense.length - 1;
    const noise = endpoint ? 0.003 : 0.009;
    return {
      x: Math.min(1, Math.max(0, point.x + Math.sin(index * 1.7 + seed) * noise)),
      y: Math.min(1, Math.max(0, point.y + Math.cos(index * 1.3 + seed) * noise)),
    };
  });
}

describe("Hanzi Writer matcher adaptation", () => {
  it("accepts the curated median for every stroke", () => {
    for (const character of CURATED_CHARACTERS) {
      character.strokeData.forEach((stroke, strokeIndex) => {
        const result = judgeStroke(stroke, stroke.median, {
          characterStrokes: character.strokeData,
          strokeIndex,
        });
        expect(result.reason, `${character.char} stroke ${strokeIndex + 1}`).toBe("correct");
      });
    }
  });

  it("detects a correct stroke drawn backwards", () => {
    const stroke = line(0.5, 1);
    const result = matchHanziWriterStroke([...stroke.median!].reverse(), [stroke], 0, {
      isOutlineVisible: true,
    });
    expect(result).toMatchObject({ isMatch: false, isStrokeBackwards: true });
  });

  it("rejects a path that matches a later stroke more closely", () => {
    const strokes = [line(0.38, 1), line(0.5, 2)];
    const result = matchHanziWriterStroke(strokes[1]!.median!, strokes, 0, {
      isOutlineVisible: true,
    });
    expect(result.isMatch).toBe(false);
    expect(result.checks.strokeOrder).toBe(false);
  });

  it("allows small hand-drawn noise while keeping endpoints and direction", () => {
    const stroke = line(0.5, 1);
    const result = matchHanziWriterStroke(
      [
        { x: 0.1, y: 0.5 },
        { x: 0.3, y: 0.49 },
        { x: 0.5, y: 0.51 },
        { x: 0.7, y: 0.495 },
        { x: 0.9, y: 0.5 },
      ],
      [stroke],
      0,
      { isOutlineVisible: true },
    );
    expect(result.isMatch).toBe(true);
  });

  it("accepts deterministic student-like wobble across all curated strokes", () => {
    for (const character of CURATED_CHARACTERS) {
      character.strokeData.forEach((stroke, strokeIndex) => {
        for (let seed = 0; seed < 5; seed += 1) {
          const result = judgeStroke(stroke, studentLikePath(stroke.median!, seed), {
            characterStrokes: character.strokeData,
            strokeIndex,
          });
          expect(result.reason, `${character.char} stroke ${strokeIndex + 1}, seed ${seed}`).toBe(
            "correct",
          );
        }
      });
    }
  });

  it("rejects every curated stroke when drawn in reverse", () => {
    for (const character of CURATED_CHARACTERS) {
      character.strokeData.forEach((stroke, strokeIndex) => {
        const result = judgeStroke(stroke, [...stroke.median!].reverse(), {
          characterStrokes: character.strokeData,
          strokeIndex,
        });
        expect(result.correct, `${character.char} stroke ${strokeIndex + 1}`).toBe(false);
      });
    }
  });

  it("rejects the next stroke when it is attempted early", () => {
    for (const character of CURATED_CHARACTERS) {
      for (let strokeIndex = 0; strokeIndex < character.strokeData.length - 1; strokeIndex += 1) {
        const current = character.strokeData[strokeIndex]!;
        const next = character.strokeData[strokeIndex + 1]!;
        const result = judgeStroke(current, next.median, {
          characterStrokes: character.strokeData,
          strokeIndex,
        });
        expect(result.correct, `${character.char}: stroke ${strokeIndex + 2} attempted early`).toBe(
          false,
        );
      }
    }
  });
});

import type { Stroke } from "@hanja/contracts";
import { describe, expect, it } from "vitest";
import {
  angleDifferenceDegrees,
  isValidPointSequence,
  judgeStroke,
  STROKE_LIMITS,
} from "./index.js";

const horizontal: Stroke = {
  order: 1,
  startPoint: { x: 0.1, y: 0.5 },
  endPoint: { x: 0.9, y: 0.5 },
  toleranceRadius: 0.1,
  angleTolerance: 15,
  lengthToleranceRatio: [0.8, 1.2],
};

describe("judgeStroke", () => {
  it("separates 0.0299 from the inclusive 0.03 boundary", () => {
    const tiny: Stroke = {
      ...horizontal,
      startPoint: { x: 0, y: 0.5 },
      endPoint: { x: 0.03, y: 0.5 },
      toleranceRadius: 0.001,
      lengthToleranceRatio: [1, 1],
    };

    expect(judgeStroke(tiny, [{ x: 0, y: 0.5 }, { x: 0.0299, y: 0.5 }]).reason).toBe("too_short");
    expect(judgeStroke(tiny, [{ x: 0, y: 0.5 }, { x: 0.03, y: 0.5 }])).toMatchObject({
      correct: true,
      reason: "correct",
    });
  });

  it("accepts endpoint tolerance at the boundary and rejects just outside", () => {
    expect(
      judgeStroke(horizontal, [{ x: 0, y: 0.5 }, { x: 0.9, y: 0.5 }]).reason,
    ).toBe("correct");
    expect(
      judgeStroke(horizontal, [{ x: 0, y: 0.499 }, { x: 0.9, y: 0.5 }]).reason,
    ).toBe("start_mismatch");
  });

  it("checks every checkpoint against the full trajectory", () => {
    const bent: Stroke = {
      ...horizontal,
      startPoint: { x: 0.1, y: 0.1 },
      endPoint: { x: 0.9, y: 0.9 },
      checkpoints: [{ x: 0.5, y: 0.2 }],
      angleTolerance: 45,
      lengthToleranceRatio: [0.5, 2],
    };

    expect(
      judgeStroke(bent, [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.31 },
        { x: 0.9, y: 0.9 },
      ]).reason,
    ).toBe("correct");
    expect(
      judgeStroke(bent, [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.3101 },
        { x: 0.9, y: 0.9 },
      ]).reason,
    ).toBe("angle_mismatch");
  });

  it("rejects checkpoint bypass even when start and end match", () => {
    const bent: Stroke = {
      ...horizontal,
      startPoint: { x: 0.1, y: 0.1 },
      endPoint: { x: 0.9, y: 0.9 },
      checkpoints: [{ x: 0.7, y: 0.2 }],
      angleTolerance: 45,
      lengthToleranceRatio: [0.5, 2],
    };
    expect(judgeStroke(bent, [bent.startPoint, bent.endPoint]).reason).toBe("angle_mismatch");
  });

  it("rejects empty, single, non-finite, and out-of-range inputs", () => {
    expect(judgeStroke(horizontal, []).reason).toBe("invalid_input");
    expect(judgeStroke(horizontal, [{ x: 0.1, y: 0.5 }]).reason).toBe("invalid_input");
    expect(judgeStroke(horizontal, [{ x: 0.1, y: 0.5 }, { x: Number.NaN, y: 0.5 }]).reason).toBe("invalid_input");
    expect(isValidPointSequence([{ x: 0.1, y: 0.5 }, { x: 1.01, y: 0.5 }])).toBe(false);
  });

  it("handles the 0/360 angle boundary", () => {
    expect(angleDifferenceDegrees(359, 1)).toBe(2);
    expect(angleDifferenceDegrees(-179, 179)).toBe(2);
  });

  it("publishes the PRD constants", () => {
    expect(STROKE_LIMITS).toEqual({ checkpointTolerance: 0.11, minimumDrawLength: 0.03 });
  });

  it("uses the full median for expected stroke length", () => {
    const bent: Stroke = {
      ...horizontal,
      startPoint: { x: 0.1, y: 0.1 },
      endPoint: { x: 0.9, y: 0.9 },
      median: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ],
      checkpoints: [{ x: 0.9, y: 0.1 }],
      angleTolerance: 50,
      lengthToleranceRatio: [0.99, 1.01],
    };
    const result = judgeStroke(bent, bent.median);
    expect(result.correct).toBe(true);
    expect(result.metrics?.expectedLength).toBeCloseTo(1.6, 5);
  });
});

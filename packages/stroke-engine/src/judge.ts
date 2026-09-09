import type { JudgmentReason, Point, Stroke } from "@hanja/contracts";
import { matchHanziWriterStroke, type HanziWriterMatchOptions } from "./hanzi-writer-matcher.js";

export interface JudgmentMetrics {
  drawLength: number;
  expectedLength: number;
  lengthRatio: number;
  angleDifference: number;
}

export interface JudgmentResult {
  correct: boolean;
  reason: JudgmentReason;
  metrics?: JudgmentMetrics;
}

export interface StrokeJudgmentContext {
  characterStrokes: readonly Stroke[];
  strokeIndex: number;
  matcherOptions?: HanziWriterMatchOptions;
}

const CHECKPOINT_TOLERANCE = 0.11;
const MIN_DRAW_LENGTH = 0.03;

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1]!, points[index]!);
  }
  return total;
}

export function angleDifferenceDegrees(a: number, b: number): number {
  const raw = Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
  return raw;
}

function vectorAngle(start: Point, end: Point): number {
  return (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
}

export function isNormalizedPoint(point: unknown): point is Point {
  if (!point || typeof point !== "object") return false;
  const candidate = point as Partial<Point>;
  return (
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    candidate.x! >= 0 &&
    candidate.x! <= 1 &&
    candidate.y! >= 0 &&
    candidate.y! <= 1
  );
}

export function isValidPointSequence(points: unknown): points is Point[] {
  return (
    Array.isArray(points) &&
    points.length >= 2 &&
    points.length <= 2048 &&
    points.every(isNormalizedPoint)
  );
}

function expectedPath(stroke: Stroke): Point[] {
  return stroke.median && stroke.median.length >= 2
    ? stroke.median
    : [stroke.startPoint, ...(stroke.checkpoints ?? []), stroke.endPoint];
}

function checkpointWasVisited(points: readonly Point[], checkpoint: Point): boolean {
  return points.some((point) => distance(point, checkpoint) <= CHECKPOINT_TOLERANCE);
}

export function judgeStroke(
  stroke: Stroke,
  points: unknown,
  context?: StrokeJudgmentContext,
): JudgmentResult {
  if (!isValidPointSequence(points)) {
    return { correct: false, reason: "invalid_input" };
  }

  const drawLength = pathLength(points);
  if (drawLength < MIN_DRAW_LENGTH) {
    return { correct: false, reason: "too_short" };
  }

  const start = points[0]!;
  const end = points[points.length - 1]!;
  const expectedLength = pathLength(expectedPath(stroke));
  const lengthRatio = expectedLength === 0 ? Number.POSITIVE_INFINITY : drawLength / expectedLength;
  const angleDifference = angleDifferenceDegrees(
    vectorAngle(start, end),
    vectorAngle(stroke.startPoint, stroke.endPoint),
  );
  const metrics = { drawLength, expectedLength, lengthRatio, angleDifference };

  if (context) {
    const match = matchHanziWriterStroke(
      points,
      context.characterStrokes,
      context.strokeIndex,
      { isOutlineVisible: true, acceptBackwardsStrokes: false, ...context.matcherOptions },
    );
    if (!match.isMatch) {
      if (!match.checks.start) return { correct: false, reason: "start_mismatch", metrics };
      if (!match.checks.end) return { correct: false, reason: "end_mismatch", metrics };
      if (!match.checks.length) return { correct: false, reason: "length_mismatch", metrics };
      return { correct: false, reason: "angle_mismatch", metrics };
    }
  }

  if (distance(start, stroke.startPoint) > stroke.toleranceRadius) {
    return { correct: false, reason: "start_mismatch", metrics };
  }
  if (distance(end, stroke.endPoint) > stroke.toleranceRadius) {
    return { correct: false, reason: "end_mismatch", metrics };
  }
  if (angleDifference > stroke.angleTolerance) {
    return { correct: false, reason: "angle_mismatch", metrics };
  }
  if (
    lengthRatio < stroke.lengthToleranceRatio[0] ||
    lengthRatio > stroke.lengthToleranceRatio[1]
  ) {
    return { correct: false, reason: "length_mismatch", metrics };
  }
  if ((stroke.checkpoints ?? []).some((checkpoint) => !checkpointWasVisited(points, checkpoint))) {
    return { correct: false, reason: "angle_mismatch", metrics };
  }

  return { correct: true, reason: "correct", metrics };
}

export const STROKE_LIMITS = {
  checkpointTolerance: CHECKPOINT_TOLERANCE,
  minimumDrawLength: MIN_DRAW_LENGTH,
} as const;

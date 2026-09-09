/*
 * Adapted from Hanzi Writer 3.7.3's MIT-licensed stroke matcher.
 * Copyright (c) 2014 David Chanin. See licenses/HANZI_WRITER_LICENSE.
 *
 * The upstream matcher works in a 1024-unit character space. This adaptation
 * keeps the same algorithm and thresholds while accepting our normalized
 * [0, 1] points and exposing diagnostics for the server's stable result codes.
 */
import type { Point, Stroke } from "@hanja/contracts";

const UNIT_SCALE = 1024;
const START_AND_END_DISTANCE = 250 / UNIT_SCALE;
const AVERAGE_DISTANCE = 350 / UNIT_SCALE;
const LENGTH_PADDING = 25 / UNIT_SCALE;
const FRECHET_THRESHOLD = 0.4;
const MIN_LENGTH_THRESHOLD = 0.35;
const ROTATIONS = [Math.PI / 16, Math.PI / 32, 0, -Math.PI / 32, -Math.PI / 16];

export interface HanziWriterMatchOptions {
  leniency?: number;
  isOutlineVisible?: boolean;
  acceptBackwardsStrokes?: boolean;
  averageDistanceThreshold?: number;
}

export interface HanziWriterMatchResult {
  isMatch: boolean;
  isStrokeBackwards: boolean;
  averageDistance: number;
  checks: {
    withinDistance: boolean;
    start: boolean;
    end: boolean;
    direction: boolean;
    shape: boolean;
    length: boolean;
    strokeOrder: boolean;
  };
}

interface MatchData extends Omit<HanziWriterMatchResult, "checks"> {
  checks: HanziWriterMatchResult["checks"];
}

const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const magnitude = (point: Point): number => Math.hypot(point.x, point.y);
const distance = (a: Point, b: Point): number => magnitude(subtract(a, b));
const average = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

function curveLength(points: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1]!, points[index]!);
  }
  return total;
}

function stripDuplicates(points: readonly Point[]): Point[] {
  return points.filter(
    (point, index) =>
      index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y,
  );
}

function extendPointOnLine(a: Point, b: Point, extension: number): Point {
  const vector = subtract(b, a);
  const vectorLength = magnitude(vector);
  if (vectorLength === 0) return { ...b };
  const scale = extension / vectorLength;
  return { x: b.x + scale * vector.x, y: b.y + scale * vector.y };
}

function subdivideCurve(curve: readonly Point[], maxLength = 0.05): Point[] {
  const result: Point[] = [{ ...curve[0]! }];
  for (const point of curve.slice(1)) {
    const previous = result[result.length - 1]!;
    const segmentLength = distance(point, previous);
    if (segmentLength <= maxLength) {
      result.push({ ...point });
      continue;
    }
    const count = Math.ceil(segmentLength / maxLength);
    const step = segmentLength / count;
    for (let index = 0; index < count; index += 1) {
      result.push(extendPointOnLine(point, previous, -step * (index + 1)));
    }
  }
  return result;
}

function outlineCurve(curve: readonly Point[], count = 30): Point[] {
  const segmentLength = curveLength(curve) / (count - 1);
  const outlined: Point[] = [{ ...curve[0]! }];
  const remaining = curve.slice(1).map((point) => ({ ...point }));
  for (let index = 0; index < count - 2; index += 1) {
    let previous = outlined[outlined.length - 1]!;
    let remainingDistance = segmentLength;
    while (remaining.length > 0) {
      const nextDistance = distance(previous, remaining[0]!);
      if (nextDistance < remainingDistance) {
        remainingDistance -= nextDistance;
        previous = remaining.shift()!;
      } else {
        outlined.push(extendPointOnLine(previous, remaining[0]!, remainingDistance - nextDistance));
        break;
      }
    }
  }
  outlined.push({ ...curve[curve.length - 1]! });
  return outlined;
}

function normalizeCurve(curve: readonly Point[]): Point[] {
  const outlined = outlineCurve(curve);
  const mean = {
    x: average(outlined.map((point) => point.x)),
    y: average(outlined.map((point) => point.y)),
  };
  const translated = outlined.map((point) => subtract(point, mean));
  const first = translated[0]!;
  const last = translated[translated.length - 1]!;
  const scale = Math.sqrt(average([first.x ** 2 + first.y ** 2, last.x ** 2 + last.y ** 2]));
  if (scale === 0) return translated;
  return subdivideCurve(translated.map((point) => ({ x: point.x / scale, y: point.y / scale })));
}

function rotate(curve: readonly Point[], angle: number): Point[] {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return curve.map((point) => ({
    x: cosine * point.x - sine * point.y,
    y: sine * point.x + cosine * point.y,
  }));
}

function frechetDistance(first: readonly Point[], second: readonly Point[]): number {
  const long = first.length >= second.length ? first : second;
  const short = first.length >= second.length ? second : first;
  let previous: number[] = [];
  for (let i = 0; i < long.length; i += 1) {
    const current: number[] = [];
    for (let j = 0; j < short.length; j += 1) {
      const pointDistance = distance(long[i]!, short[j]!);
      if (i === 0 && j === 0) current.push(pointDistance);
      else if (j === 0) current.push(Math.max(previous[0]!, pointDistance));
      else if (i === 0) current.push(Math.max(current[j - 1]!, pointDistance));
      else current.push(Math.max(Math.min(previous[j]!, previous[j - 1]!, current[j - 1]!), pointDistance));
    }
    previous = current;
  }
  return previous[short.length - 1]!;
}

function shapeMatches(points: readonly Point[], median: readonly Point[], leniency: number): boolean {
  const normalizedPoints = normalizeCurve(points);
  const normalizedMedian = normalizeCurve(median);
  return Math.min(...ROTATIONS.map((angle) => frechetDistance(normalizedPoints, rotate(normalizedMedian, angle)))) <=
    FRECHET_THRESHOLD * leniency;
}

function averageDistanceFromMedian(points: readonly Point[], median: readonly Point[]): number {
  return average(points.map((point) => Math.min(...median.map((target) => distance(point, target)))));
}

function directionMatches(points: readonly Point[], median: readonly Point[]): boolean {
  const edges = points.slice(1).map((point, index) => subtract(point, points[index]!));
  const expected = median.slice(1).map((point, index) => subtract(point, median[index]!));
  const similarities = edges.map((edge) => {
    const edgeLength = magnitude(edge);
    if (edgeLength === 0) return -1;
    return Math.max(
      ...expected.map((vector) => {
        const vectorLength = magnitude(vector);
        return vectorLength === 0
          ? -1
          : (edge.x * vector.x + edge.y * vector.y) / edgeLength / vectorLength;
      }),
    );
  });
  return average(similarities) > 0;
}

function getMatchData(
  points: readonly Point[],
  stroke: Stroke,
  strokeIndex: number,
  options: HanziWriterMatchOptions,
  checkBackwards: boolean,
): MatchData {
  const median = stroke.median ?? [stroke.startPoint, ...(stroke.checkpoints ?? []), stroke.endPoint];
  const leniency = options.leniency ?? 1;
  const averageDistance = averageDistanceFromMedian(points, median);
  const distanceModifier = options.isOutlineVisible || strokeIndex > 0 ? 0.5 : 1;
  const withinDistance =
    averageDistance <= (options.averageDistanceThreshold ?? AVERAGE_DISTANCE) * distanceModifier * leniency;
  const start = distance(points[0]!, median[0]!) <= START_AND_END_DISTANCE * leniency;
  const end = distance(points[points.length - 1]!, median[median.length - 1]!) <=
    START_AND_END_DISTANCE * leniency;
  const direction = directionMatches(points, median);
  const shape = shapeMatches(points, median, leniency);
  const length = leniency * (curveLength(points) + LENGTH_PADDING) / (curveLength(median) + LENGTH_PADDING) >=
    MIN_LENGTH_THRESHOLD;
  const checks = { withinDistance, start, end, direction, shape, length, strokeOrder: true };
  const isMatch = Object.values(checks).every(Boolean);

  if (checkBackwards && !isMatch) {
    const backwards = getMatchData([...points].reverse(), stroke, strokeIndex, options, false);
    if (backwards.isMatch) return { isMatch: false, isStrokeBackwards: true, averageDistance, checks };
  }
  return { isMatch, isStrokeBackwards: false, averageDistance, checks };
}

export function matchHanziWriterStroke(
  userPoints: readonly Point[],
  strokes: readonly Stroke[],
  strokeIndex: number,
  options: HanziWriterMatchOptions = {},
): HanziWriterMatchResult {
  const points = stripDuplicates(userPoints);
  const stroke = strokes[strokeIndex];
  if (!stroke || points.length < 2) {
    return {
      isMatch: false,
      isStrokeBackwards: false,
      averageDistance: Number.POSITIVE_INFINITY,
      checks: { withinDistance: false, start: false, end: false, direction: false, shape: false, length: false, strokeOrder: true },
    };
  }

  const result = getMatchData(points, stroke, strokeIndex, options, options.acceptBackwardsStrokes !== true);
  if (!result.isMatch) return result;

  let closestLaterDistance = result.averageDistance;
  for (let index = strokeIndex + 1; index < strokes.length; index += 1) {
    const later = getMatchData(points, strokes[index]!, index, options, false);
    if (later.isMatch && later.averageDistance < closestLaterDistance) closestLaterDistance = later.averageDistance;
  }
  if (closestLaterDistance < result.averageDistance) {
    const adjustment = 0.6 * (closestLaterDistance + result.averageDistance) / (2 * result.averageDistance);
    const stricter = getMatchData(points, stroke, strokeIndex, {
      ...options,
      leniency: (options.leniency ?? 1) * adjustment,
    }, options.acceptBackwardsStrokes !== true);
    if (!stricter.isMatch) {
      return { ...stricter, checks: { ...stricter.checks, strokeOrder: false } };
    }
  }
  return result;
}

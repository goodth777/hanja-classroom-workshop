import type { CharacterData, Point, Stroke } from "@hanja/contracts";

export interface HanziWriterCharacterSource {
  strokes: string[];
  medians: number[][][];
}

export const HANZI_WRITER_COORDINATE_SYSTEM = {
  width: 1024,
  height: 1024,
  originY: 900,
  flipY: true,
} as const;

export function normalizeHanziWriterPoint(raw: readonly number[]): Point {
  const x = raw[0];
  const y = raw[1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError("Hanzi Writer median contains a non-finite coordinate");
  }
  return {
    x: Math.min(1, Math.max(0, x! / HANZI_WRITER_COORDINATE_SYSTEM.width)),
    y: Math.min(
      1,
      Math.max(
        0,
        (HANZI_WRITER_COORDINATE_SYSTEM.originY - y!) /
          HANZI_WRITER_COORDINATE_SYSTEM.height,
      ),
    ),
  };
}

function perpendicularDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.min(
    1,
    Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

export function simplifyMedian(points: readonly Point[], epsilon = 0.025): Point[] {
  if (points.length <= 2) return [...points];
  const start = points[0]!;
  const end = points[points.length - 1]!;
  let farthestIndex = -1;
  let farthestDistance = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const candidateDistance = perpendicularDistance(points[index]!, start, end);
    if (candidateDistance > farthestDistance) {
      farthestDistance = candidateDistance;
      farthestIndex = index;
    }
  }
  if (farthestDistance <= epsilon || farthestIndex < 0) return [start, end];
  const left = simplifyMedian(points.slice(0, farthestIndex + 1), epsilon);
  const right = simplifyMedian(points.slice(farthestIndex), epsilon);
  return [...left.slice(0, -1), ...right];
}

function checkpointsFromMedian(median: readonly Point[]): Point[] | undefined {
  const internal = simplifyMedian(median).slice(1, -1);
  if (internal.length === 0) return undefined;
  if (internal.length <= 8) return internal;
  return Array.from({ length: 8 }, (_, index) => {
    const sourceIndex = Math.round((index * (internal.length - 1)) / 7);
    return internal[sourceIndex]!;
  });
}

export function createHanziWriterCharacter(
  char: string,
  label: string,
  source: HanziWriterCharacterSource,
): CharacterData {
  if (source.strokes.length === 0 || source.strokes.length !== source.medians.length) {
    throw new TypeError(`Invalid Hanzi Writer data for ${char}`);
  }
  const strokeData: Stroke[] = source.strokes.map((svgPath, index) => {
    const rawMedian = source.medians[index];
    if (!rawMedian || rawMedian.length < 2) {
      throw new TypeError(`Stroke ${index + 1} for ${char} has no usable median`);
    }
    const median = rawMedian.map(normalizeHanziWriterPoint);
    return {
      order: index + 1,
      startPoint: median[0]!,
      endPoint: median[median.length - 1]!,
      median,
      checkpoints: checkpointsFromMedian(median),
      svgPath,
      toleranceRadius: 0.13,
      angleTolerance: 48,
      lengthToleranceRatio: [0.55, 1.9],
    };
  });
  return {
    char,
    label,
    source: "hanzi-writer",
    pathCoordinateSystem: HANZI_WRITER_COORDINATE_SYSTEM,
    strokeData,
  };
}

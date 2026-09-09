import type { CharacterData, Stroke } from "@hanja/contracts";
import { isNormalizedPoint } from "./judge.js";

const SAFE_SVG_PATH = /^[MmZzLlHhVvCcSsQqTtAaEe0-9.,+\-\s]+$/;

export function isValidStrokeDefinition(stroke: unknown, expectedOrder?: number): stroke is Stroke {
  if (!stroke || typeof stroke !== "object") return false;
  const value = stroke as Partial<Stroke>;
  const ratio = value.lengthToleranceRatio;
  return (
    Number.isInteger(value.order) &&
    (expectedOrder === undefined || value.order === expectedOrder) &&
    isNormalizedPoint(value.startPoint) &&
    isNormalizedPoint(value.endPoint) &&
    typeof value.toleranceRadius === "number" &&
    value.toleranceRadius > 0 &&
    value.toleranceRadius <= 0.5 &&
    typeof value.angleTolerance === "number" &&
    value.angleTolerance >= 0 &&
    value.angleTolerance <= 180 &&
    Array.isArray(ratio) &&
    ratio.length === 2 &&
    Number.isFinite(ratio[0]) &&
    Number.isFinite(ratio[1]) &&
    ratio[0]! > 0 &&
    ratio[0]! <= ratio[1]! &&
    ratio[1]! <= 10 &&
    (value.checkpoints === undefined ||
      (Array.isArray(value.checkpoints) &&
        value.checkpoints.length <= 16 &&
        value.checkpoints.every(isNormalizedPoint))) &&
    (value.median === undefined ||
      (Array.isArray(value.median) &&
        value.median.length >= 2 &&
        value.median.length <= 64 &&
        value.median.every(isNormalizedPoint))) &&
    (value.svgPath === undefined ||
      (typeof value.svgPath === "string" &&
        value.svgPath.length > 0 &&
        value.svgPath.length <= 2000 &&
        SAFE_SVG_PATH.test(value.svgPath)))
  );
}

export function validateCharacterData(character: unknown): character is CharacterData {
  if (!character || typeof character !== "object") return false;
  const value = character as Partial<CharacterData>;
  return (
    typeof value.char === "string" &&
    Array.from(value.char).length === 1 &&
    typeof value.label === "string" &&
    value.label.trim().length >= 1 &&
    value.label.length <= 40 &&
    (value.source === "hanzi-writer" || value.source === "custom") &&
    (value.pathCoordinateSystem === undefined ||
      (typeof value.pathCoordinateSystem === "object" &&
        Number.isFinite(value.pathCoordinateSystem.width) &&
        value.pathCoordinateSystem.width > 0 &&
        Number.isFinite(value.pathCoordinateSystem.height) &&
        value.pathCoordinateSystem.height > 0 &&
        Number.isFinite(value.pathCoordinateSystem.originY) &&
        typeof value.pathCoordinateSystem.flipY === "boolean")) &&
    Array.isArray(value.strokeData) &&
    value.strokeData.length >= 1 &&
    value.strokeData.length <= 64 &&
    value.strokeData.every((stroke, index) => isValidStrokeDefinition(stroke, index + 1))
  );
}

export * from "./data.js";
export * from "./hanzi-writer.js";
export * from "./hanzi-writer-matcher.js";
export * from "./judge.js";
export * from "./validate.js";

export const STROKE_COLORS = {
  guide: "rgba(35, 42, 54, 0.12)",
  active: "#2878ff",
  incorrect: "rgba(255, 69, 58, 0.85)",
  correct: "rgba(46, 184, 114, 0.95)",
} as const;

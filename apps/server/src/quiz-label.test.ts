import { describe, expect, it } from "vitest";
import { splitQuizLabel } from "./quiz-label.js";

describe("quiz answer labels", () => {
  it.each([
    ["목(나무 목) · 4획", "나무", "목"],
    ["십(열 십) · 2획", "열", "십"],
    ["사람(인)", "사람", "인"],
    ["경영할 영, 변명할 형", "경영할", "영"],
    ["들보 량(양)", "들보", "량"],
    ["보낼 수", "보낼", "수"],
  ])("extracts meaning and reading from %s", (label, meaning, reading) => {
    expect(splitQuizLabel(label)).toMatchObject({ meaning, reading });
  });
});

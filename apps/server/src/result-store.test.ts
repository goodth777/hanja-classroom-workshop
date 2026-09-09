import { describe, expect, it } from "vitest";
import type { SavedGameResult } from "@hanja/contracts";
import { MemoryResultStore } from "./result-store.js";

describe("teacher result history", () => {
  it("isolates teachers and games, averages all pages, preserves ties and excludes stopped games", async () => {
    const store = new MemoryResultStore();
    const result: SavedGameResult = { resultKey: "one", teacherId: "t1", gameMode: "hanja_worm", status: "completed", character: "木", playerCount: 2, completedAt: "2026-09-08T00:00:00Z", scores: [{ nickname: "가람", rank: 1, score: 40 }, { nickname: "나래", rank: 1, score: 40 }] };
    for (let n = 0; n < 22; n++) await store.save({ ...result, resultKey: String(n) });
    await store.save({ ...result, resultKey: "0" });
    await store.save({ ...result, resultKey: "stopped", status: "stopped", scores: [{ nickname: "가람", rank: 1, score: 999 }] });
    await store.save({ ...result, resultKey: "other", teacherId: "t2", scores: [{ nickname: "비밀", rank: 1, score: 999 }] });
    await store.save({ ...result, resultKey: "quiz", gameMode: "meaning_sound_quiz" });
    const first = await store.history("t1", "hanja_worm", 0);
    expect(first.results).toHaveLength(20); expect(first.hasMore).toBe(true);
    expect(first.leaderboard).toEqual([{ nickname: "가람", average: 40, games: 22, rank: 1 }, { nickname: "나래", average: 40, games: 22, rank: 1 }]);
    const second = await store.history("t1", "hanja_worm", 20);
    expect(second.results).toHaveLength(3); expect(second.hasMore).toBe(false);
    expect(second.leaderboard).toEqual(first.leaderboard);
    expect((await store.history("unknown", "hanja_worm", 0)).results).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { CURATED_CHARACTERS } from "@hanja/stroke-engine";
import { MemoryResultStore } from "./result-store.js";
import { createUniqueRoomCode, RoomManager } from "./room-manager.js";

const QUIZ_ANSWERS: Record<string, { reading: string; meaning: string }> = {
  "十": { reading: "십", meaning: "열" },
  "人": { reading: "인", meaning: "사람" },
  "木": { reading: "목", meaning: "나무" },
  "水": { reading: "수", meaning: "물" },
};

function answerFor(quiz: NonNullable<ReturnType<RoomManager["getSnapshot"]>["quiz"]>) {
  if (quiz.questionType === "hanja_choice") return quiz.promptChar;
  const field = quiz.questionType.startsWith("reading") ? "reading" : "meaning";
  return QUIZ_ANSWERS[quiz.promptChar]![field];
}

describe("RoomManager", () => {
  it("makes repeated admission on the same socket idempotent, even after game start", () => {
    const manager = new RoomManager({ resultStore: new MemoryResultStore(), roomCodeNumber: () => 123456 });
    manager.createRoom("host", "木");
    const first = manager.joinRoom("student", "123456", "학생");
    const retry = manager.joinRoom("student", "123456", "학생");
    expect(retry.playerId).toBe(first.playerId);
    expect(retry.reconnectToken).toBe(first.reconnectToken);
    manager.startGame("host", "123456");
    const resumed = manager.joinRoom("student", "123456", "학생");
    expect(resumed.snapshot.players).toHaveLength(1);
    expect(resumed.snapshot.selectedPlayerId).toBe(first.playerId);
  });

  it("keeps the active stroke data but sends only summaries for the full game list", () => {
    const manager = new RoomManager({
      resultStore: new MemoryResultStore(),
      roomCodeNumber: () => 123456,
    });
    const snapshot = manager.createRoom(
      "host",
      CURATED_CHARACTERS.map((character) => character.char),
    ).snapshot;

    expect(snapshot.character.strokeData.length).toBeGreaterThan(0);
    expect(snapshot.characters).toHaveLength(CURATED_CHARACTERS.length);
    expect(snapshot.characters.every((character) => !("strokeData" in character))).toBe(true);
    expect(JSON.stringify(snapshot.characters).length).toBeLessThan(2_000);
  });

  it("keeps quiz deadlines, retries, completion and reconnect progress independent", () => {
    let now = 1000;
    const manager = new RoomManager({ resultStore: new MemoryResultStore(), now: () => now, roomCodeNumber: () => 123456, randomIndex: () => 0 });
    manager.createRoom("host", ["十", "人", "木", "水"], undefined, undefined, "meaning_sound_quiz", 8);
    const fast = manager.joinRoom("fast", "123456", "빠름");
    manager.joinRoom("slow", "123456", "느림");
    manager.startGame("host", "123456");
    for (let index = 0; index < 8; index++) {
      const quiz = manager.getSnapshotForSocket("123456", "fast").quiz!;
      expect(quiz.questionIndex).toBe(index);
      const answer = answerFor(quiz);
      const choice = quiz.choices.find((item) => item.label === answer);
      const result = manager.answerQuiz("fast", "123456", choice?.id, answer, index);
      const duplicate = manager.answerQuiz("fast", "123456", choice?.id, answer, index);
      expect(result.correct).toBe(true);
      expect(duplicate.snapshot.players[0]!.score).toBe(result.snapshot.players[0]!.score);
      now += 801;
      manager.tickQuiz("123456");
      expect(manager.getSnapshotForSocket("123456", "slow").quiz?.questionIndex).toBe(0);
      if (index < 7) expect(() => manager.answerQuiz("fast", "123456", choice?.id, answer, index)).toThrow("지난 문제");
    }
    expect(manager.getSnapshotForSocket("123456", "fast")).toMatchObject({ status: "in_progress", quizFinished: true });
    manager.disconnect("fast");
    const restored = manager.joinRoom("fast-new", "123456", "ignored", fast.reconnectToken);
    expect(restored.snapshot).toMatchObject({ quizFinished: true, quiz: { questionIndex: 7, totalQuestions: 8 } });
    expect(restored.snapshot.players[0]!.score).toBe(800);
    now = 13001;
    expect(() => manager.answerQuiz("slow", "123456", "choice-十", undefined, 0)).toThrow("시간이 끝났습니다");
    manager.tickQuiz("123456");
    now += 801;
    manager.tickQuiz("123456");
    const slowQuiz = manager.getSnapshotForSocket("123456", "slow").quiz!;
    expect(slowQuiz.questionIndex).toBe(1);
    const wrong = slowQuiz.choices.find((item) => item.label !== answerFor(slowQuiz))!;
    expect(manager.answerQuiz("slow", "123456", wrong?.id, "오답", 1).attemptNumber).toBe(1);
    expect(manager.getSnapshotForSocket("123456", "slow").quiz?.phase).toBe("question");
    manager.answerQuiz("slow", "123456", wrong?.id, "오답", 1);
    now += 801;
    manager.tickQuiz("123456");
    expect(manager.getSnapshotForSocket("123456", "slow").quiz?.questionIndex).toBe(2);
    for (let index = 2; index < 8; index++) {
      const quiz = manager.getSnapshotForSocket("123456", "slow").quiz!;
      const answer = answerFor(quiz);
      const choice = quiz.choices.find((item) => item.label === answer);
      manager.answerQuiz("slow", "123456", choice?.id, answer, index);
      now += 801;
      manager.tickQuiz("123456");
    }
    expect(manager.getSnapshot("123456").status).toBe("finished");
  });

  it("defaults to one varied question per Hanja and accepts a teacher-selected count", () => {
    let now = 1000;
    const manager = new RoomManager({ resultStore: new MemoryResultStore(), now: () => now, roomCodeNumber: () => 123456, randomIndex: () => 0 });
    manager.createRoom("host", ["十", "人", "木", "水"], undefined, undefined, "meaning_sound_quiz");
    manager.joinRoom("student", "123456", "학생");
    manager.startGame("host", "123456");

    const seen: Array<{ char: string; type: string; hint?: string }> = [];
    for (let questionIndex = 0; questionIndex < 4; questionIndex += 1) {
      const quiz = manager.getSnapshotForSocket("123456", "student").quiz!;
      expect(quiz).toMatchObject({ questionIndex, totalQuestions: 4 });
      expect(seen.at(-1)?.char).not.toBe(quiz.promptChar);
      expect(quiz.questionType === "meaning_input").toBe(false);
      seen.push({ char: quiz.promptChar, type: quiz.questionType, hint: quiz.promptHint });
      const answer = answerFor(quiz);
      const choice = quiz.choices.find((item) => item.label === answer);
      manager.answerQuiz("student", "123456", choice?.id, answer, questionIndex);
      if (questionIndex < 3) {
        now += 801;
        manager.tickQuiz("123456");
      }
    }
    expect(new Set(seen.map((question) => question.char))).toEqual(new Set(Object.keys(QUIZ_ANSWERS)));
    expect(seen.map((question) => question.type)).toEqual(["hanja_choice", "reading_choice", "meaning_choice", "reading_input"]);
    expect(seen.find((question) => question.type === "reading_input")?.hint).toEqual(expect.stringContaining("____"));

    const expanded = new RoomManager({ resultStore: new MemoryResultStore(), roomCodeNumber: () => 654321, randomIndex: () => 0 });
    expanded.createRoom("expanded-host", ["十", "人", "木", "水"], undefined, undefined, "meaning_sound_quiz", 8);
    expanded.joinRoom("expanded-student", "654321", "학생");
    expanded.startGame("expanded-host", "654321");
    expect(expanded.getSnapshotForSocket("654321", "expanded-student").quiz?.totalQuestions).toBe(8);
  });
  it("generates a secure-shape 6 digit code and retries collisions", () => {
    const values = [123456, 123456, 654321];
    const code = createUniqueRoomCode(new Set(["123456"]), () => values.shift()!);
    expect(code).toBe("654321");
  });

  it("rejects a second active room", () => {
    const manager = new RoomManager({
      resultStore: new MemoryResultStore(),
      roomCodeNumber: () => 123456,
    });
    manager.createRoom("host-1", "十");
    expect(() => manager.createRoom("host-2", "人")).toThrow("이미 진행 중인 게임룸");
  });

  it("resolves duplicate nicknames and caps the room at 30 players", () => {
    const manager = new RoomManager({
      resultStore: new MemoryResultStore(),
      roomCodeNumber: () => 123456,
    });
    manager.createRoom("host", "十");
    expect(manager.joinRoom("socket-0", "123456", "민지").nickname).toBe("민지");
    expect(manager.joinRoom("socket-1", "123456", "민지").nickname).toBe("민지_2");
    for (let index = 2; index < 30; index += 1) {
      manager.joinRoom(`socket-${index}`, "123456", `학생${index}`);
    }
    expect(() => manager.joinRoom("socket-31", "123456", "마지막")).toThrow("가득 찼습니다");
  });

  it("restores a disconnected player without duplicating score state", () => {
    const manager = new RoomManager({
      resultStore: new MemoryResultStore(),
      roomCodeNumber: () => 123456,
      randomIndex: () => 0,
    });
    manager.createRoom("host", "十");
    const joined = manager.joinRoom("old-socket", "123456", "재접속");
    manager.disconnect("old-socket");
    const restored = manager.joinRoom("new-socket", "123456", "무시됨", joined.reconnectToken);
    expect(restored).toMatchObject({ playerId: joined.playerId, nickname: "재접속", reconnected: true });
    expect(restored.snapshot.players).toHaveLength(1);
  });

  it("restores an empty active turn when the only student reconnects", () => {
    const manager = new RoomManager({
      resultStore: new MemoryResultStore(),
      roomCodeNumber: () => 123456,
      randomIndex: () => 0,
    });
    manager.createRoom("host", "十");
    const joined = manager.joinRoom("old-socket", "123456", "단독 학생");
    manager.startGame("host", "123456");
    manager.disconnect("old-socket");
    expect(manager.getSnapshot("123456").selectedPlayerId).toBeNull();

    const restored = manager.joinRoom("new-socket", "123456", "무시됨", joined.reconnectToken);
    expect(restored.snapshot.selectedPlayerId).toBe(joined.playerId);
    expect(manager.getCurrentTurn("123456")?.selectedPlayerId).toBe(joined.playerId);
  });

  it("assigns stroke turns in shuffled rounds across multiple Hanja", async () => {
    const manager = new RoomManager({
      resultStore: new MemoryResultStore(),
      roomCodeNumber: () => 123456,
      randomIndex: () => 0,
    });
    manager.createRoom("host", ["水", "木"]);
    const players = [
      manager.joinRoom("socket-a", "123456", "가람"),
      manager.joinRoom("socket-b", "123456", "나래"),
      manager.joinRoom("socket-c", "123456", "다온"),
    ];
    const socketByPlayerId = new Map(players.map((player, index) => [player.playerId, `socket-${"abc"[index]}`]));
    manager.startGame("host", "123456");

    const assigned: string[] = [];
    for (let strokeNumber = 0; strokeNumber < 8; strokeNumber += 1) {
      const snapshot = manager.getSnapshot("123456");
      const selectedPlayerId = snapshot.selectedPlayerId!;
      assigned.push(selectedPlayerId);
      const socketId = socketByPlayerId.get(selectedPlayerId)!;
      const stroke = snapshot.character.strokeData[snapshot.currentStrokeIndex]!;
      const outcome = await manager.attemptStroke(socketId, "123456", stroke.median);
      expect(outcome.result.correct).toBe(true);
    }

    expect(new Set(assigned.slice(0, 3))).toEqual(new Set(players.map((player) => player.playerId)));
    expect(new Set(assigned.slice(3, 6))).toEqual(new Set(players.map((player) => player.playerId)));
    expect(assigned.every((playerId, index) => index === 0 || playerId !== assigned[index - 1])).toBe(true);
    expect(manager.getSnapshot("123456").status).toBe("finished");
  });

  it("uses the teacher-selected stroke deadline and advances without changing the stroke", async () => {
    let now = 1_000;
    const manager = new RoomManager({
      resultStore: new MemoryResultStore(),
      now: () => now,
      roomCodeNumber: () => 123456,
      randomIndex: () => 0,
    });
    manager.createRoom("host", "十", undefined, undefined, "stroke_battle", undefined, 5);
    manager.joinRoom("socket-a", "123456", "가람");
    manager.joinRoom("socket-b", "123456", "나래");
    const started = manager.startGame("host", "123456");
    expect(started.turn).toMatchObject({ durationSeconds: 5, turnStartedAt: 1_000, turnEndsAt: 6_000 });
    expect(started.snapshot).toMatchObject({ strokeTurnDurationSeconds: 5, strokeTurnStartedAt: 1_000, strokeTurnEndsAt: 6_000 });

    const firstPlayerId = started.turn!.selectedPlayerId;
    now = 5_999;
    expect(manager.expireStrokeTurn("123456", firstPlayerId, 6_000)).toBeUndefined();
    now = 6_000;
    const expired = manager.expireStrokeTurn("123456", firstPlayerId, 6_000);
    expect(expired?.nextTurn.selectedPlayerId).not.toBe(firstPlayerId);
    expect(expired?.snapshot).toMatchObject({ currentStrokeIndex: 0, status: "in_progress" });
    expect(expired!.nextTurn.turnEndsAt).toBe(11_000);

    const nextSocket = expired!.snapshot.players.find((player) => player.id === expired!.nextTurn.selectedPlayerId)?.nickname === "가람"
      ? "socket-a"
      : "socket-b";
    const stroke = expired!.snapshot.character.strokeData[0]!;
    const result = await manager.attemptStroke(nextSocket, "123456", stroke.median);
    expect(result.result).toMatchObject({ correct: true, playerId: expired!.nextTurn.selectedPlayerId });
  });

  it("rejects an out-of-range stroke deadline", () => {
    const manager = new RoomManager({ resultStore: new MemoryResultStore(), roomCodeNumber: () => 123456 });
    expect(() => manager.createRoom("host", "十", undefined, undefined, "stroke_battle", undefined, 2)).toThrow("3~30초");
  });
});

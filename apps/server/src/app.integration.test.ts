import type { AddressInfo } from "node:net";
import type { Socket } from "socket.io-client";
import { io as createClient } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Ack,
  ClientToServerEvents,
  PlayerJoinPayload,
  RoomCreatedPayload,
  ServerToClientEvents,
  TeacherCharacterPreferencesResponse,
} from "@hanja/contracts";
import { createHanjaServer } from "./app.js";
import { MemoryResultStore } from "./result-store.js";
import { RoomManager } from "./room-manager.js";
import { TeacherAuthError, type TeacherAuthVerifier } from "./teacher-auth.js";
import { MemoryTeacherPreferencesStore } from "./teacher-preferences.js";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe("Socket.IO game flow", () => {
  const clients: ClientSocket[] = [];
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let resultStore: MemoryResultStore;
  let manager: RoomManager;
  let teacherPreferencesStore: MemoryTeacherPreferencesStore;
  let serverIo: ReturnType<typeof createHanjaServer>["io"];

  beforeEach(async () => {
    resultStore = new MemoryResultStore();
    manager = new RoomManager({
      resultStore,
      roomCodeNumber: () => 123456,
      randomIndex: () => 0,
    });
    teacherPreferencesStore = new MemoryTeacherPreferencesStore();
    const teacherAuthVerifier: TeacherAuthVerifier = {
      async verify(accessToken) {
        if (accessToken !== "teacher-token") throw new TeacherAuthError();
        return { id: "teacher-1", email: "teacher@example.com" };
      },
    };
    const server = createHanjaServer({
      manager,
      teacherAuthVerifier,
      teacherPreferencesStore,
      startCountdownMs: 0,
    });
    serverIo = server.io;
    await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
    const address = server.httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = async () => {
      await new Promise<void>((resolve) => server.io.close(() => resolve()));
      if (server.httpServer.listening) {
        await new Promise<void>((resolve, reject) =>
          server.httpServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    };
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    await closeServer();
  });

  async function connect(accessToken?: string, transports = ["websocket"]): Promise<ClientSocket> {
    const socket: ClientSocket = createClient(baseUrl, {
      transports,
      forceNew: true,
      auth: accessToken ? { accessToken } : undefined,
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return socket;
  }

  function emitAck<T>(emit: (ack: (result: Ack<T>) => void) => void): Promise<Ack<T>> {
    return new Promise((resolve) => emit(resolve));
  }

  function waitForEvent(socket: ClientSocket, event: string, timeoutMs = 2_000): Promise<void> {
    const eventSocket = socket as unknown as {
      once(name: string, listener: () => void): void;
      off(name: string, listener: () => void): void;
    };
    return new Promise((resolve, reject) => {
      const onEvent = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        eventSocket.off(event, onEvent);
        reject(new Error(`Timed out waiting for ${event}`));
      }, timeoutMs);
      eventSocket.once(event, onEvent);
    });
  }

  it("runs 30 independent worms over sockets and closes student rooms cleanly", async () => {
    const host = await connect("teacher-token");
    const created = await emitAck<RoomCreatedPayload>((ack) => host.emit("host:create-room", { character: "木", gameMode: "hanja_worm" }, ack));
    expect(created.ok).toBe(true);
    const students = await Promise.all(Array.from({ length: 30 }, () => connect()));
    const joined = await Promise.all(students.map((s, i) => emitAck<PlayerJoinPayload>((ack) => s.emit("player:join", { roomCode: "123456", nickname: `한지${i}` }, ack))));
    expect(joined.every((r) => r.ok)).toBe(true);
    const scoreUpdates: { at: number; payload: Parameters<ServerToClientEvents["room:scores"]>[0] }[] = [];
    students[29]!.on("room:scores", (payload) => scoreUpdates.push({ at: performance.now(), payload }));
    await emitAck((ack) => host.emit("host:start-game", { roomCode: "123456" }, ack));
    const finished = Promise.all([host, ...students].map((s) => waitForEvent(s, "game:finished", 10000)));
    const targets = manager.getSnapshot("123456").character.strokeData.flatMap((s) => [s.startPoint, s.endPoint]);
    for (const [targetIndex, point] of targets.entries()) {
      const results = await Promise.all(students.map((s) => emitAck((ack) => s.emit("player:worm-target", { roomCode: "123456", characterIndex: 0, targetIndex, point }, ack))));
      expect(results.every((r) => r.ok)).toBe(true);
      if (targetIndex === 1) {
        await expect.poll(() => scoreUpdates.at(-1)?.payload.scores.every((p) => p.score === 10)).toBe(true);
        expect(scoreUpdates.at(-1)!.payload.scores).toHaveLength(30);
        expect(Object.keys(scoreUpdates.at(-1)!.payload).sort()).toEqual(["roomCode", "scores"]);
        expect(Object.keys(scoreUpdates.at(-1)!.payload.scores[0]!).sort()).toEqual(["playerId", "score"]);
        expect(Buffer.byteLength(JSON.stringify(scoreUpdates.at(-1)!.payload))).toBeLessThan(2_200);
        expect(scoreUpdates.length).toBeLessThanOrEqual(2);
      }
    }
    await finished;
    expect(manager.getSnapshot("123456").players.every((p) => p.score === 40)).toBe(true);
    const closed = Promise.all(students.map((s) => waitForEvent(s, "room:closed")));
    await emitAck((ack) => host.emit("host:close-room", { roomCode: "123456" }, ack));
    await closed;
    const countAfterClose = scoreUpdates.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(scoreUpdates).toHaveLength(countAfterClose);
  });

  it("serves catalog verification status without making unverified data playable", async () => {
    const response = await fetch(`${baseUrl}/api/character-catalog?q=${encodeURIComponent("木龍龘")}`);
    expect(response.status).toBe(200);
    const catalog = (await response.json()) as {
      availableDataCount: number;
      entries: Array<{ char: string; status: string }>;
    };
    expect(catalog.availableDataCount).toBeGreaterThan(9_000);
    expect(catalog.entries).toEqual([
      expect.objectContaining({ char: "木", status: "verified" }),
      expect.objectContaining({ char: "龍", status: "available_unverified" }),
      expect.objectContaining({ char: "龘", status: "unavailable" }),
    ]);

    const host = await connect("teacher-token");
    const unverified = await emitAck((ack) =>
      host.emit("host:create-room", { character: "龍" }, ack),
    );
    expect(unverified).toMatchObject({ ok: false, error: { code: "UNKNOWN_CHARACTER" } });

    const unauthorizedPreferences = await fetch(`${baseUrl}/api/teacher/preferences`);
    expect(unauthorizedPreferences.status).toBe(401);
    const preview = await fetch(
      `${baseUrl}/api/character-catalog/${encodeURIComponent("龍")}`,
    );
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      suggestedLabel: expect.stringContaining("용"),
    });
    const emptyFolderSave = await fetch(`${baseUrl}/api/teacher/preferences`, {
      method: "PUT",
      headers: {
        authorization: "Bearer teacher-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        activeFolderId: "custom",
        folders: [
          { id: "default", name: "기본 한자", orderedChars: ["木"] },
          { id: "custom", name: "나만의 한자", orderedChars: [] },
        ],
      }),
    });
    expect(emptyFolderSave.status).toBe(200);
    await expect(emptyFolderSave.json()).resolves.toMatchObject({
      characters: [],
      preferences: {
        activeFolderId: "custom",
        folders: expect.arrayContaining([
          expect.objectContaining({ id: "custom", orderedChars: [] }),
        ]),
      },
    });

    const approval = await fetch(`${baseUrl}/api/teacher/character-approvals`, {
      method: "POST",
      headers: {
        authorization: "Bearer teacher-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ char: "龍", folderId: "custom" }),
    });
    expect(approval.status).toBe(200);
    await expect(approval.json()).resolves.toMatchObject({
      preferences: {
        activeFolderId: "custom",
        folders: expect.arrayContaining([
          expect.objectContaining({ id: "custom", orderedChars: ["龍"] }),
        ]),
      },
    });
    const approvedRoom = await emitAck((ack) =>
      host.emit("host:create-room", { character: "龍" }, ack),
    );
    expect(approvedRoom).toMatchObject({
      ok: true,
      data: { snapshot: { character: { char: "龍", strokeData: expect.any(Array) } } },
    });
  });

  it("runs create, join, authorization, scoring, finish, and anonymous persistence", async () => {
    const host = await connect("teacher-token");
    const created = await emitAck<RoomCreatedPayload>((ack) =>
      host.emit("host:create-room", { character: "十" }, ack),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const firstMedian = created.data.snapshot.character.strokeData[0]!.median!;
    const secondMedian = created.data.snapshot.character.strokeData[1]!.median!;

    const first = await connect();
    const second = await connect();
    const joinedFirst = await emitAck<PlayerJoinPayload>((ack) =>
      first.emit("player:join", { roomCode: "123456", nickname: "민지" }, ack),
    );
    const joinedSecond = await emitAck<PlayerJoinPayload>((ack) =>
      second.emit("player:join", { roomCode: "123456", nickname: "민지" }, ack),
    );
    expect(joinedFirst.ok && joinedFirst.data.nickname).toBe("민지");
    expect(joinedSecond.ok && joinedSecond.data.nickname).toBe("민지_2");

    const started = await emitAck((ack) => host.emit("host:start-game", { roomCode: "123456" }, ack));
    expect(started.ok).toBe(true);
    if (!started.ok || !joinedFirst.ok || !joinedSecond.ok) return;
    const firstIsSelected = started.data.snapshot.selectedPlayerId === joinedFirst.data.playerId;
    const selectedClient = firstIsSelected ? first : second;
    const waitingClient = firstIsSelected ? second : first;

    const unauthorized = await emitAck((ack) =>
      waitingClient.emit(
        "player:stroke-attempt",
        { roomCode: "123456", points: firstMedian },
        ack,
      ),
    );
    expect(unauthorized).toMatchObject({ ok: false, error: { code: "NOT_YOUR_TURN" } });

    const firstStroke = await emitAck((ack) =>
      selectedClient.emit(
        "player:stroke-attempt",
        { roomCode: "123456", points: firstMedian },
        ack,
      ),
    );
    expect(firstStroke).toMatchObject({ ok: true, data: { correct: true, scoreDelta: 10 } });

    const finish = await emitAck((ack) =>
      waitingClient.emit(
        "player:stroke-attempt",
        { roomCode: "123456", points: secondMedian },
        ack,
      ),
    );
    expect(finish).toMatchObject({ ok: true, data: { correct: true, strokeIndex: 1 } });
    expect(resultStore.results).toMatchObject([
      {
        character: "十",
        playerCount: 2,
        scores: [{ rank: 1, score: 10 }, { rank: 1, score: 10 }],
        completedAt: expect.any(String),
      },
    ]);
    expect(resultStore.results[0]?.teacherId).toBe("teacher-1");
    expect((await fetch(`${baseUrl}/api/teacher/results?gameMode=stroke_battle`)).status).toBe(401);
    const saved = await fetch(`${baseUrl}/api/teacher/results?gameMode=stroke_battle`, { headers: { authorization: "Bearer teacher-token" } });
    expect(saved.status).toBe(200);
    expect((await saved.json()).results).toHaveLength(1);
  });

  it("finishes the final stroke even when anonymous persistence fails", async () => {
    resultStore.save = async () => {
      throw new Error("persist failed");
    };

    const host = await connect("teacher-token");
    const created = await emitAck<RoomCreatedPayload>((ack) =>
      host.emit("host:create-room", { character: "\u5341" }, ack),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const firstMedian = created.data.snapshot.character.strokeData[0]!.median!;
    const secondMedian = created.data.snapshot.character.strokeData[1]!.median!;
    const first = await connect();
    const joined = await emitAck<PlayerJoinPayload>((ack) =>
      first.emit("player:join", { roomCode: "123456", nickname: "student" }, ack),
    );
    expect(joined.ok).toBe(true);
    const started = await emitAck((ack) => host.emit("host:start-game", { roomCode: "123456" }, ack));
    expect(started.ok).toBe(true);

    const firstStroke = await emitAck((ack) =>
      first.emit("player:stroke-attempt", { roomCode: "123456", points: firstMedian }, ack),
    );
    expect(firstStroke).toMatchObject({ ok: true, data: { correct: true, scoreDelta: 10 } });

    const finished = waitForEvent(first, "game:finished");
    const finalStroke = await emitAck((ack) =>
      first.emit("player:stroke-attempt", { roomCode: "123456", points: secondMedian }, ack),
    );
    expect(finalStroke).toMatchObject({ ok: true, data: { correct: true, strokeIndex: 1 } });
    await finished;
    expect(manager.getSnapshot("123456")).toMatchObject({ status: "finished" });
  });

  it("creates and starts the meaning/sound quiz mode with explicit question intent", async () => {
    const host = await connect("teacher-token");
    const created = await emitAck<RoomCreatedPayload>((ack) =>
      host.emit("host:create-room", { character: "\u5341", gameMode: "meaning_sound_quiz" }, ack),
    );
    expect(created).toMatchObject({
      ok: true,
      data: { snapshot: { gameMode: "meaning_sound_quiz" } },
    });

    const player = await connect();
    await emitAck<PlayerJoinPayload>((ack) =>
      player.emit("player:join", { roomCode: "123456", nickname: "quiz" }, ack),
    );
    const started = await emitAck((ack) => host.emit("host:start-game", { roomCode: "123456" }, ack));
    expect(started).toMatchObject({
      ok: true,
      data: {
        snapshot: {
          gameMode: "meaning_sound_quiz",
          quiz: expect.objectContaining({
            promptChar: "\u5341",
            questionType: "hanja_choice",
            totalQuestions: 1,
            phase: "question",
            choices: expect.arrayContaining([
              expect.objectContaining({ char: "十", label: "十" }),
            ]),
          }),
        },
      },
    });
  });

  it("persists a teacher quiz pool and uses its edited natural-language labels", async () => {
    const saveResponse = await fetch(`${baseUrl}/api/teacher/preferences`, {
      method: "PUT",
      headers: { authorization: "Bearer teacher-token", "content-type": "application/json" },
      body: JSON.stringify({
        quizPools: [{
          id: "lesson-one",
          name: "1단원 문제풀",
          items: [
            { char: "不", meaning: "아니다", reading: "부" },
            { char: "人", meaning: "사람", reading: "인" },
          ],
        }],
      }),
    });
    expect(saveResponse.status).toBe(200);
    const saved = await saveResponse.json() as TeacherCharacterPreferencesResponse;
    expect(saved.preferences.quizPools[0]?.items[0]).toEqual({ char: "不", meaning: "아니다", reading: "부" });

    const host = await connect("teacher-token");
    const created = await emitAck<RoomCreatedPayload>((ack) => host.emit("host:create-room", {
      character: "不",
      characters: ["不", "人"],
      gameMode: "meaning_sound_quiz",
      quizPoolId: "lesson-one",
    }, ack));
    expect(created).toMatchObject({ ok: true, data: { snapshot: { characters: [{ char: "不", label: "아니다 부" }, { char: "人", label: "사람 인" }] } } });
  });

  it("allows one retry for an incorrect quiz answer before revealing", async () => {
    const host = await connect("teacher-token");
    const created = await emitAck<RoomCreatedPayload>((ack) =>
      host.emit("host:create-room", { character: "\u5341", gameMode: "meaning_sound_quiz" }, ack),
    );
    expect(created.ok).toBe(true);

    const player = await connect();
    const joined = await emitAck<PlayerJoinPayload>((ack) =>
      player.emit("player:join", { roomCode: "123456", nickname: "quiz" }, ack),
    );
    expect(joined.ok).toBe(true);
    const started = await emitAck((ack) => host.emit("host:start-game", { roomCode: "123456" }, ack));
    expect(started.ok).toBe(true);

    const snapshot = manager.getSnapshot("123456");
    const wrongChoice = snapshot.quiz?.choices.find((choice) => choice.char !== "十");
    const correctChoice = snapshot.quiz?.choices.find((choice) => choice.char === "十");
    expect(wrongChoice).toBeDefined();
    expect(correctChoice).toBeDefined();
    const wrong = await emitAck((ack) =>
      player.emit("player:quiz-answer", { roomCode: "123456", choiceId: wrongChoice!.id }, ack),
    );
    expect(wrong).toMatchObject({
      ok: true,
      data: { correct: false, scoreDelta: 0, attemptNumber: 1 },
    });
    expect(manager.getSnapshot("123456").quiz?.phase).toBe("question");

    const correct = await emitAck((ack) =>
      player.emit("player:quiz-answer", { roomCode: "123456", choiceId: correctChoice!.id }, ack),
    );
    expect(correct).toMatchObject({
      ok: true,
      data: { correct: true, scoreDelta: 30, attemptNumber: 2 },
    });
    expect(manager.getSnapshot("123456").quiz?.phase).toBe("revealed");
  });

  it("sends independent quiz snapshots while another connected student is still answering", async () => {
    const host = await connect("teacher-token");
    await emitAck((ack) => host.emit("host:create-room", { characters: ["十", "人"], gameMode: "meaning_sound_quiz" }, ack));
    const first = await connect();
    const second = await connect();
    let firstIndex = -1;
    let secondIndex = -1;
    first.on("room:snapshot", (snapshot) => { firstIndex = snapshot.quiz?.questionIndex ?? -1; });
    second.on("room:snapshot", (snapshot) => { secondIndex = snapshot.quiz?.questionIndex ?? -1; });
    await emitAck((ack) => first.emit("player:join", { roomCode: "123456", nickname: "first" }, ack));
    await emitAck((ack) => second.emit("player:join", { roomCode: "123456", nickname: "second" }, ack));
    await emitAck((ack) => host.emit("host:start-game", { roomCode: "123456" }, ack));
    const firstQuiz = manager.getSnapshot("123456").quiz!;
    const scoresSeenBySecond: Parameters<ServerToClientEvents["room:scores"]>[0][] = [];
    second.on("room:scores", (payload) => scoresSeenBySecond.push(payload));
    const correctLabel = firstQuiz.questionType === "hanja_choice"
      ? firstQuiz.promptChar
      : firstQuiz.questionType.startsWith("reading")
      ? ({ "十": "십", "人": "인" } as Record<string, string>)[firstQuiz.promptChar]
      : ({ "十": "열", "人": "사람" } as Record<string, string>)[firstQuiz.promptChar];
    const choice = firstQuiz.choices.find((item) => item.label === correctLabel)!;
    await emitAck((ack) => first.emit("player:quiz-answer", { roomCode: "123456", choiceId: choice.id }, ack));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(scoresSeenBySecond.at(-1)?.scores.some((player) => player.score > 0)).toBe(true);
    expect(firstIndex).toBe(1);
    expect(secondIndex).toBe(0);
    expect(manager.getSnapshot("123456").quizProgress?.map((progress) => progress.questionIndex)).toEqual([1, 0]);
  });

  it("rejects the removed card matching mode instead of silently opening another game", async () => {
    const host = await connect("teacher-token");
    const created = await emitAck<RoomCreatedPayload>((ack) =>
      host.emit("host:create-room", { character: "十", gameMode: "card_match" as never }, ack),
    );
    expect(created).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });
  });

  it("reassigns an incorrect stroke and immediately reassigns a disconnected turn", async () => {
    const host = await connect("teacher-token");
    await emitAck((ack) => host.emit("host:create-room", { character: "十" }, ack));
    const first = await connect();
    const second = await connect();
    const firstJoin = await emitAck<PlayerJoinPayload>((ack) =>
      first.emit("player:join", { roomCode: "123456", nickname: "가" }, ack),
    );
    const secondJoin = await emitAck<PlayerJoinPayload>((ack) =>
      second.emit("player:join", { roomCode: "123456", nickname: "나" }, ack),
    );
    const started = await emitAck((ack) => host.emit("host:start-game", { roomCode: "123456" }, ack));
    if (!firstJoin.ok || !secondJoin.ok) return;
    if (!started.ok) return;
    const firstIsSelected = started.data.snapshot.selectedPlayerId === firstJoin.data.playerId;
    const selectedClient = firstIsSelected ? first : second;
    const nextClient = firstIsSelected ? second : first;
    const selectedJoin = firstIsSelected ? firstJoin.data : secondJoin.data;

    const wrong = await emitAck((ack) =>
      selectedClient.emit(
        "player:stroke-attempt",
        { roomCode: "123456", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        ack,
      ),
    );
    expect(wrong).toMatchObject({ ok: true, data: { correct: false, scoreDelta: 0 } });

    nextClient.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.getSnapshot("123456").selectedPlayerId).toBe(selectedJoin.playerId);
  });

  it("does not interrupt an active stroke when an observer rejoins and drops congested previews", async () => {
    const host = await connect("teacher-token");
    await emitAck((ack) => host.emit("host:create-room", { character: "木" }, ack));
    const students = await Promise.all([connect(), connect()]);
    const joins = await Promise.all(students.map((student, index) => emitAck<PlayerJoinPayload>((ack) =>
      student.emit("player:join", { roomCode: "123456", nickname: `검증${index}` }, ack))));
    const initialTurns = students.map((student) => waitForEvent(student, "stroke:turn"));
    await emitAck((ack) => host.emit("host:start-game", { roomCode: "123456" }, ack));
    await Promise.all(initialTurns);
    const turn = manager.getCurrentTurn("123456")!;
    const selectedIndex = joins.findIndex((join) => join.ok && join.data.playerId === turn.selectedPlayerId);
    const selected = students[selectedIndex]!;
    const observer = students[1 - selectedIndex]!;
    let turns = 0;
    selected.on("stroke:turn", () => turns++);
    await emitAck((ack) => observer.emit("player:join", { roomCode: "123456", nickname: "재시도" }, ack));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turns).toBe(0);
    expect(manager.getCurrentTurn("123456")).toEqual(turn);
    expect(manager.getSnapshot("123456").players).toHaveLength(2);

    const transport = serverIo.sockets.sockets.get(observer.id!)!.conn.transport;
    transport.writable = false;
    let received = 0;
    observer.on("stroke:progress", () => received++);
    const payload = { roomCode: "123456", strokeIndex: 0, sequence: 0, phase: "move" as const,
      points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }], replace: true };
    const relayed = waitForEvent(host, "stroke:progress");
    selected.emit("player:stroke-progress", payload);
    await relayed;
    expect(received).toBe(0);
    transport.writable = true;
    const repaired = new Promise<void>((resolve) => observer.once("stroke:progress", (preview) => {
      expect(preview).toMatchObject({ points: payload.points, replace: true, sequence: 1 });
      resolve();
    }));
    selected.emit("player:stroke-progress", { ...payload, sequence: 1 });
    await repaired;
    const result = waitForEvent(observer, "stroke:result");
    await emitAck((ack) => selected.emit("player:stroke-attempt", {
      roomCode: "123456", points: turn.nextStroke.median!,
    }, ack));
    await result;
    expect(manager.getSnapshot("123456").currentStrokeIndex).toBe(1);
  });

  it.each(["websocket", "polling"])("runs a full game for 30 %s clients within the one-second state target", async (transport) => {
    const host = await connect("teacher-token");
    const created = await emitAck<RoomCreatedPayload>((ack) =>
      host.emit("host:create-room", { character: "木" }, ack),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const players = await Promise.all(Array.from({ length: 30 }, () => connect(undefined, [transport])));
    let redundantJoinSnapshots = 0;
    const countJoinSnapshot = () => { redundantJoinSnapshots += 1; };
    for (const player of players) player.on("room:snapshot", countJoinSnapshot);
    const joinStartedAt = performance.now();
    const individualJoinLatencies: number[] = [];
    const joins = await Promise.all(
      players.map(async (player, index) => {
        const individualStartedAt = performance.now();
        const joined = await emitAck<PlayerJoinPayload>((ack) =>
          player.emit(
            "player:join",
            { roomCode: "123456", nickname: `학생${index + 1}` },
            ack,
          ));
        individualJoinLatencies.push(performance.now() - individualStartedAt);
        return joined;
      }),
    );
    const joinElapsedMs = performance.now() - joinStartedAt;
    expect(joins.every((join) => join.ok)).toBe(true);
    expect(joinElapsedMs).toBeLessThan(1_000);
    expect(Math.max(...individualJoinLatencies)).toBeLessThan(1_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(redundantJoinSnapshots).toBe(0);
    for (const player of players) player.off("room:snapshot", countJoinSnapshot);

    const extra = await connect();
    const rejected = await emitAck<PlayerJoinPayload>((ack) =>
      extra.emit("player:join", { roomCode: "123456", nickname: "31번째" }, ack),
    );
    expect(rejected).toMatchObject({ ok: false, error: { code: "ROOM_FULL" } });

    const received = players.map(
      (player) => new Promise<void>((resolve) => player.once("game:started", () => resolve())),
    );
    const startedAt = performance.now();
    const started = await emitAck((ack) => host.emit("host:start-game", { roomCode: "123456" }, ack));
    expect(started.ok).toBe(true);
    await Promise.all(received);
    const startElapsedMs = performance.now() - startedAt;
    expect(startElapsedMs).toBeLessThan(1_000);

    const playerById = new Map<string, ClientSocket>();
    joins.forEach((join, index) => {
      if (join.ok) playerById.set(join.data.playerId, players[index]!);
    });
    const strokeLatencies: number[] = [];
    const gameStartedAt = performance.now();

    for (
      let strokeIndex = 0;
      strokeIndex < created.data.snapshot.character.strokeData.length;
      strokeIndex += 1
    ) {
      const turn = manager.getCurrentTurn("123456");
      expect(turn?.strokeIndex).toBe(strokeIndex);
      const selected = turn ? playerById.get(turn.selectedPlayerId) : undefined;
      expect(selected).toBeDefined();
      if (!selected) return;

      const resultEvents = players.map((player) => waitForEvent(player, "stroke:result"));
      const snapshotEvents = players.map((player) => waitForEvent(player, "room:snapshot"));
      const terminalEvent =
        strokeIndex === created.data.snapshot.character.strokeData.length - 1
          ? "game:finished"
          : "stroke:turn";
      const terminalEvents = players.map((player) => waitForEvent(player, terminalEvent));
      const attemptedAt = performance.now();
      const attempted = await emitAck((ack) =>
        selected.emit(
          "player:stroke-attempt",
          {
            roomCode: "123456",
            points: created.data.snapshot.character.strokeData[strokeIndex]!.median!,
          },
          ack,
        ),
      );
      expect(attempted).toMatchObject({
        ok: true,
        data: { correct: true, playerId: turn!.selectedPlayerId, scoreDelta: 10, strokeIndex },
      });
      await Promise.all([...resultEvents, ...snapshotEvents, ...terminalEvents]);
      const elapsed = performance.now() - attemptedAt;
      strokeLatencies.push(elapsed);
      expect(elapsed).toBeLessThan(1_000);
    }

    const gameElapsedMs = performance.now() - gameStartedAt;
    const finalSnapshot = manager.getSnapshot("123456");
    expect(finalSnapshot).toMatchObject({ status: "finished", currentStrokeIndex: 4 });
    expect(finalSnapshot.players).toHaveLength(30);
    expect(new Set(finalSnapshot.players.map((player) => player.id)).size).toBe(30);
    expect(finalSnapshot.players.reduce((total, player) => total + player.score, 0)).toBe(40);
    expect(resultStore.results).toHaveLength(1);
    expect(resultStore.results[0]).toMatchObject({ character: "木", playerCount: 30 });
    expect(resultStore.results[0]?.scores[0]?.nickname).toBeTruthy();

    console.info(
      `[local-load] ${JSON.stringify({
        clients: 30,
        transport,
        joinMs: Number(joinElapsedMs.toFixed(1)),
        maxJoinAckMs: Number(Math.max(...individualJoinLatencies).toFixed(1)),
        redundantJoinSnapshots,
        startMs: Number(startElapsedMs.toFixed(1)),
        strokeMs: strokeLatencies.map((value) => Number(value.toFixed(1))),
        fullGameMs: Number(gameElapsedMs.toFixed(1)),
      })}`,
    );
  });
});

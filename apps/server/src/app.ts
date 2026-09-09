import { createServer, type Server as HttpServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import type { CorsOptions } from "cors";
import type {
  ClientToServerEvents,
  CommandError,
  GameCountdownPayload,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
  StrokeTurnPayload,
  TeacherCharacterFolder,
  TeacherQuizPool,
} from "@hanja/contracts";
import { GameError } from "./domain.js";
import {
  isSystemVerifiedCharacter,
  koreanLabelFor,
  loadCatalogCharacter,
  searchCharacterCatalog,
} from "./character-catalog.js";
import { createResultStore, type ResultStore } from "./result-store.js";
import { RoomManager } from "./room-manager.js";
import {
  bearerToken,
  createTeacherAuthVerifier,
  TeacherAuthError,
  type TeacherAuthVerifier,
} from "./teacher-auth.js";
import {
  createTeacherPreferencesStore,
  resolveTeacherCharacters,
  type TeacherPreferencesStore,
} from "./teacher-preferences.js";

interface AppOptions {
  webOrigin?: string;
  resultStore?: ResultStore;
  manager?: RoomManager;
  teacherAuthVerifier?: TeacherAuthVerifier;
  teacherPreferencesStore?: TeacherPreferencesStore;
  startCountdownMs?: number;
  gameIntroMs?: number;
}

interface JoinWindow {
  count: number;
  resetAt: number;
}

interface ProgressWindow {
  count: number;
  resetAt: number;
}

function createCorsOptions(webOrigin: string): CorsOptions {
  const allowedOrigins = new Set([
    webOrigin,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);
  return {
    credentials: true,
    origin(origin, callback) {
      if (
        !origin ||
        allowedOrigins.has(origin) ||
        /^https:\/\/[-a-z0-9]+(?:-[a-z0-9]+)*\.vercel\.app$/i.test(origin)
      ) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin not allowed by CORS"));
    },
  };
}

function commandError(error: unknown): CommandError {
  if (error instanceof GameError) return { code: error.code, message: error.message };
  console.error(error);
  return { code: "INTERNAL_ERROR", message: "서버 처리 중 오류가 발생했습니다." };
}

export function createHanjaServer(options: AppOptions = {}): {
  app: express.Express;
  httpServer: HttpServer;
  io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
  manager: RoomManager;
} {
  const webOrigin = options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const app = express();
  const corsOptions = createCorsOptions(webOrigin);
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "256kb" }));
  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    httpServer,
    { cors: corsOptions, maxHttpBufferSize: 512_000 },
  );
  const manager =
    options.manager ??
    new RoomManager({ resultStore: options.resultStore ?? createResultStore(), webOrigin });
  const joinWindows = new Map<string, JoinWindow>();
  const progressWindows = new Map<string, ProgressWindow>();
  const quizTimers = new Map<string, ReturnType<typeof setInterval>>();
  const gameCountdownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const gameCountdownSchedules = new Map<string, GameCountdownPayload>();
  const strokeTurnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scoreTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastScores = new Map<string, string>();
  const startCountdownMs = options.startCountdownMs ?? 3_000;
  const gameIntroMs = startCountdownMs > 0 ? options.gameIntroMs ?? 8_000 : 0;
  const readyLeadInMs = startCountdownMs > 0 ? 1_500 : 0;
  httpServer.on("close", () => {
    for (const timer of quizTimers.values()) clearInterval(timer);
    for (const timer of gameCountdownTimers.values()) clearTimeout(timer);
    for (const timer of strokeTurnTimers.values()) clearTimeout(timer);
    for (const timer of scoreTimers.values()) clearTimeout(timer);
  });
  const teacherAuthVerifier = options.teacherAuthVerifier ?? createTeacherAuthVerifier();
  const teacherPreferencesStore =
    options.teacherPreferencesStore ?? createTeacherPreferencesStore();

  function clearQuizTimers(roomCode: string) {
    const timer = quizTimers.get(roomCode);
    if (timer) clearInterval(timer);
    quizTimers.delete(roomCode);
  }

  function clearScoreUpdates(roomCode: string) {
    clearTimeout(scoreTimers.get(roomCode));
    scoreTimers.delete(roomCode);
    lastScores.delete(roomCode);
  }

  function clearCountdownTimer(roomCode: string) {
    const timer = gameCountdownTimers.get(roomCode);
    if (timer) clearTimeout(timer);
    gameCountdownTimers.delete(roomCode);
    gameCountdownSchedules.delete(roomCode);
  }

  function clearStrokeTurnTimer(roomCode: string) {
    const timer = strokeTurnTimers.get(roomCode);
    if (timer) clearTimeout(timer);
    strokeTurnTimers.delete(roomCode);
  }

  function scheduleStrokeTurn(roomCode: string, turn: StrokeTurnPayload) {
    clearStrokeTurnTimer(roomCode);
    const delay = Math.max(0, turn.turnEndsAt - Date.now()) + 20;
    const timer = setTimeout(() => {
      if (strokeTurnTimers.get(roomCode) !== timer) return;
      strokeTurnTimers.delete(roomCode);
      try {
        const outcome = manager.expireStrokeTurn(roomCode, turn.selectedPlayerId, turn.turnEndsAt);
        if (!outcome) return;
        io.to(roomCode).emit("stroke:turn", outcome.nextTurn);
        scheduleStrokeTurn(roomCode, outcome.nextTurn);
      } catch (error) {
        io.to(roomCode).emit("room:error", commandError(error));
      }
    }, delay);
    strokeTurnTimers.set(roomCode, timer);
  }

  function broadcastSnapshot(roomCode: string, started = false) {
    const sharedSnapshot = manager.getSnapshot(roomCode);
    if (sharedSnapshot.gameMode === "stroke_battle" || sharedSnapshot.status !== "in_progress") {
      if (started) io.to(roomCode).emit("game:started", { snapshot: sharedSnapshot });
      else io.to(roomCode).emit("room:snapshot", sharedSnapshot);
      return;
    }
    for (const socketId of io.sockets.adapter.rooms.get(roomCode) ?? []) {
      const snapshot = manager.getSnapshotForSocket(roomCode, socketId);
      if (started) io.to(socketId).emit("game:started", { snapshot });
      else io.to(socketId).emit("room:snapshot", snapshot);
    }
  }

  function broadcastHostSnapshot(roomCode: string) {
    const snapshot = manager.getSnapshot(roomCode);
    for (const socketId of io.sockets.adapter.rooms.get(roomCode) ?? []) {
      const client = io.sockets.sockets.get(socketId);
      if (client?.data.role === "host") client.emit("room:snapshot", snapshot);
    }
    // At most four compact score updates/second, independent of answer/target volume.
    // Never send classmates' question snapshots just to update their rank.
    const scores = snapshot.players.map(({ id, score }) => ({ playerId: id, score }));
    const serialized = JSON.stringify(scores);
    if (serialized === lastScores.get(roomCode)) return;
    lastScores.set(roomCode, serialized);
    if (scoreTimers.has(roomCode)) return;
    scoreTimers.set(roomCode, setTimeout(() => {
      scoreTimers.delete(roomCode);
      const latest = lastScores.get(roomCode);
      if (latest) io.to(roomCode).emit("room:scores", { roomCode, scores: JSON.parse(latest) });
    }, 250));
  }

  function tickQuiz(roomCode: string) {
    try {
      const outcome = manager.tickQuiz(roomCode);
      if (!outcome) return;
      broadcastSnapshot(roomCode);
      if (outcome.rankedPlayers) {
        clearQuizTimers(roomCode);
        clearScoreUpdates(roomCode);
        for (const socketId of io.sockets.adapter.rooms.get(roomCode) ?? []) {
          io.to(socketId).emit("game:finished", {
            rankedPlayers: outcome.rankedPlayers,
            snapshot: manager.getSnapshotForSocket(roomCode, socketId),
          });
        }
        return;
      }
    } catch (error) {
      clearQuizTimers(roomCode);
      io.to(roomCode).emit("room:error", commandError(error));
    }
  }

  function startGameNow(hostSocketId: string, roomCode: string) {
    const { snapshot, turn } = manager.startGame(hostSocketId, roomCode);
    broadcastSnapshot(roomCode, true);
    if (turn) {
      io.to(snapshot.roomCode).emit("stroke:turn", turn);
      scheduleStrokeTurn(snapshot.roomCode, turn);
    }
    if (snapshot.gameMode === "meaning_sound_quiz") {
      clearQuizTimers(roomCode);
      // ponytail: one room, at most 30 students; one clock handles their independent deadlines.
      quizTimers.set(roomCode, setInterval(() => tickQuiz(roomCode), 100));
    }
    return snapshot;
  }

  async function authenticateTeacher(authorization: string | undefined) {
    const token = bearerToken(authorization);
    if (!token) throw new TeacherAuthError();
    return teacherAuthVerifier.verify(token);
  }

  function authFailure(response: express.Response, error: unknown) {
    const status = error instanceof TeacherAuthError ? 401 : 500;
    response.status(status).json({
      error: {
        code: error instanceof TeacherAuthError ? "AUTH_REQUIRED" : "INTERNAL_ERROR",
        message:
          error instanceof TeacherAuthError
            ? "교사 로그인이 필요합니다."
            : "서버 처리 중 오류가 발생했습니다.",
      },
    });
  }

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "hanja-realtime-server",
      realtimeContract: "lightweight-snapshots-v1",
      gameModes: ["stroke_battle", "meaning_sound_quiz", "hanja_worm"],
      strokePreview: "replace-v1",
      wormRules: "three-hits-v2",
      resultHistory: true,
      storageAuth: "api-key-v2",
    });
  });
  app.get("/api/characters", (_request, response) => {
    response.json({ characters: manager.listCharacters() });
  });
  app.get("/api/character-catalog", (request, response) => {
    response.json(searchCharacterCatalog(request.query.q));
  });
  app.get("/api/character-catalog/:char", (request, response) => {
    const char = request.params.char?.normalize("NFC") ?? "";
    const character = Array.from(char).length === 1 ? loadCatalogCharacter(char) : undefined;
    if (!character) {
      response.status(404).json({ error: { code: "UNKNOWN_CHARACTER", message: "획 데이터가 없는 한자입니다." } });
      return;
    }
    response.json({
      character,
      suggestedLabel: koreanLabelFor(char),
      systemVerified: isSystemVerifiedCharacter(char),
    });
  });
  app.get("/api/teacher/results", async (request, response) => {
    try {
      const teacher = await authenticateTeacher(request.header("authorization"));
      const mode = request.query.gameMode;
      const offset = Number(request.query.offset ?? 0);
      if (!["stroke_battle", "meaning_sound_quiz", "hanja_worm"].includes(String(mode)) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
        response.status(400).json({ message: "기록 조회 조건을 확인해 주세요." }); return;
      }
      response.setHeader("Cache-Control", "private, no-store");
      response.json(await manager.getHistory(teacher.id, mode as import("@hanja/contracts").GameMode, offset));
    } catch (error) { authFailure(response, error); }
  });
  app.get("/api/teacher/preferences", async (request, response) => {
    try {
      const teacher = await authenticateTeacher(request.header("authorization"));
      const preferences = await teacherPreferencesStore.get(teacher.id);
      response.json(resolveTeacherCharacters(preferences));
    } catch (error) {
      authFailure(response, error);
    }
  });
  app.put("/api/teacher/preferences", async (request, response) => {
    try {
      const teacher = await authenticateTeacher(request.header("authorization"));
      const requestedQuizPools = request.body?.quizPools;
      const requestedFolders = request.body?.folders;
      const requestedActiveFolderId = request.body?.activeFolderId;

      if (requestedQuizPools !== undefined) {
        if (!Array.isArray(requestedQuizPools) || requestedQuizPools.length > 20) {
          throw new GameError("INVALID_PAYLOAD", "퀴즈 문제풀은 최대 20개까지 만들 수 있습니다.");
        }
        const quizPools: TeacherQuizPool[] = requestedQuizPools.map((raw: unknown) => {
          const value = raw && typeof raw === "object"
            ? raw as { id?: unknown; name?: unknown; items?: unknown }
            : {};
          return {
            id: typeof value.id === "string" ? value.id.trim() : "",
            name: typeof value.name === "string" ? value.name.trim() : "",
            items: Array.isArray(value.items) ? value.items.map((item: unknown) => {
              const candidate = item && typeof item === "object"
                ? item as { char?: unknown; meaning?: unknown; reading?: unknown }
                : {};
              return {
                char: typeof candidate.char === "string" ? candidate.char.normalize("NFC") : "",
                meaning: typeof candidate.meaning === "string" ? candidate.meaning.trim() : "",
                reading: typeof candidate.reading === "string" ? candidate.reading.trim() : "",
              };
            }) : [],
          };
        });
        const invalidQuizPool = quizPools.some((pool, poolIndex) =>
          !/^[A-Za-z0-9_-]{1,64}$/.test(pool.id) ||
          pool.name.length < 1 || pool.name.length > 40 ||
          pool.items.length > 20 ||
          new Set(pool.items.map((item) => item.char)).size !== pool.items.length ||
          pool.items.some((item) =>
            Array.from(item.char).length !== 1 ||
            item.meaning.length < 1 || item.meaning.length > 30 ||
            item.reading.length < 1 || item.reading.length > 10 ||
            !loadCatalogCharacter(item.char)
          ) ||
          quizPools.findIndex((candidate) => candidate.id === pool.id) !== poolIndex
        );
        if (invalidQuizPool) {
          throw new GameError("INVALID_PAYLOAD", "문제풀의 이름과 한자·뜻·음을 확인해 주세요.");
        }
        const saved = await teacherPreferencesStore.saveQuizPools(teacher.id, quizPools);
        response.json(resolveTeacherCharacters(saved));
        return;
      }

      if (requestedFolders !== undefined) {
        if (!Array.isArray(requestedFolders) || requestedFolders.length < 1 || requestedFolders.length > 20) {
          throw new GameError("INVALID_PAYLOAD", "한자 폴더는 1~20개로 구성해 주세요.");
        }
        const folders: TeacherCharacterFolder[] = requestedFolders.map((raw: unknown) => {
          const value = raw && typeof raw === "object"
            ? raw as { id?: unknown; name?: unknown; orderedChars?: unknown }
            : {};
          return {
            id: typeof value.id === "string" ? value.id.trim() : "",
            name: typeof value.name === "string" ? value.name.trim() : "",
            orderedChars: Array.isArray(value.orderedChars)
              ? value.orderedChars.filter((char: unknown): char is string => typeof char === "string")
              : [],
          };
        });
        const unverifiedChars = new Set<string>();
        for (const folder of folders) {
          for (const char of folder.orderedChars) {
            if (Array.from(char).length === 1 && !isSystemVerifiedCharacter(char)) unverifiedChars.add(char);
          }
        }
        const approved = new Set<string>();
        if (unverifiedChars.size > 0) {
          const current = await teacherPreferencesStore.get(teacher.id);
          for (const item of current.approvals) approved.add(item.char);
        }
        const folderIds = new Set(folders.map((folder) => folder.id));
        const invalidFolder = folders.some((folder, index) =>
          !/^[A-Za-z0-9_-]{1,64}$/.test(folder.id) ||
          folder.name.length < 1 ||
          folder.name.length > 40 ||
          folder.orderedChars.length > 200 ||
          new Set(folder.orderedChars).size !== folder.orderedChars.length ||
          folder.orderedChars.some((char) =>
            Array.from(char).length !== 1 ||
            (!isSystemVerifiedCharacter(char) && !approved.has(char))
          ) ||
          folders.findIndex((candidate) => candidate.id === folder.id) !== index
        );
        if (
          invalidFolder ||
          typeof requestedActiveFolderId !== "string" ||
          !folderIds.has(requestedActiveFolderId)
        ) {
          throw new GameError("INVALID_PAYLOAD", "폴더 이름과 승인된 한자 구성을 확인해 주세요.");
        }
        const saved = await teacherPreferencesStore.saveFolders(
          teacher.id,
          folders,
          requestedActiveFolderId,
        );
        response.json(resolveTeacherCharacters(saved));
        return;
      }

      const current = await teacherPreferencesStore.get(teacher.id);
      const approved = new Set(current.approvals.map((item) => item.char));
      const requested = request.body?.orderedChars;
      if (!Array.isArray(requested) || requested.length < 1 || requested.length > 200) {
        throw new GameError("INVALID_PAYLOAD", "수업 목록은 1~200자로 구성해 주세요.");
      }
      const orderedChars = [...new Set(requested.filter((char): char is string => typeof char === "string"))];
      if (
        orderedChars.length !== requested.length ||
        orderedChars.some((char) => !isSystemVerifiedCharacter(char) && !approved.has(char))
      ) {
        throw new GameError("INVALID_PAYLOAD", "승인되지 않은 한자가 수업 목록에 포함되어 있습니다.");
      }
      const saved = await teacherPreferencesStore.saveOrder(teacher.id, orderedChars);
      response.json(resolveTeacherCharacters(saved));
    } catch (error) {
      if (error instanceof GameError) response.status(400).json({ error: commandError(error) });
      else authFailure(response, error);
    }
  });
  app.post("/api/teacher/character-approvals", async (request, response) => {
    try {
      const teacher = await authenticateTeacher(request.header("authorization"));
      const char = typeof request.body?.char === "string" ? request.body.char.normalize("NFC") : "";
      const requestedLabel = typeof request.body?.label === "string" ? request.body.label.trim() : "";
      const requestedFolderId = typeof request.body?.folderId === "string"
        ? request.body.folderId.trim()
        : undefined;
      const current = await teacherPreferencesStore.get(teacher.id);
      if (requestedFolderId && !current.folders.some((folder) => folder.id === requestedFolderId)) {
        throw new GameError("INVALID_PAYLOAD", "추가할 한자 폴더를 찾을 수 없습니다.");
      }
      const label = requestedLabel || koreanLabelFor(char) || "";
      if (Array.from(char).length !== 1 || label.length < 1 || label.length > 60) {
        throw new GameError("INVALID_PAYLOAD", "한자와 1~60자의 음·뜻 설명을 입력해 주세요.");
      }
      if (!loadCatalogCharacter(char, label)) {
        throw new GameError("UNKNOWN_CHARACTER", "획 데이터가 없는 한자입니다.");
      }
      const saved = await teacherPreferencesStore.approve(teacher.id, {
        char,
        label,
        approvedAt: new Date().toISOString(),
      }, requestedFolderId);
      response.json(resolveTeacherCharacters(saved));
    } catch (error) {
      if (error instanceof GameError) response.status(400).json({ error: commandError(error) });
      else authFailure(response, error);
    }
  });

  io.use((socket, next) => {
    const token = typeof socket.handshake.auth?.accessToken === "string"
      ? socket.handshake.auth.accessToken
      : undefined;
    if (!token) {
      next();
      return;
    }
    void teacherAuthVerifier.verify(token).then((teacher) => {
      socket.data.teacherId = teacher.id;
      next();
    }).catch(() => next(new Error("AUTH_REQUIRED")));
  });

  io.on("connection", (socket) => {
    socket.on("clock:sync", (ack) => {
      if (typeof ack === "function") ack({ serverNow: Date.now() });
    });
    socket.on("host:create-room", async (payload, ack) => {
      try {
        const teacherId = socket.data.teacherId;
        if (!teacherId) throw new GameError("AUTH_REQUIRED", "교사 로그인이 필요합니다.");
        const preferences = await teacherPreferencesStore.get(teacherId);
        const requestedQuizPool = payload?.gameMode === "meaning_sound_quiz" && typeof payload?.quizPoolId === "string"
          ? preferences.quizPools.find((pool) => pool.id === payload.quizPoolId)
          : undefined;
        if (payload?.gameMode === "meaning_sound_quiz" && payload?.quizPoolId && !requestedQuizPool) {
          throw new GameError("INVALID_PAYLOAD", "선택한 퀴즈 문제풀을 찾을 수 없습니다.");
        }
        if (requestedQuizPool && requestedQuizPool.items.length < 2) {
          throw new GameError("INVALID_PAYLOAD", "스피드 퀴즈 문제풀에는 한자가 2자 이상 필요합니다.");
        }
        const rawCharacters = requestedQuizPool
          ? requestedQuizPool.items.map((item) => item.char)
          : Array.isArray(payload?.characters) && payload.characters.length > 0
            ? payload.characters
            : [payload?.character];
        const chars = [...new Set(rawCharacters.filter((char): char is string => typeof char === "string" && Array.from(char).length === 1))];
        if (chars.length < 1 || chars.length > 20) {
          throw new GameError("INVALID_PAYLOAD", "게임에 넣을 한자는 1~20자로 선택해 주세요.");
        }
        const quizQuestionCount = payload?.gameMode === "meaning_sound_quiz"
          ? payload.quizQuestionCount ?? chars.length
          : undefined;
        if (payload?.gameMode === "meaning_sound_quiz" && (
          typeof quizQuestionCount !== "number"
          || !Number.isInteger(quizQuestionCount)
          || quizQuestionCount < chars.length
          || quizQuestionCount > chars.length * 2
        )) {
          throw new GameError("INVALID_PAYLOAD", `퀴즈 문항 수는 ${chars.length}~${chars.length * 2}개로 선택해 주세요.`);
        }
        const approvals = new Map(preferences.approvals.map((item) => [item.char, item]));
        const characters = chars.map((char) => {
          const quizItem = requestedQuizPool?.items.find((item) => item.char === char);
          if (quizItem) {
            const character = loadCatalogCharacter(char, `${quizItem.meaning} ${quizItem.reading}`);
            if (!character) throw new GameError("UNKNOWN_CHARACTER", "문제풀 한자의 획 데이터를 불러오지 못했습니다.");
            return character;
          }
          const systemVerified = isSystemVerifiedCharacter(char);
          const approval = approvals.get(char);
          if (!systemVerified && !approval) {
            throw new GameError("UNKNOWN_CHARACTER", "해당 한자는 아직 게임용으로 승인되지 않았습니다.");
          }
          const character = loadCatalogCharacter(char, approval?.label);
          if (!character) throw new GameError("UNKNOWN_CHARACTER", "\uAC8C\uC784\uC6A9 \uD55C\uC790\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
          return character;
        });
        const created = manager.createRoom(
          socket.id,
          chars,
          teacherId,
          characters,
          payload?.gameMode,
          quizQuestionCount,
          payload?.strokeTurnDurationSeconds,
        );
        socket.data = { role: "host", roomCode: created.roomCode, teacherId };
        void socket.join(created.roomCode);
        socket.emit("room:created", created);
        ack({ ok: true, data: created });
      } catch (error) {
        ack({ ok: false, error: commandError(error) });
      }
    });

    socket.on("host:resume-room", (payload, ack) => {
      try {
        const teacherId = socket.data.teacherId;
        if (!teacherId) throw new GameError("AUTH_REQUIRED", "교사 로그인이 필요합니다.");
        const snapshot = manager.resumeHost(socket.id, payload?.roomCode, payload?.hostToken, teacherId);
        socket.data = { role: "host", roomCode: snapshot.roomCode, teacherId };
        void socket.join(snapshot.roomCode);
        ack({ ok: true, data: { snapshot } });
        const countdown = gameCountdownSchedules.get(snapshot.roomCode);
        if (countdown && countdown.startsAt > Date.now()) socket.emit("game:countdown", countdown);
      } catch (error) {
        ack({ ok: false, error: commandError(error) });
      }
    });

    socket.on("host:close-room", (payload, ack) => {
      try {
        if (!socket.data.teacherId) throw new GameError("AUTH_REQUIRED", "교사 로그인이 필요합니다.");
        manager.closeRoom(socket.id, payload?.roomCode);
        if (typeof payload?.roomCode === "string") {
          clearQuizTimers(payload.roomCode);
          clearCountdownTimer(payload.roomCode);
          clearStrokeTurnTimer(payload.roomCode);
          clearScoreUpdates(payload.roomCode);
          io.to(payload.roomCode).emit("room:closed", { reason: "host_closed" });
          void socket.leave(payload.roomCode);
        }
        socket.data = { role: "host", teacherId: socket.data.teacherId };
        ack({ ok: true, data: { closed: true } });
      } catch (error) {
        ack({ ok: false, error: commandError(error) });
      }
    });

    socket.on("host:start-game", (payload, ack) => {
      try {
        if (!socket.data.teacherId) throw new GameError("AUTH_REQUIRED", "교사 로그인이 필요합니다.");
        const waitingSnapshot = manager.validateStartGame(socket.id, payload?.roomCode);
        if (startCountdownMs <= 0) {
          ack({ ok: true, data: { snapshot: startGameNow(socket.id, waitingSnapshot.roomCode) } });
          return;
        }
        if (gameCountdownTimers.has(waitingSnapshot.roomCode)) {
          ack({ ok: true, data: { snapshot: waitingSnapshot } });
          return;
        }
        const fullCountdownMs = gameIntroMs + readyLeadInMs + startCountdownMs;
        const introStartedAt = Date.now();
        const introEndsAt = introStartedAt + gameIntroMs;
        const startsAt = introStartedAt + fullCountdownMs;
        const countdown: GameCountdownPayload = {
          roomCode: waitingSnapshot.roomCode,
          introStartedAt,
          introEndsAt,
          startsAt,
        };
        gameCountdownSchedules.set(waitingSnapshot.roomCode, countdown);
        io.to(waitingSnapshot.roomCode).emit("game:countdown", countdown);
        const timer = setTimeout(() => {
          gameCountdownTimers.delete(waitingSnapshot.roomCode);
          gameCountdownSchedules.delete(waitingSnapshot.roomCode);
          try {
            startGameNow(socket.id, waitingSnapshot.roomCode);
          } catch (error) {
            io.to(waitingSnapshot.roomCode).emit("room:error", commandError(error));
          }
        }, fullCountdownMs);
        gameCountdownTimers.set(waitingSnapshot.roomCode, timer);
        ack({ ok: true, data: { snapshot: waitingSnapshot } });
      } catch (error) {
        ack({ ok: false, error: commandError(error) });
      }
    });

    socket.on("player:join", (payload, ack) => {
      const now = Date.now();
      const window = joinWindows.get(socket.id);
      if (window && now < window.resetAt && window.count >= 10) {
        ack({ ok: false, error: { code: "RATE_LIMITED", message: "잠시 후 다시 시도해 주세요." } });
        return;
      }
      joinWindows.set(socket.id, {
        count: window && now < window.resetAt ? window.count + 1 : 1,
        resetAt: window && now < window.resetAt ? window.resetAt : now + 60_000,
      });
      try {
        const previousTurn = manager.getCurrentTurn(payload?.roomCode);
        const joined = manager.joinRoom(
          socket.id,
          payload?.roomCode,
          payload?.nickname,
          payload?.reconnectToken,
        );
        socket.data = { role: "player", roomCode: payload.roomCode, playerId: joined.playerId };
        void socket.join(payload.roomCode);
        ack({ ok: true, data: joined });
        io.to(payload.roomCode).emit("player:joined", { players: joined.snapshot.players });
        const countdown = gameCountdownSchedules.get(payload.roomCode);
        if (countdown && countdown.startsAt > Date.now()) socket.emit("game:countdown", countdown);
        const resumedTurn = manager.getCurrentTurn(payload.roomCode);
        if (!previousTurn && resumedTurn) {
          io.to(payload.roomCode).emit("stroke:turn", resumedTurn);
          scheduleStrokeTurn(payload.roomCode, resumedTurn);
        }
      } catch (error) {
        ack({ ok: false, error: commandError(error) });
      }
    });

    socket.on("player:stroke-progress", (payload) => {
      const now = Date.now();
      const window = progressWindows.get(socket.id);
      if (window && now < window.resetAt && window.count >= 45) return;
      progressWindows.set(socket.id, {
        count: window && now < window.resetAt ? window.count + 1 : 1,
        resetAt: window && now < window.resetAt ? window.resetAt : now + 1_000,
      });
      try {
        const progress = manager.relayStrokeProgress(
          socket.id,
          payload?.roomCode,
          payload?.strokeIndex,
          payload?.sequence,
          payload?.phase,
          payload?.points,
        );
        // Self-contained previews can be dropped under backpressure; judgments remain reliable.
        if (payload.replace === true) {
          socket.to(payload.roomCode).volatile.emit("stroke:progress", { ...progress, replace: true });
        } else {
          socket.to(payload.roomCode).emit("stroke:progress", progress);
        }
      } catch (error) {
        socket.emit("room:error", commandError(error));
      }
    });

    socket.on("player:stroke-attempt", async (payload, ack) => {
      try {
        const outcome = await manager.attemptStroke(socket.id, payload?.roomCode, payload?.points);
        io.to(payload.roomCode).emit("stroke:result", outcome.result);
        io.to(payload.roomCode).emit("room:snapshot", outcome.snapshot);
        if (outcome.rankedPlayers) {
          clearStrokeTurnTimer(payload.roomCode);
          io.to(payload.roomCode).emit("game:finished", {
            rankedPlayers: outcome.rankedPlayers,
            snapshot: outcome.snapshot,
          });
        } else if (outcome.nextTurn) {
          io.to(payload.roomCode).emit("stroke:turn", outcome.nextTurn);
          scheduleStrokeTurn(payload.roomCode, outcome.nextTurn);
        }
        ack({ ok: true, data: outcome.result });
      } catch (error) {
        ack({ ok: false, error: commandError(error) });
      }
    });

    socket.on("player:worm-hit", (payload, ack) => {
      try {
        const outcome = manager.hitWorm(socket.id, payload?.roomCode, payload?.hitNumber);
        ack({ ok: true, data: { snapshot: outcome.snapshot } });
        broadcastHostSnapshot(payload.roomCode);
        if (outcome.rankedPlayers) {
          clearScoreUpdates(payload.roomCode);
          for (const id of io.sockets.adapter.rooms.get(payload.roomCode) ?? []) io.to(id).emit("game:finished", { rankedPlayers: outcome.rankedPlayers, snapshot: manager.getSnapshotForSocket(payload.roomCode, id) });
        }
      } catch (error) { ack({ ok: false, error: commandError(error) }); }
    });

    socket.on("player:worm-target", (payload, ack) => {
      try {
        const outcome = manager.reachWormTarget(socket.id, payload?.roomCode, payload?.characterIndex, payload?.targetIndex, payload?.point);
        ack({ ok: true, data: { snapshot: outcome.snapshot } });
        broadcastHostSnapshot(payload.roomCode);
        if (outcome.rankedPlayers) {
          clearScoreUpdates(payload.roomCode);
          for (const id of io.sockets.adapter.rooms.get(payload.roomCode) ?? []) {
            io.to(id).emit("game:finished", { rankedPlayers: outcome.rankedPlayers, snapshot: manager.getSnapshotForSocket(payload.roomCode, id) });
          }
        }
      } catch (error) { ack({ ok: false, error: commandError(error) }); }
    });

    socket.on("player:quiz-answer", (payload, ack) => {
      try {
        const outcome = manager.answerQuiz(socket.id, payload?.roomCode, payload?.choiceId, payload?.answerText, payload?.questionIndex);
        socket.emit("quiz:answer-result", outcome);
        // The answering student already receives its personalized snapshot above.
        // Only the teacher needs the full aggregate; classmates receive batched scores.
        broadcastHostSnapshot(payload.roomCode);
        ack({ ok: true, data: outcome });
      } catch (error) {
        ack({ ok: false, error: commandError(error) });
      }
    });

    socket.on("disconnect", () => {
      joinWindows.delete(socket.id);
      progressWindows.delete(socket.id);
      const outcome = manager.disconnect(socket.id);
      if (!outcome) return;
      io.to(outcome.roomCode).emit("player:joined", { players: outcome.snapshot.players });
      if (outcome.nextTurn) {
        io.to(outcome.roomCode).emit("stroke:turn", outcome.nextTurn);
        scheduleStrokeTurn(outcome.roomCode, outcome.nextTurn);
      } else if (!outcome.snapshot.selectedPlayerId) {
        clearStrokeTurnTimer(outcome.roomCode);
      }
    });
  });

  return { app, httpServer, io, manager };
}

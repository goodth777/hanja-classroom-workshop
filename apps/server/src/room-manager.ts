import { randomInt, randomUUID } from "node:crypto";
import type {
  CharacterData,
  GameMode,
  PlayerJoinPayload,
  QuizAnswerResultPayload,
  QuizChoice,
  QuizQuestionType,
  PublicPlayer,
  RankedPlayer,
  RoomCreatedPayload,
  RoomSnapshot,
  StrokeProgressPayload,
  StrokeResultPayload,
  StrokeTurnPayload,
} from "@hanja/contracts";
import {
  DEFAULT_STROKE_TURN_SECONDS,
  MAX_STROKE_TURN_SECONDS,
  MAX_NICKNAME_LENGTH,
  MAX_PLAYERS,
  MIN_STROKE_TURN_SECONDS,
  ROOM_CODE_PATTERN,
} from "@hanja/contracts";
import {
  CURATED_CHARACTERS,
  isNormalizedPoint,
  judgeStroke,
} from "@hanja/stroke-engine";
import { GameError, rankPlayers, toPublicPlayer, toSnapshot, type RoomQuizState, type RoomState } from "./domain.js";
import type { ResultStore } from "./result-store.js";
import { splitQuizLabel as splitLabel } from "./quiz-label.js";

const ACTIVE_ROOM_TTL_MS = 60 * 60 * 1000;
const FINISHED_ROOM_TTL_MS = 15 * 60 * 1000;
const QUIZ_QUESTION_MS = 12_000;

export interface RoomManagerOptions {
  resultStore: ResultStore;
  webOrigin?: string;
  now?: () => number;
  randomIndex?: (upperExclusive: number) => number;
  roomCodeNumber?: () => number;
}

export interface AttemptOutcome {
  result: StrokeResultPayload;
  snapshot: RoomSnapshot;
  nextTurn?: StrokeTurnPayload;
  rankedPlayers?: RankedPlayer[];
}

export interface DisconnectOutcome {
  roomCode: string;
  snapshot: RoomSnapshot;
  nextTurn?: StrokeTurnPayload;
}

export interface StartGameOutcome {
  snapshot: RoomSnapshot;
  turn?: StrokeTurnPayload;
}

export interface QuizAdvanceOutcome {
  snapshot: RoomSnapshot;
  rankedPlayers?: RankedPlayer[];
}

export interface ExpireStrokeTurnOutcome {
  snapshot: RoomSnapshot;
  nextTurn: StrokeTurnPayload;
}

function normalizeNickname(raw: unknown): string {
  if (typeof raw !== "string") throw new GameError("INVALID_PAYLOAD", "닉네임을 입력해 주세요.");
  const nickname = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!nickname || nickname.length > MAX_NICKNAME_LENGTH) {
    throw new GameError("INVALID_PAYLOAD", `닉네임은 1~${MAX_NICKNAME_LENGTH}자로 입력해 주세요.`);
  }
  return nickname;
}

function normalizeGameMode(raw: unknown): GameMode {
  if (raw === undefined || raw === "stroke_battle") return "stroke_battle";
  if (raw === "meaning_sound_quiz") return "meaning_sound_quiz";
  if (raw === "hanja_worm") return "hanja_worm";
  throw new GameError("INVALID_PAYLOAD", "지원하지 않는 게임입니다.");
}

function normalizeStrokeTurnDuration(raw: unknown): number {
  if (raw === undefined) return DEFAULT_STROKE_TURN_SECONDS;
  if (!Number.isInteger(raw) || (raw as number) < MIN_STROKE_TURN_SECONDS || (raw as number) > MAX_STROKE_TURN_SECONDS) {
    throw new GameError("INVALID_PAYLOAD", `획 제한 시간은 ${MIN_STROKE_TURN_SECONDS}~${MAX_STROKE_TURN_SECONDS}초로 선택해 주세요.`);
  }
  return raw as number;
}

function shuffle<T>(items: T[], randomIndex: (upperExclusive: number) => number): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!];
  }
  return next;
}

function normalizeQuizAnswer(value: string): string {
  return value.trim().replace(/\s+/g, "").toLocaleLowerCase("ko");
}

export function createUniqueRoomCode(
  inUse: ReadonlySet<string>,
  nextNumber: () => number = () => randomInt(100000, 1000000),
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(nextNumber()).padStart(6, "0");
    if (ROOM_CODE_PATTERN.test(code) && !inUse.has(code)) return code;
  }
  throw new GameError("INTERNAL_ERROR", "고유한 방 코드를 생성하지 못했습니다.");
}

export class RoomManager {
  private room: RoomState | null = null;
  private readonly characters = new Map<string, CharacterData>();
  private readonly resultStore: ResultStore;
  private readonly webOrigin: string;
  private readonly now: () => number;
  private readonly randomIndex: (upperExclusive: number) => number;
  private readonly roomCodeNumber: () => number;

  constructor(options: RoomManagerOptions) {
    this.resultStore = options.resultStore;
    this.webOrigin = options.webOrigin ?? "http://localhost:3000";
    this.now = options.now ?? Date.now;
    this.randomIndex = options.randomIndex ?? ((upper) => randomInt(0, upper));
    this.roomCodeNumber = options.roomCodeNumber ?? (() => randomInt(100000, 1000000));
    for (const character of CURATED_CHARACTERS) this.characters.set(character.char, character);
  }

  listCharacters(): CharacterData[] {
    return [...this.characters.values()].map((character) => structuredClone(character));
  }

  createRoom(
    hostSocketId: string,
    characterNames: unknown,
    teacherId?: string,
    suppliedCharacters?: CharacterData | CharacterData[],
    gameModeInput?: unknown,
    quizQuestionCountInput?: unknown,
    strokeTurnDurationSecondsInput?: unknown,
  ): RoomCreatedPayload {
    this.evictExpiredRoom();
    if (this.room && this.room.status !== "finished") {
      throw new GameError("ROOM_EXISTS", "\uC774\uBBF8 \uC9C4\uD589 \uC911\uC778 \uAC8C\uC784\uB8F8\uC774 \uC788\uC2B5\uB2C8\uB2E4.");
    }
    const requestedNames = Array.isArray(characterNames)
      ? characterNames
      : typeof characterNames === "string"
        ? [characterNames]
        : [];
    const uniqueNames = [...new Set(requestedNames.filter((name): name is string => typeof name === "string"))];
    const suppliedList = Array.isArray(suppliedCharacters)
      ? suppliedCharacters
      : suppliedCharacters
        ? [suppliedCharacters]
        : [];
    const suppliedByChar = new Map(suppliedList.map((character) => [character.char, character]));
    const characters = uniqueNames
      .map((name) => suppliedByChar.get(name) ?? this.characters.get(name))
      .filter((character): character is CharacterData => Boolean(character));
    if (uniqueNames.length < 1 || characters.length !== uniqueNames.length) {
      throw new GameError("UNKNOWN_CHARACTER", "요청한 한자를 찾을 수 없습니다.");
    }

    const gameMode = normalizeGameMode(gameModeInput);
    const character = characters[0]!;
    const roomCode = createUniqueRoomCode(
      new Set(this.room ? [this.room.roomCode] : []),
      this.roomCodeNumber,
    );
    const createdAtMs = this.now();
    this.room = {
      resultKey: randomUUID(),
      roomCode,
      hostToken: randomUUID(),
      hostSocketId,
      teacherId,
      gameMode,
      character: structuredClone(character),
      characters: characters.map((item) => structuredClone(item)),
      quizQuestions: gameMode === "meaning_sound_quiz" ? this.createQuizQuestionPlan(characters, quizQuestionCountInput) : [],
      characterIndex: 0,
      status: "waiting",
      currentStrokeIndex: 0,
      selectedPlayerId: null,
      strokeTurnDurationSeconds: normalizeStrokeTurnDuration(strokeTurnDurationSecondsInput),
      strokeTurnStartedAt: null,
      strokeTurnEndsAt: null,
      lastSelectedPlayerId: null,
      strokeTurnQueue: [],
      players: new Map(),
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: createdAtMs + ACTIVE_ROOM_TTL_MS,
    };
    return {
      roomCode,
      qrUrl: this.webOrigin.replace(/\/$/, "") + "/join/" + roomCode,
      hostToken: this.room.hostToken,
      snapshot: toSnapshot(this.room),
    };
  }

  resumeHost(
    socketId: string,
    roomCode: unknown,
    token: unknown,
    teacherId?: string,
  ): RoomSnapshot {
    const room = this.requireRoom(roomCode);
    if (
      typeof token !== "string" ||
      token !== room.hostToken ||
      (room.teacherId && room.teacherId !== teacherId)
    ) {
      throw new GameError("NOT_HOST", "교사 재접속 토큰이 올바르지 않습니다.");
    }
    room.hostSocketId = socketId;
    return toSnapshot(room);
  }

  joinRoom(socketId: string, roomCode: unknown, rawNickname: unknown, token?: unknown): PlayerJoinPayload {
    const room = this.requireRoom(roomCode);
    {
      const existing = [...room.players.values()].find((player) =>
        player.socketId === socketId || (typeof token === "string" && token && player.reconnectToken === token));
      if (existing) {
        existing.socketId = socketId;
        existing.connected = true;
        if (room.gameMode === "stroke_battle" && room.status === "in_progress" && !room.selectedPlayerId) {
          this.selectNextPlayer(room);
        }
        return {
          playerId: existing.id,
          reconnectToken: existing.reconnectToken,
          nickname: existing.nickname,
          reconnected: true,
          snapshot: toSnapshot(room, existing.id),
        };
      }
    }

    if (room.status !== "waiting") {
      throw new GameError("INVALID_STATE", "게임 시작 후에는 새로 입장할 수 없습니다.");
    }
    if (room.players.size >= MAX_PLAYERS) {
      throw new GameError("ROOM_FULL", "입장 인원이 가득 찼습니다.");
    }

    const requested = normalizeNickname(rawNickname);
    const nickname = this.uniqueNickname(room, requested);
    const player = {
      id: randomUUID(),
      reconnectToken: randomUUID(),
      socketId,
      nickname,
      score: 0,
      joinedAt: new Date(this.now()).toISOString(),
      connected: true,
    };
    room.players.set(player.id, player);
    return {
      playerId: player.id,
      reconnectToken: player.reconnectToken,
      nickname,
      reconnected: false,
      snapshot: toSnapshot(room),
    };
  }

  closeRoom(hostSocketId: string, roomCode: unknown): void {
    const room = this.requireRoom(roomCode);
    this.requireHost(room, hostSocketId);
    if (room.status === "in_progress") this.persistResult(room, "stopped");
    this.room = null;
  }

  validateStartGame(hostSocketId: string, roomCode: unknown): RoomSnapshot {
    const room = this.requireRoom(roomCode);
    this.requireHost(room, hostSocketId);
    if (room.status !== "waiting") throw new GameError("INVALID_STATE", "대기 중인 게임만 시작할 수 있습니다.");
    if (![...room.players.values()].some((player) => player.connected)) {
      throw new GameError("NO_PLAYERS", "접속한 학생이 한 명 이상 필요합니다.");
    }
    return toSnapshot(room);
  }

  startGame(hostSocketId: string, roomCode: unknown): StartGameOutcome {
    this.validateStartGame(hostSocketId, roomCode);
    const room = this.requireRoom(roomCode);
    room.status = "in_progress";
    room.currentStrokeIndex = 0;
    if (room.gameMode === "hanja_worm") {
      for (const player of room.players.values()) {
        player.worm = { characterIndex: 0, targetIndex: 0, completedStrokes: 0, finished: false, hits: 0, eliminated: false };
      }
      return { snapshot: toSnapshot(room) };
    }
    if (room.gameMode === "meaning_sound_quiz") {
      room.selectedPlayerId = null;
      room.strokeTurnStartedAt = null;
      room.strokeTurnEndsAt = null;
      for (const player of room.players.values()) {
        player.quiz = this.createQuizState(room, 0);
        player.quizFinished = false;
        player.quizCorrectCount = 0;
      }
      return { snapshot: toSnapshot(room) };
    }
    this.selectNextPlayer(room);
    return { snapshot: toSnapshot(room), turn: this.createTurn(room) };
  }

  relayStrokeProgress(
    socketId: string,
    roomCode: unknown,
    strokeIndex: unknown,
    sequence: unknown,
    phase: unknown,
    points: unknown,
  ): StrokeProgressPayload {
    const room = this.requireRoom(roomCode);
    if (room.gameMode !== "stroke_battle") {
      throw new GameError("INVALID_STATE", "획순 배틀에서만 획을 공유할 수 있습니다.");
    }
    if (room.status !== "in_progress") {
      throw new GameError("INVALID_STATE", "진행 중인 게임이 아닙니다.");
    }
    if (room.strokeTurnEndsAt !== null && this.now() >= room.strokeTurnEndsAt) {
      throw new GameError("INVALID_STATE", "이번 획의 시간이 끝났습니다.");
    }
    const selected = room.selectedPlayerId ? room.players.get(room.selectedPlayerId) : undefined;
    if (!selected || selected.socketId !== socketId) {
      throw new GameError("NOT_YOUR_TURN", "현재 차례인 학생만 획을 공유할 수 있습니다.");
    }
    if (strokeIndex !== room.currentStrokeIndex) {
      throw new GameError("INVALID_STATE", "현재 획 번호와 일치하지 않습니다.");
    }
    if (!Number.isInteger(sequence) || (sequence as number) < 0 || (sequence as number) > 1_000_000) {
      throw new GameError("INVALID_PAYLOAD", "유효하지 않은 획 순번입니다.");
    }
    if (phase !== "start" && phase !== "move" && phase !== "end") {
      throw new GameError("INVALID_PAYLOAD", "유효하지 않은 획 진행 상태입니다.");
    }
    if (!Array.isArray(points) || points.length < 1 || points.length > 64 || !points.every(isNormalizedPoint)) {
      throw new GameError("INVALID_PAYLOAD", "획 좌표가 유효하지 않습니다.");
    }
    return {
      playerId: selected.id,
      nickname: selected.nickname,
      strokeIndex: room.currentStrokeIndex,
      sequence: sequence as number,
      phase,
      points: structuredClone(points),
    };
  }

  async attemptStroke(socketId: string, roomCode: unknown, points: unknown): Promise<AttemptOutcome> {
    const room = this.requireRoom(roomCode);
    if (room.gameMode !== "stroke_battle") {
      throw new GameError("INVALID_STATE", "획순 배틀에서만 획을 제출할 수 있습니다.");
    }
    if (room.status !== "in_progress") {
      throw new GameError("INVALID_STATE", "진행 중인 게임이 아닙니다.");
    }
    if (room.strokeTurnEndsAt !== null && this.now() >= room.strokeTurnEndsAt) {
      throw new GameError("INVALID_STATE", "이번 획의 시간이 끝났습니다.");
    }
    const selected = room.selectedPlayerId ? room.players.get(room.selectedPlayerId) : undefined;
    if (!selected || selected.socketId !== socketId) {
      throw new GameError("NOT_YOUR_TURN", "현재 차례인 학생만 획을 제출할 수 있습니다.");
    }
    const stroke = room.character.strokeData[room.currentStrokeIndex];
    if (!stroke) throw new GameError("INTERNAL_ERROR", "현재 획 데이터를 찾을 수 없습니다.");

    const judgment = judgeStroke(stroke, points, {
      characterStrokes: room.character.strokeData,
      strokeIndex: room.currentStrokeIndex,
    });
    const result: StrokeResultPayload = {
      correct: judgment.correct,
      playerId: selected.id,
      nickname: selected.nickname,
      scoreDelta: judgment.correct ? 10 : 0,
      reason: judgment.reason,
      players: [],
      strokeIndex: room.currentStrokeIndex,
    };

    if (judgment.correct) {
      selected.score += 10;
      room.currentStrokeIndex += 1;
      if (room.currentStrokeIndex >= room.character.strokeData.length) {
        if (room.characterIndex + 1 < room.characters.length) {
          room.characterIndex += 1;
          room.character = structuredClone(room.characters[room.characterIndex]!);
          room.currentStrokeIndex = 0;
          this.selectNextPlayer(room);
        } else {
          room.status = "finished";
          room.selectedPlayerId = null;
          room.strokeTurnStartedAt = null;
          room.strokeTurnEndsAt = null;
          room.expiresAt = this.now() + FINISHED_ROOM_TTL_MS;
          const rankedPlayers = rankPlayers(room.players.values());
          result.players = rankedPlayers;
          this.persistResult(room, "completed");
          return { result, snapshot: toSnapshot(room), rankedPlayers };
        }
      } else {
        this.selectNextPlayer(room);
      }
    } else if (judgment.reason !== "too_short" && judgment.reason !== "invalid_input") {
      this.selectNextPlayer(room);
    }

    result.players = [...room.players.values()].map(toPublicPlayer);
    return { result, snapshot: toSnapshot(room), nextTurn: this.createTurn(room) };
  }

  answerQuiz(socketId: string, roomCode: unknown, choiceId: unknown, answerText: unknown, questionIndex?: unknown): QuizAnswerResultPayload {
    const room = this.requireRoom(roomCode);
    if (room.status !== "in_progress" || room.gameMode !== "meaning_sound_quiz") {
      throw new GameError("INVALID_STATE", "진행 중인 뜻·음 퀴즈가 아닙니다.");
    }
    const player = [...room.players.values()].find((candidate) => candidate.socketId === socketId && candidate.connected);
    if (!player) throw new GameError("INVALID_STATE", "참여 학생을 찾을 수 없습니다.");
    const quiz = player.quiz;
    if (!quiz || player.quizFinished) throw new GameError("INVALID_STATE", "모든 문제를 마쳤습니다.");
    if (questionIndex !== undefined && questionIndex !== quiz.questionIndex) {
      throw new GameError("INVALID_STATE", "이미 지난 문제의 답입니다.");
    }
    const attempts = quiz.answers;
    const existing = attempts.at(-1);
    if (quiz.phase !== "question") {
      if (existing) return { ...existing, snapshot: toSnapshot(room, player.id) };
      throw new GameError("INVALID_STATE", "이미 정답을 공개한 문제입니다.");
    }
    if (this.now() >= quiz.questionEndsAt) throw new GameError("INVALID_STATE", "이 문제의 시간이 끝났습니다.");

    const isInputQuestion = quiz.questionType.endsWith("_input");
    if (isInputQuestion) {
      if (typeof answerText !== "string" || !answerText.trim() || answerText.length > 20) {
        throw new GameError("INVALID_PAYLOAD", "답을 입력해 주세요.");
      }
    } else if (typeof choiceId !== "string" || !quiz.choices.some((choice) => choice.id === choiceId)) {
      throw new GameError("INVALID_PAYLOAD", "선택지를 다시 확인해 주세요.");
    }

    const correct = isInputQuestion
      ? normalizeQuizAnswer(answerText as string) === normalizeQuizAnswer(quiz.correctAnswer)
      : choiceId === quiz.correctChoiceId;
    const elapsed = Math.max(0, this.now() - quiz.questionStartedAt);
    const speedBonus = correct ? Math.max(0, 40 - Math.floor(elapsed / 300)) : 0;
    const attemptNumber = attempts.length + 1;
    const scoreDelta = correct ? (attemptNumber === 1 ? 60 + speedBonus : 30) : 0;
    if (scoreDelta > 0) player.score += scoreDelta;
    const record = {
      playerId: player.id,
      choiceId: isInputQuestion ? undefined : choiceId as string,
      answerText: isInputQuestion ? (answerText as string).trim() : undefined,
      correct,
      scoreDelta,
      attemptNumber,
    };
    quiz.answers.push(record);
    player.quizLastAnswer = { questionIndex: quiz.questionIndex, correct };
    if (correct) player.quizCorrectCount = (player.quizCorrectCount ?? 0) + 1;
    if (correct || attemptNumber === 2) {
      quiz.phase = "revealed";
      quiz.advanceAt = this.now() + 800;
    }
    return { ...record, snapshot: toSnapshot(room, player.id) };
  }

  tickQuiz(roomCode: string): QuizAdvanceOutcome | undefined {
    const room = this.requireRoom(roomCode);
    if (room.status !== "in_progress" || room.gameMode !== "meaning_sound_quiz") return undefined;
    const now = this.now();
    let changed = false;
    for (const player of room.players.values()) {
      const quiz = player.quiz;
      if (!quiz || player.quizFinished) continue;
      if (quiz.phase === "question" && now >= quiz.questionEndsAt) {
        quiz.phase = "revealed";
        quiz.advanceAt = now + 800;
        player.quizLastAnswer = { questionIndex: quiz.questionIndex, correct: false };
        changed = true;
      } else if (quiz.phase === "revealed" && now >= (quiz.advanceAt ?? now)) {
        if (quiz.questionIndex + 1 >= this.quizQuestionCount(room)) player.quizFinished = true;
        else player.quiz = this.createQuizState(room, quiz.questionIndex + 1);
        changed = true;
      }
    }
    if (!changed) return undefined;
    if ([...room.players.values()].every((player) => player.quizFinished)) return this.finishRoom(room);
    return { snapshot: toSnapshot(room) };
  }

  getSnapshotForSocket(roomCode: string, socketId: string): RoomSnapshot {
    const room = this.requireRoom(roomCode);
    const player = [...room.players.values()].find((candidate) => candidate.socketId === socketId);
    return toSnapshot(room, player?.id);
  }

  disconnect(socketId: string): DisconnectOutcome | undefined {
    const room = this.room;
    if (!room) return undefined;
    if (room.hostSocketId === socketId) room.hostSocketId = null;
    const player = [...room.players.values()].find((candidate) => candidate.socketId === socketId);
    if (!player) return undefined;
    player.connected = false;
    player.socketId = null;
    let nextTurn: StrokeTurnPayload | undefined;
    if (room.status === "in_progress" && room.selectedPlayerId === player.id) {
      const available = [...room.players.values()].some((candidate) => candidate.connected);
      if (available) {
        this.selectNextPlayer(room);
        if (room.gameMode === "stroke_battle") nextTurn = this.createTurn(room);
      } else {
        room.lastSelectedPlayerId = room.selectedPlayerId;
        room.selectedPlayerId = null;
        room.strokeTurnStartedAt = null;
        room.strokeTurnEndsAt = null;
      }
    }
    return { roomCode: room.roomCode, snapshot: toSnapshot(room), nextTurn };
  }

  getSnapshot(roomCode: string): RoomSnapshot {
    return toSnapshot(this.requireRoom(roomCode));
  }

  getCurrentTurn(roomCode: string): StrokeTurnPayload | undefined {
    const room = this.requireRoom(roomCode);
    if (room.status !== "in_progress" || room.gameMode !== "stroke_battle" || !room.selectedPlayerId) return undefined;
    return this.createTurn(room);
  }

  expireStrokeTurn(roomCode: string, selectedPlayerId: string, turnEndsAt: number): ExpireStrokeTurnOutcome | undefined {
    const room = this.requireRoom(roomCode);
    if (
      room.status !== "in_progress"
      || room.gameMode !== "stroke_battle"
      || room.selectedPlayerId !== selectedPlayerId
      || room.strokeTurnEndsAt !== turnEndsAt
      || this.now() < turnEndsAt
    ) return undefined;
    this.selectNextPlayer(room);
    return { snapshot: toSnapshot(room), nextTurn: this.createTurn(room) };
  }

  private requireRoom(roomCode: unknown): RoomState {
    this.evictExpiredRoom();
    if (typeof roomCode !== "string" || !ROOM_CODE_PATTERN.test(roomCode)) {
      throw new GameError("INVALID_ROOM", "6자리 방 코드를 확인해 주세요.");
    }
    if (!this.room || this.room.roomCode !== roomCode) {
      throw new GameError("INVALID_ROOM", "존재하지 않는 방입니다.");
    }
    return this.room;
  }

  private requireHost(room: RoomState, socketId: string): void {
    if (room.hostSocketId !== socketId) throw new GameError("NOT_HOST", "교사만 실행할 수 있습니다.");
  }

  private uniqueNickname(room: RoomState, requested: string): string {
    const used = new Set([...room.players.values()].map((player) => player.nickname.toLocaleLowerCase("ko")));
    if (!used.has(requested.toLocaleLowerCase("ko"))) return requested;
    let suffix = 2;
    while (used.has(`${requested}_${suffix}`.toLocaleLowerCase("ko"))) suffix += 1;
    return `${requested}_${suffix}`;
  }

  private selectNextPlayer(room: RoomState): void {
    const connectedIds = new Set(
      [...room.players.values()].filter((player) => player.connected).map((player) => player.id),
    );
    if (connectedIds.size === 0) {
      room.selectedPlayerId = null;
      room.strokeTurnStartedAt = null;
      room.strokeTurnEndsAt = null;
      return;
    }

    let selectedId: string | undefined;
    while (room.strokeTurnQueue.length > 0 && !selectedId) {
      const candidateId = room.strokeTurnQueue.shift()!;
      if (connectedIds.has(candidateId)) selectedId = candidateId;
    }

    if (!selectedId) {
      const previous = room.selectedPlayerId ?? room.lastSelectedPlayerId;
      const nextRound = shuffle([...connectedIds], this.randomIndex);
      if (nextRound.length > 1 && nextRound[0] === previous) {
        const swapIndex = nextRound.findIndex((playerId) => playerId !== previous);
        [nextRound[0], nextRound[swapIndex]] = [nextRound[swapIndex]!, nextRound[0]!];
      }
      room.strokeTurnQueue = nextRound;
      selectedId = room.strokeTurnQueue.shift();
    }

    if (!selectedId) {
      room.selectedPlayerId = null;
      room.strokeTurnStartedAt = null;
      room.strokeTurnEndsAt = null;
      return;
    }
    room.selectedPlayerId = selectedId;
    room.lastSelectedPlayerId = selectedId;
    room.strokeTurnStartedAt = this.now();
    room.strokeTurnEndsAt = room.strokeTurnStartedAt + room.strokeTurnDurationSeconds * 1000;
  }

  private createTurn(room: RoomState): StrokeTurnPayload {
    const selected = room.selectedPlayerId ? room.players.get(room.selectedPlayerId) : undefined;
    const stroke = room.character.strokeData[room.currentStrokeIndex];
    if (!selected || !stroke || room.strokeTurnStartedAt === null || room.strokeTurnEndsAt === null) {
      throw new GameError("INTERNAL_ERROR", "다음 차례를 만들 수 없습니다.");
    }
    return {
      selectedPlayerId: selected.id,
      selectedPlayerNickname: selected.nickname,
      strokeIndex: room.currentStrokeIndex,
      nextStroke: stroke,
      durationSeconds: room.strokeTurnDurationSeconds,
      turnStartedAt: room.strokeTurnStartedAt,
      turnEndsAt: room.strokeTurnEndsAt,
    };
  }

  private createQuizState(room: RoomState, questionIndex: number): RoomQuizState {
    const question = room.quizQuestions[questionIndex] ?? {
      characterIndex: questionIndex % room.characters.length,
      questionType: "reading_choice" as const,
    };
    const characterIndex = question.characterIndex;
    const character = room.characters[characterIndex] ?? room.character;
    const label = splitLabel(character.label);
    const questionType = question.questionType;
    const asksForHanja = questionType === "hanja_choice";
    const answerField = questionType.startsWith("reading") ? "reading" : "meaning";
    const correctAnswer = asksForHanja ? character.char : label[answerField] || label.text;
    const correctChoice: QuizChoice = {
      id: "choice-" + character.char,
      char: character.char,
      label: asksForHanja ? character.char : correctAnswer,
    };
    const poolCandidates = [
      ...room.characters.filter((candidate) => candidate.char !== character.char),
      ...this.listCharacters().filter((candidate) => !room.characters.some((item) => item.char === candidate.char)),
    ];
    const distractors = shuffle(
      poolCandidates.filter((candidate) => {
        if (candidate.char === character.char) return false;
        if (asksForHanja) return true;
        const candidateLabel = splitLabel(candidate.label);
        return Boolean(candidateLabel[answerField] && candidateLabel[answerField] !== correctAnswer);
      }),
      this.randomIndex,
    ).filter((candidate, index, items) => {
      const answer = asksForHanja ? candidate.char : splitLabel(candidate.label)[answerField] || splitLabel(candidate.label).text;
      return items.findIndex((item) => (asksForHanja ? item.char : splitLabel(item.label)[answerField] || splitLabel(item.label).text) === answer) === index;
    }).slice(0, 3).map((candidate) => ({
      id: "choice-" + candidate.char,
      char: candidate.char,
      label: asksForHanja ? candidate.char : splitLabel(candidate.label)[answerField] || splitLabel(candidate.label).text,
    }));
    const startedAt = this.now();
    return {
      questionIndex,
      totalQuestions: this.quizQuestionCount(room),
      questionType,
      promptChar: character.char,
      promptHint: asksForHanja ? `${label.meaning} ${label.reading}`.trim() : question.promptHint,
      promptLabel: label.text,
      choices: questionType.endsWith("_choice") ? shuffle([correctChoice, ...distractors], this.randomIndex) : [],
      phase: "question",
      questionStartedAt: startedAt,
      questionEndsAt: startedAt + QUIZ_QUESTION_MS,
      correctChoiceId: questionType.endsWith("_choice") ? correctChoice.id : undefined,
      correctAnswer,
      answers: [],
    };
  }

  private quizQuestionCount(room: RoomState): number {
    return room.quizQuestions.length || room.characters.length;
  }

  private createQuizQuestionPlan(characters: CharacterData[], requestedCount: unknown): RoomState["quizQuestions"] {
    const order = shuffle(characters.map((_, index) => index), this.randomIndex);
    const minimum = characters.length;
    const maximum = characters.length * 2;
    const count = typeof requestedCount === "number" && Number.isInteger(requestedCount)
      ? Math.max(minimum, Math.min(maximum, requestedCount))
      : minimum;
    const sequence = [...order];
    if (count > order.length) {
      let extraOrder = [...order];
      if (extraOrder.length > 1 && extraOrder[0] === order.at(-1)) {
        extraOrder = [...extraOrder.slice(1), extraOrder[0]!];
      }
      sequence.push(...extraOrder.slice(0, count - order.length));
    }
    const questionTypes: QuizQuestionType[] = ["hanja_choice", "reading_choice", "meaning_choice", "reading_input"];
    let inputIndex = 0;
    return sequence.slice(0, count).map((characterIndex, questionIndex) => {
      const questionType = questionTypes[questionIndex % questionTypes.length]!;
      if (questionType !== "reading_input") return { characterIndex, questionType };
      const label = splitLabel(characters[characterIndex]?.label ?? "");
      const promptHint = inputIndex % 2 === 0 && label.meaning ? `${label.meaning} ____` : undefined;
      inputIndex += 1;
      return { characterIndex, questionType, promptHint };
    });
  }

  hitWorm(socketId: string, roomCode: unknown, hitNumber: unknown): QuizAdvanceOutcome {
    const room = this.requireRoom(roomCode);
    const player = [...room.players.values()].find((p) => p.socketId === socketId && p.connected);
    if (room.gameMode !== "hanja_worm" || !player?.worm) throw new GameError("INVALID_STATE", "참여 상태를 확인해 주세요.");
    const progress = player.worm;
    if (!Number.isInteger(hitNumber) || (hitNumber as number) < 1 || (hitNumber as number) > 3) throw new GameError("INVALID_PAYLOAD", "충돌 횟수가 올바르지 않습니다.");
    if ((hitNumber as number) <= progress.hits) return { snapshot: toSnapshot(room, player.id) };
    if (room.status !== "in_progress" || progress.finished || hitNumber !== progress.hits + 1 || this.now() - (player.wormHitAt ?? -Infinity) < 1500) throw new GameError("INVALID_STATE", "충돌 상태를 다시 확인해 주세요.");
    player.wormHitAt = this.now();
    progress.hits++;
    if (progress.hits === 3) { progress.finished = true; progress.eliminated = true; }
    if ([...room.players.values()].every((p) => p.worm?.finished)) {
      const result = this.finishRoom(room);
      return { ...result, snapshot: toSnapshot(room, player.id) };
    }
    return { snapshot: toSnapshot(room, player.id) };
  }

  reachWormTarget(socketId: string, roomCode: unknown, characterIndex: unknown, targetIndex: unknown, point: unknown): QuizAdvanceOutcome {
    const room = this.requireRoom(roomCode);
    const player = [...room.players.values()].find((p) => p.socketId === socketId && p.connected);
    if (room.gameMode !== "hanja_worm" || !player?.worm) throw new GameError("INVALID_STATE", "한자 지렁이 참여 상태를 확인해 주세요.");
    const progress = player.worm;
    if (!Number.isInteger(characterIndex) || (characterIndex as number) < 0 || (characterIndex as number) >= room.characters.length
      || !Number.isInteger(targetIndex) || (targetIndex as number) < 0 || (targetIndex as number) >= room.characters[characterIndex as number]!.strokeData.length * 2
      || !isNormalizedPoint(point)) throw new GameError("INVALID_PAYLOAD", "목표 좌표가 올바르지 않습니다.");
    // Retried ACKs must never award a stroke twice, including the final target.
    if ((characterIndex as number) < progress.characterIndex || (characterIndex === progress.characterIndex && (targetIndex as number) < progress.targetIndex)) return { snapshot: toSnapshot(room, player.id) };
    if (room.status !== "in_progress" || progress.finished || characterIndex !== progress.characterIndex || targetIndex !== progress.targetIndex) throw new GameError("INVALID_STATE", "현재 반짝이는 목표로 이동해 주세요.");
    const character = room.characters[progress.characterIndex]!;
    const stroke = character.strokeData[Math.floor(progress.targetIndex / 2)]!;
    const target = progress.targetIndex % 2 === 0 ? stroke.startPoint : stroke.endPoint;
    if (Math.hypot(point.x - target.x, point.y - target.y) > 0.065) throw new GameError("INVALID_PAYLOAD", "목표에 조금 더 가까이 가 주세요.");
    progress.targetIndex++;
    if (progress.targetIndex % 2 === 0) { progress.completedStrokes++; player.score += 10; }
    if (progress.targetIndex === character.strokeData.length * 2) {
      if (progress.characterIndex + 1 < room.characters.length) { progress.characterIndex++; progress.targetIndex = 0; }
      else progress.finished = true;
    }
    if ([...room.players.values()].every((p) => p.worm?.finished)) {
      const outcome = this.finishRoom(room);
      return { ...outcome, snapshot: toSnapshot(room, player.id) };
    }
    return { snapshot: toSnapshot(room, player.id) };
  }

  private finishRoom(room: RoomState): QuizAdvanceOutcome {
    room.status = "finished";
    room.selectedPlayerId = null;
    room.expiresAt = this.now() + FINISHED_ROOM_TTL_MS;
    const rankedPlayers = rankPlayers(room.players.values());
    this.persistResult(room, "completed");
    return { snapshot: toSnapshot(room), rankedPlayers };
  }

  getHistory(teacherId: string, gameMode: GameMode, offset: number) {
    if (!this.resultStore.history) throw new GameError("INTERNAL_ERROR", "기록 저장소를 사용할 수 없습니다.");
    return this.resultStore.history(teacherId, gameMode, offset);
  }

  private persistResult(room: RoomState, status: "completed" | "stopped"): void {
    const scores = rankPlayers(room.players.values()).map(({ nickname, rank, score }) => ({ nickname, rank, score }));
    const result = { resultKey: room.resultKey, teacherId: room.teacherId, gameMode: room.gameMode, status, character: room.characters.map(c => c.char).join(""), playerCount: scores.length, scores, completedAt: new Date(this.now()).toISOString() };
    // Persist away from the realtime path. Stable keys make network retries idempotent.
    const save = async (attempt: number): Promise<void> => {
      try { await this.resultStore.save(result); }
      catch (error) {
        if (attempt < 2) { const timer = setTimeout(() => { void save(attempt + 1); }, 1000 * 2 ** attempt); timer.unref(); }
        else console.error("Game result could not be saved after 3 attempts", error);
      }
    };
    void save(0);
  }

  private evictExpiredRoom(): void {
    if (this.room && this.now() >= this.room.expiresAt) this.room = null;
  }
}

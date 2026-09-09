export interface Point {
  x: number;
  y: number;
}

export interface ClipRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Stroke {
  order: number;
  startPoint: Point;
  endPoint: Point;
  toleranceRadius: number;
  angleTolerance: number;
  lengthToleranceRatio: [number, number];
  clipRect?: ClipRect;
  svgPath?: string;
  checkpoints?: Point[];
  median?: Point[];
}

export interface PathCoordinateSystem {
  width: number;
  height: number;
  originY: number;
  flipY: boolean;
}

export interface CharacterData {
  char: string;
  label: string;
  source: "hanzi-writer" | "custom";
  pathCoordinateSystem?: PathCoordinateSystem;
  strokeData: Stroke[];
}

export interface RoomCharacterSummary {
  char: string;
  label: string;
  strokeCount: number;
}

export type CharacterVerificationStatus = "verified" | "available_unverified" | "unavailable";

export interface CharacterCatalogEntry {
  char: string;
  status: CharacterVerificationStatus;
  label?: string;
  suggestedLabel?: string;
  strokeCount?: number;
}

export interface CharacterCatalogSearchResponse {
  query: string;
  availableDataCount: number;
  entries: CharacterCatalogEntry[];
}

export interface TeacherCharacterApproval {
  char: string;
  label: string;
  approvedAt: string;
}

export interface TeacherCharacterFolder {
  id: string;
  name: string;
  orderedChars: string[];
}

export interface TeacherQuizPoolItem {
  char: string;
  meaning: string;
  reading: string;
}

export interface TeacherQuizPool {
  id: string;
  name: string;
  items: TeacherQuizPoolItem[];
}

export interface TeacherCharacterPreferences {
  /** Active-folder order retained for compatibility with older clients and rows. */
  orderedChars: string[];
  folders: TeacherCharacterFolder[];
  activeFolderId: string;
  approvals: TeacherCharacterApproval[];
  quizPools: TeacherQuizPool[];
}

export interface TeacherCharacterPreferencesResponse {
  preferences: TeacherCharacterPreferences;
  characters: CharacterData[];
}

export type RoomStatus = "waiting" | "in_progress" | "finished";

export type GameMode = "stroke_battle" | "meaning_sound_quiz" | "hanja_worm";

export interface SavedGameResult {
  resultKey: string;
  teacherId?: string;
  gameMode: GameMode;
  status: "completed" | "stopped";
  character: string;
  playerCount: number;
  scores: { nickname: string; rank: number; score: number }[];
  completedAt: string;
}
export interface AverageRank { nickname: string; average: number; games: number; rank: number }
export interface GameHistoryResponse { results: SavedGameResult[]; leaderboard: AverageRank[]; hasMore: boolean }

export interface WormProgress {
  hits: number;
  eliminated: boolean;
  characterIndex: number;
  targetIndex: number;
  completedStrokes: number;
  finished: boolean;
}

export type JudgmentReason =
  | "correct"
  | "too_short"
  | "invalid_input"
  | "start_mismatch"
  | "end_mismatch"
  | "angle_mismatch"
  | "length_mismatch";

export interface PublicPlayer {
  id: string;
  nickname: string;
  score: number;
  connected: boolean;
}

export interface RankedPlayer extends PublicPlayer {
  rank: number;
}

export interface RoomSnapshot {
  roomCode: string;
  gameMode: GameMode;
  character: CharacterData;
  characters: RoomCharacterSummary[];
  characterIndex: number;
  status: RoomStatus;
  currentStrokeIndex: number;
  selectedPlayerId: string | null;
  strokeTurnDurationSeconds: number;
  strokeTurnStartedAt: number | null;
  strokeTurnEndsAt: number | null;
  quiz?: QuizSnapshot;
  quizFinished?: boolean;
  worm?: WormProgress;
  wormProgress?: Array<WormProgress & { playerId: string }>;
  quizProgress?: QuizPlayerProgress[];
  players: PublicPlayer[];
  createdAt: string;
}

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "INVALID_PAYLOAD"
  | "INVALID_ROOM"
  | "ROOM_FULL"
  | "ROOM_EXISTS"
  | "ROOM_EXPIRED"
  | "RATE_LIMITED"
  | "INVALID_STATE"
  | "NOT_HOST"
  | "NOT_YOUR_TURN"
  | "NO_PLAYERS"
  | "UNKNOWN_CHARACTER"
  | "INTERNAL_ERROR";

export interface CommandError {
  code: ErrorCode;
  message: string;
}

export type Ack<T> =
  | { ok: true; data: T }
  | { ok: false; error: CommandError };

export interface CreateRoomInput {
  character: string;
  characters?: string[];
  gameMode?: GameMode;
  quizPoolId?: string;
  quizQuestionCount?: number;
  strokeTurnDurationSeconds?: number;
}

export interface ResumeRoomInput {
  roomCode: string;
  hostToken: string;
}

export interface JoinRoomInput {
  roomCode: string;
  nickname: string;
  reconnectToken?: string;
}

export interface StrokeAttemptInput {
  roomCode: string;
  points: Point[];
}

export type StrokeProgressPhase = "start" | "move" | "end";

export interface StrokeProgressInput {
  roomCode: string;
  strokeIndex: number;
  sequence: number;
  phase: StrokeProgressPhase;
  points: Point[];
  /** Self-contained, sampled preview; missing means legacy incremental points. */
  replace?: boolean;
}

export interface StrokeProgressPayload extends Omit<StrokeProgressInput, "roomCode"> {
  playerId: string;
  nickname: string;
}

export interface RoomCreatedPayload {
  roomCode: string;
  qrUrl: string;
  hostToken: string;
  snapshot: RoomSnapshot;
}

export interface PlayerJoinPayload {
  playerId: string;
  reconnectToken: string;
  nickname: string;
  reconnected: boolean;
  snapshot: RoomSnapshot;
}

export interface StrokeResultPayload {
  correct: boolean;
  playerId: string;
  nickname: string;
  scoreDelta: number;
  reason: JudgmentReason;
  players: PublicPlayer[];
  strokeIndex: number;
}

export interface StrokeTurnPayload {
  selectedPlayerId: string;
  selectedPlayerNickname: string;
  strokeIndex: number;
  nextStroke: Stroke;
  durationSeconds: number;
  turnStartedAt: number;
  turnEndsAt: number;
}

export interface GameFinishedPayload {
  rankedPlayers: RankedPlayer[];
  snapshot: RoomSnapshot;
}

export interface QuizChoice {
  id: string;
  char: string;
  label: string;
}

export type QuizQuestionType =
  | "reading_choice"
  | "meaning_choice"
  | "reading_input"
  | "meaning_input"
  | "hanja_choice";

export interface QuizAnswerRecord {
  playerId: string;
  choiceId?: string;
  answerText?: string;
  correct: boolean;
  scoreDelta: number;
  attemptNumber: number;
}

export interface QuizSnapshot {
  questionIndex: number;
  totalQuestions: number;
  questionType: QuizQuestionType;
  promptChar: string;
  promptHint?: string;
  promptLabel: string;
  choices: QuizChoice[];
  phase: "question" | "revealed";
  questionStartedAt: number;
  questionEndsAt: number;
  correctChoiceId?: string;
  correctAnswer?: string;
  answers: QuizAnswerRecord[];
}

export interface QuizAnswerInput {
  roomCode: string;
  questionIndex?: number;
  choiceId?: string;
  answerText?: string;
}

export interface QuizPlayerProgress {
  playerId: string;
  questionIndex: number;
  totalQuestions: number;
  promptChar: string;
  promptHint?: string;
  questionType: QuizQuestionType;
  phase: "question" | "revealed" | "finished";
  questionEndsAt: number;
  correctCount: number;
  lastAnswer?: { questionIndex: number; correct: boolean };
}

export interface QuizAnswerResultPayload extends QuizAnswerRecord {
  snapshot: RoomSnapshot;
}

export interface GameCountdownPayload {
  roomCode: string;
  introStartedAt: number;
  introEndsAt: number;
  startsAt: number;
}

export interface ClientToServerEvents {
  "clock:sync": (ack: (result: { serverNow: number }) => void) => void;
  "player:worm-hit": (
    payload: { roomCode: string; hitNumber: number },
    ack: (result: Ack<{ snapshot: RoomSnapshot }>) => void,
  ) => void;
  "player:worm-target": (
    payload: { roomCode: string; characterIndex: number; targetIndex: number; point: Point },
    ack: (result: Ack<{ snapshot: RoomSnapshot }>) => void,
  ) => void;
  "host:create-room": (
    payload: CreateRoomInput,
    ack: (result: Ack<RoomCreatedPayload>) => void,
  ) => void;
  "host:resume-room": (
    payload: ResumeRoomInput,
    ack: (result: Ack<{ snapshot: RoomSnapshot }>) => void,
  ) => void;
  "host:start-game": (
    payload: { roomCode: string },
    ack: (result: Ack<{ snapshot: RoomSnapshot }>) => void,
  ) => void;
  "host:close-room": (
    payload: { roomCode: string },
    ack: (result: Ack<{ closed: true }>) => void,
  ) => void;
  "player:join": (
    payload: JoinRoomInput,
    ack: (result: Ack<PlayerJoinPayload>) => void,
  ) => void;
  "player:stroke-attempt": (
    payload: StrokeAttemptInput,
    ack: (result: Ack<StrokeResultPayload>) => void,
  ) => void;
  "player:stroke-progress": (payload: StrokeProgressInput) => void;
  "player:quiz-answer": (
    payload: QuizAnswerInput,
    ack: (result: Ack<QuizAnswerResultPayload>) => void,
  ) => void;
}

export interface ServerToClientEvents {
  "room:scores": (payload: { roomCode: string; scores: { playerId: string; score: number }[] }) => void;
  "room:created": (payload: RoomCreatedPayload) => void;
  "room:snapshot": (payload: RoomSnapshot) => void;
  "player:joined": (payload: { players: PublicPlayer[] }) => void;
  "game:started": (payload: { snapshot: RoomSnapshot }) => void;
  "stroke:turn": (payload: StrokeTurnPayload) => void;
  "stroke:result": (payload: StrokeResultPayload) => void;
  "stroke:progress": (payload: StrokeProgressPayload) => void;
  "game:countdown": (payload: GameCountdownPayload) => void;
  "quiz:answer-result": (payload: QuizAnswerResultPayload) => void;
  "quiz:reveal": (payload: { snapshot: RoomSnapshot }) => void;
  "game:finished": (payload: GameFinishedPayload) => void;
  "room:closed": (payload: { reason: "host_closed" }) => void;
  "room:error": (payload: CommandError) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  role?: "host" | "player";
  roomCode?: string;
  playerId?: string;
  teacherId?: string;
}

export const MAX_PLAYERS = 30;
export const MAX_NICKNAME_LENGTH = 20;
export const MAX_STROKE_POINTS = 2048;
export const DEFAULT_STROKE_TURN_SECONDS = 8;
export const MIN_STROKE_TURN_SECONDS = 3;
export const MAX_STROKE_TURN_SECONDS = 30;
export const ROOM_CODE_PATTERN = /^\d{6}$/;

import type {
  CharacterData,
  ErrorCode,
  GameMode,
  PublicPlayer,
  QuizSnapshot,
  QuizQuestionType,
  RankedPlayer,
  RoomSnapshot,
  RoomStatus,
  WormProgress,
} from "@hanja/contracts";

export interface PlayerState {
  id: string;
  reconnectToken: string;
  socketId: string | null;
  nickname: string;
  score: number;
  joinedAt: string;
  connected: boolean;
  quiz?: RoomQuizState;
  quizFinished?: boolean;
  worm?: WormProgress;
  wormHitAt?: number;
  quizCorrectCount?: number;
  quizLastAnswer?: { questionIndex: number; correct: boolean };
}

export interface RoomState {
  resultKey: string;
  roomCode: string;
  hostToken: string;
  hostSocketId: string | null;
  teacherId?: string;
  gameMode: GameMode;
  character: CharacterData;
  characters: CharacterData[];
  quizQuestions: Array<{
    characterIndex: number;
    questionType: QuizQuestionType;
    promptHint?: string;
  }>;
  characterIndex: number;
  status: RoomStatus;
  currentStrokeIndex: number;
  selectedPlayerId: string | null;
  strokeTurnDurationSeconds: number;
  strokeTurnStartedAt: number | null;
  strokeTurnEndsAt: number | null;
  lastSelectedPlayerId: string | null;
  strokeTurnQueue: string[];
  players: Map<string, PlayerState>;
  createdAt: string;
  expiresAt: number;
}

export interface RoomQuizState extends Omit<QuizSnapshot, "correctChoiceId" | "correctAnswer"> {
  correctChoiceId?: string;
  correctAnswer: string;
  advanceAt?: number;
}

export class GameError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GameError";
  }
}

export function toPublicPlayer(player: PlayerState): PublicPlayer {
  return {
    id: player.id,
    nickname: player.nickname,
    score: player.score,
    connected: player.connected,
  };
}

export function toSnapshot(room: RoomState, playerId?: string): RoomSnapshot {
  const player = playerId ? room.players.get(playerId) : undefined;
  const sourceQuiz = player?.quiz ?? [...room.players.values()].find((candidate) => candidate.quiz)?.quiz;
  const characters = room.characters.map((character) => ({
    char: character.char,
    label: character.label,
    strokeCount: character.strokeData.length,
  }));
  const quiz = sourceQuiz
    ? {
        questionIndex: sourceQuiz.questionIndex,
        totalQuestions: sourceQuiz.totalQuestions,
        questionType: sourceQuiz.questionType,
        promptChar: sourceQuiz.promptChar,
        promptHint: sourceQuiz.promptHint,
        promptLabel: sourceQuiz.phase === "revealed" ? sourceQuiz.promptLabel : "",
        phase: sourceQuiz.phase,
        questionStartedAt: sourceQuiz.questionStartedAt,
        questionEndsAt: sourceQuiz.questionEndsAt,
        correctChoiceId: sourceQuiz.phase === "revealed" ? sourceQuiz.correctChoiceId : undefined,
        correctAnswer: sourceQuiz.phase === "revealed" ? sourceQuiz.correctAnswer : undefined,
        choices: sourceQuiz.choices.map((choice) => ({ ...choice })),
        answers: sourceQuiz.answers.map((answer) => ({ ...answer })),
      }
    : undefined;
  const quizCharacterIndex = sourceQuiz
    ? Math.max(0, room.characters.findIndex((character) => character.char === sourceQuiz.promptChar))
    : room.characterIndex;
  const activeIndex = player?.worm?.characterIndex ?? quizCharacterIndex;
  const activeCharacter = room.characters[activeIndex] ?? room.character;
  return {
    roomCode: room.roomCode,
    gameMode: room.gameMode,
    character: room.gameMode === "meaning_sound_quiz"
      ? { ...activeCharacter, strokeData: [] }
      : structuredClone(activeCharacter),
    characters,
    characterIndex: activeIndex,
    status: room.status,
    currentStrokeIndex: room.currentStrokeIndex,
    selectedPlayerId: room.selectedPlayerId,
    strokeTurnDurationSeconds: room.strokeTurnDurationSeconds,
    strokeTurnStartedAt: room.strokeTurnStartedAt,
    strokeTurnEndsAt: room.strokeTurnEndsAt,
    quiz,
    quizFinished: player?.quizFinished,
    worm: player?.worm ? { ...player.worm } : undefined,
    wormProgress: room.gameMode === "hanja_worm" && !playerId
      ? [...room.players.values()].flatMap((p) => p.worm ? [{ ...p.worm, playerId: p.id }] : [])
      : undefined,
    quizProgress: room.gameMode === "meaning_sound_quiz" && !playerId
      ? [...room.players.values()].flatMap((candidate) => candidate.quiz ? [{
          playerId: candidate.id,
          questionIndex: candidate.quiz.questionIndex,
          totalQuestions: candidate.quiz.totalQuestions,
          promptChar: candidate.quiz.promptChar,
          promptHint: candidate.quiz.promptHint,
          questionType: candidate.quiz.questionType,
          phase: candidate.quizFinished ? "finished" as const : candidate.quiz.phase,
          questionEndsAt: candidate.quiz.questionEndsAt,
          correctCount: candidate.quizCorrectCount ?? 0,
          lastAnswer: candidate.quizLastAnswer,
        }] : [])
      : undefined,
    players: [...room.players.values()].map(toPublicPlayer),
    createdAt: room.createdAt,
  };
}

export function rankPlayers(players: Iterable<PlayerState>): RankedPlayer[] {
  const sorted = [...players].sort(
    (left, right) => right.score - left.score || left.joinedAt.localeCompare(right.joinedAt),
  );
  let previousScore: number | undefined;
  let rank = 0;
  return sorted.map((player, index) => {
    if (player.score !== previousScore) rank = index + 1;
    previousScore = player.score;
    return { ...toPublicPlayer(player), rank };
  });
}

"use client";

import type { GameCountdownPayload, Point, RankedPlayer, RoomSnapshot, StrokeProgressPayload, StrokeProgressPhase, StrokeResultPayload } from "@hanja/contracts";
import type { FormEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HanjaCanvas, type CanvasResultSignal } from "./hanja-canvas";
import { Scoreboard } from "./scoreboard";
import { StatusPill } from "./status-pill";
import { createSocket, serverNow, type HanjaSocket } from "@/lib/socket";
import { errorMessage, judgmentMessage } from "@/lib/feedback";
import { splitHanjaLabel } from "@/lib/hanja-label";
import { resolveQuizQuestionType } from "@/lib/quiz";
import { GameIntroPreloader, GameStartSequence } from "./game-start-sequence";
import { useTurnCue } from "@/lib/use-turn-cue";
import { HanjaWorm } from "./hanja-worm";
import { StudentResultPodium } from "./student-result-podium";
import styles from "./student-experience.module.css";

const LAST_NICKNAME_KEY = "hanja:student:last-nickname";
const AUTO_JOIN_ROOM_KEY = "hanja:student:auto-join-room";

function normalizeRoomCodeInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

function distributedPreloadDelay(playerId: string): number {
  const hash = [...playerId].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
  return 500 + (hash % 2_500);
}

export function StudentGame({ roomCode }: { roomCode: string }) {
  const socketRef = useRef<HanjaSocket | null>(null);
  const quizAnswerInputRef = useRef<HTMLInputElement | null>(null);
  const quizPageRef = useRef<HTMLElement | null>(null);
  const credentialsRef = useRef<{ nickname: string; token?: string } | null>(null);
  const playerIdRef = useRef<string | null>(null);
  const strokeIndexRef = useRef(0);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [nicknameInput, setNicknameInput] = useState("");
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [nickname, setNickname] = useState("");
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [message, setMessage] = useState("닉네임만 입력하면 바로 참여할 수 있어요.");
  const [joining, setJoining] = useState(false);
  const [remoteProgress, setRemoteProgress] = useState<StrokeProgressPayload | null>(null);
  const [resultSignal, setResultSignal] = useState<CanvasResultSignal | null>(null);
  const [turnPulse, setTurnPulse] = useState(0);
  const finishTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const [rankedPlayers, setRankedPlayers] = useState<RankedPlayer[]>([]);
  const [inputLocked, setInputLocked] = useState(false);
  const [nextRoomCodeInput, setNextRoomCodeInput] = useState("");
  const [enteringNextRoom, setEnteringNextRoom] = useState(false);
  const [roomClosed, setRoomClosed] = useState(false);
  const [nowMs, setNowMs] = useState(0);
  const [countdownSchedule, setCountdownSchedule] = useState<GameCountdownPayload | null>(null);
  const [quizAnswerInput, setQuizAnswerInput] = useState("");
  const [miniFeedback, setMiniFeedback] = useState<{
    id: number;
    correct: boolean;
    emoji: string;
    title: string;
    description: string;
  } | null>(null);

  const clearFinishTimer = useCallback(() => {
    if (finishTimerRef.current !== null) {
      window.clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
    }
  }, []);

  const showMiniFeedback = useCallback((correct: boolean, title: string, description: string) => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    setMiniFeedback((previous) => ({
      id: (previous?.id ?? 0) + 1,
      correct,
      emoji: correct ? ["🎉", "😎", "👏", "✨"][Math.floor(Math.random() * 4)]! : ["😅", "🤔", "🙈", "💪"][Math.floor(Math.random() * 4)]!,
      title,
      description,
    }));
    feedbackTimerRef.current = window.setTimeout(() => {
      setMiniFeedback(null);
      feedbackTimerRef.current = null;
    }, 1400);
  }, []);

  const applySnapshot = useCallback((next: RoomSnapshot) => {
    const current = snapshotRef.current;
    if (current && (current.character.char !== next.character.char || current.characterIndex !== next.characterIndex)) {
      setRemoteProgress(null);
      setResultSignal(null);
    }
    if (current?.quiz && next.quiz && (
      current.quiz.questionIndex !== next.quiz.questionIndex
      || resolveQuizQuestionType(current.quiz) !== resolveQuizQuestionType(next.quiz)
    )) {
      setQuizAnswerInput("");
      setMiniFeedback(null);
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    }
    snapshotRef.current = next;
    setSnapshot(next);
    strokeIndexRef.current = next.currentStrokeIndex;
  }, []);

  const finishGame = useCallback((next: RoomSnapshot, ranking?: RankedPlayer[]) => {
    if (ranking) setRankedPlayers(ranking);
    setInputLocked(false);
    setMessage("게임 종료! 최종 순위를 확인하세요.");
    clearFinishTimer();
    applySnapshot(next);
  }, [applySnapshot, clearFinishTimer]);

  const join = useCallback((nicknameToUse: string, reconnectToken?: string) => {
    const socket = socketRef.current;
    if (!socket?.connected || !nicknameToUse.trim()) return;
    setJoining(true);
    socket.timeout(10_000).emit("player:join", { roomCode, nickname: nicknameToUse, reconnectToken }, (error, response) => {
      setJoining(false);
      if (error) { setMessage("입장 확인이 늦어지고 있어요. 연결을 확인한 뒤 다시 참여해 주세요."); return; }
      if (!response.ok) {
        setMessage(errorMessage[response.error.code] ?? response.error.message);
        if (response.error.code === "INVALID_ROOM" || response.error.code === "ROOM_EXPIRED") {
          credentialsRef.current = { nickname: nicknameToUse };
          localStorage.removeItem("hanja:" + roomCode + ":token");
          setRoomClosed(true);
        }
        return;
      }
      setRoomClosed(false);
      setPlayerId(response.data.playerId); playerIdRef.current = response.data.playerId;
      setNickname(response.data.nickname); clearFinishTimer(); setInputLocked(false); setRankedPlayers([]); applySnapshot(response.data.snapshot);
      setMessage(response.data.reconnected ? "이전 점수로 다시 연결했습니다." : "입장 완료! 선생님의 시작 신호를 기다려요.");
      credentialsRef.current = { nickname: response.data.nickname, token: response.data.reconnectToken };
      localStorage.setItem("hanja:" + roomCode + ":nickname", response.data.nickname);
      localStorage.setItem("hanja:" + roomCode + ":token", response.data.reconnectToken);
      localStorage.setItem(LAST_NICKNAME_KEY, response.data.nickname);
    });
  }, [applySnapshot, clearFinishTimer, roomCode]);

  useEffect(() => {
    const socket = createSocket(); socketRef.current = socket;
    const savedToken = localStorage.getItem("hanja:" + roomCode + ":token") ?? undefined;
    const savedNickname = localStorage.getItem("hanja:" + roomCode + ":nickname") ?? localStorage.getItem(LAST_NICKNAME_KEY) ?? "";
    if (savedNickname) credentialsRef.current = { nickname: savedNickname, token: savedToken };
    socket.on("connect", () => {
      setConnected(true);
      const credentials = credentialsRef.current;
      if (credentials) setNicknameInput(credentials.nickname);
      if (credentials?.token) {
        join(credentials.nickname, credentials.token);
        return;
      }
      if (localStorage.getItem(AUTO_JOIN_ROOM_KEY) === roomCode && credentials?.nickname) {
        localStorage.removeItem(AUTO_JOIN_ROOM_KEY);
        join(credentials.nickname);
      }
    });
    socket.on("disconnect", () => { setConnected(false); setMessage("연결을 복구하고 있어요. 점수는 그대로 유지됩니다."); });
    socket.on("room:snapshot", (next) => {
      if (next.status === "finished") { finishGame(next); return; }
      clearFinishTimer(); setInputLocked(false); applySnapshot(next);
    });
    socket.on("player:joined", ({ players }) => {
      const current = snapshotRef.current;
      if (current) applySnapshot({ ...current, players });
    });
    socket.on("room:scores", ({ roomCode: updatedRoom, scores }) => {
      const current = snapshotRef.current;
      if (!current || updatedRoom !== roomCode || current.status !== "in_progress") return;
      const byId = new Map(scores.map((player) => [player.playerId, player.score]));
      applySnapshot({ ...current, players: current.players.map((player) => ({ ...player, score: byId.get(player.id) ?? player.score })) });
    });
    socket.on("game:countdown", (schedule) => {
      setCountdownSchedule(schedule);
      setNowMs(serverNow(socket));
      setMessage("도깨비와 함께 게임을 시작할 준비를 해요.");
    });
    socket.on("game:started", ({ snapshot: next }) => {
      setCountdownSchedule(null); clearFinishTimer(); setInputLocked(false); setRankedPlayers([]); applySnapshot(next); setMessage("\uAC8C\uC784\uC774 \uC2DC\uC791\uB410\uC5B4\uC694!");
    });
    socket.on("stroke:turn", ({ selectedPlayerId, selectedPlayerNickname, strokeIndex, durationSeconds, turnStartedAt, turnEndsAt }) => {
      setNowMs(serverNow(socket));
      const current = snapshotRef.current;
      if (current) {
        applySnapshot({
          ...current,
          selectedPlayerId,
          currentStrokeIndex: strokeIndex,
          strokeTurnDurationSeconds: durationSeconds,
          strokeTurnStartedAt: turnStartedAt,
          strokeTurnEndsAt: turnEndsAt,
        });
      }
      strokeIndexRef.current = strokeIndex; setRemoteProgress(null); setTurnPulse((value) => value + 1);
      const mine = selectedPlayerId === playerIdRef.current;
      setMessage(mine ? "내 차례! 시작 위치와 방향을 스스로 찾아 그어 보세요." : selectedPlayerNickname + " 학생의 획을 함께 보고 있어요.");
    });
    socket.on("stroke:progress", setRemoteProgress);
    socket.on("stroke:result", (result) => {
      const celebrate = result.playerId === playerIdRef.current;
      if (celebrate) setMessage(judgmentMessage[result.reason]);
      if (celebrate && result.correct && result.strokeIndex === (snapshotRef.current?.character.strokeData.length ?? 0) - 1) {
        // Keep the reward outside the character canvas; never hold back the next server turn.
        showMiniFeedback(true, "한자 완성!", `참 잘했어요 · +${result.scoreDelta}점`);
      }
      setResultSignal((previous) => ({ id: (previous?.id ?? 0) + 1, result, celebrate }));
    });
    socket.on("quiz:answer-result", (result) => {
      applySnapshot(result.snapshot);
      if (result.playerId === playerIdRef.current) {
        setMessage(result.correct ? `정답! +${result.scoreDelta}점` : result.attemptNumber < 2 ? "한 번 더! 다시 골라 보세요." : "아쉬워요. 정답 공개를 기다려요.");
        showMiniFeedback(
          result.correct,
          result.correct ? "정답!" : result.attemptNumber < 2 ? "한 번 더!" : "아쉬워요",
          result.correct ? `+${result.scoreDelta}점 획득` : result.attemptNumber < 2 ? "기회가 한 번 남았어요." : "다음 문제에서 다시 도전해요.",
        );
      }
    });
    socket.on("quiz:reveal", ({ snapshot: next }) => {
      applySnapshot(next);
      setMessage("정답을 확인하고 다음 문제를 준비해요.");
    });
    socket.on("game:finished", ({ rankedPlayers: ranking, snapshot: next }) => { finishGame(next, ranking); });
    socket.on("room:closed", () => {
      clearFinishTimer();
      setInputLocked(false);
      setCountdownSchedule(null);
      setRankedPlayers([]);
      setMiniFeedback(null);
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
      if (credentialsRef.current) credentialsRef.current = { nickname: credentialsRef.current.nickname };
      setRoomClosed(true);
      setSnapshot(null);
      snapshotRef.current = null;
      setPlayerId(null);
      playerIdRef.current = null;
      localStorage.removeItem("hanja:" + roomCode + ":token");
      setMessage("선생님이 게임을 중단했어요. 새 방 코드가 있으면 같은 닉네임으로 다시 들어갈 수 있어요.");
    });
    socket.connect();
    return () => {
      clearFinishTimer();
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
      socket.disconnect(); socket.removeAllListeners(); socketRef.current = null;
    };
  }, [applySnapshot, clearFinishTimer, finishGame, join, roomCode, showMiniFeedback]);

  useEffect(() => {
    if (!countdownSchedule && snapshot?.status !== "in_progress") return;
    const timer = window.setInterval(() => setNowMs(serverNow(socketRef.current)), countdownSchedule ? 100 : 200);
    return () => window.clearInterval(timer);
  }, [countdownSchedule, snapshot?.gameMode, snapshot?.quiz?.questionIndex, snapshot?.status]);

  const countdownStep = countdownSchedule && nowMs >= countdownSchedule.introEndsAt
    ? Math.ceil(Math.max(0, countdownSchedule.startsAt - nowMs) / 1000)
    : 0;

  useEffect(() => {
    if (countdownStep < 1 || countdownStep > 3 || !("vibrate" in navigator)) return;
    navigator.vibrate(countdownStep === 1 ? [90, 35, 90] : [75]);
  }, [countdownStep]);

  const activeQuizQuestionType = resolveQuizQuestionType(snapshot?.quiz);
  const turnCueKey = connected && !inputLocked && !countdownSchedule
    && snapshot?.status === "in_progress" && snapshot.gameMode === "stroke_battle"
    && snapshot.selectedPlayerId === playerId
    ? `${roomCode}:${snapshot.characterIndex}:${snapshot.currentStrokeIndex}:${snapshot.strokeTurnStartedAt}`
    : null;
  const turnCue = useTurnCue(turnCueKey);
  const activeQuizInputKey = snapshot?.status === "in_progress"
    && !snapshot.quizFinished
    && snapshot.gameMode === "meaning_sound_quiz"
    && snapshot.quiz?.phase === "question"
    && activeQuizQuestionType.endsWith("_input")
      ? `${snapshot.quiz.questionIndex}:${activeQuizQuestionType}`
      : null;
  const isActiveQuiz = snapshot?.status === "in_progress"
    && !snapshot.quizFinished
    && snapshot.gameMode === "meaning_sound_quiz";

  useLayoutEffect(() => {
    const page = quizPageRef.current;
    if (!isActiveQuiz) {
      document.body.classList.remove("studentQuizBodyLocked");
      page?.style.removeProperty("height");
      page?.style.removeProperty("--student-viewport-height");
      page?.removeAttribute("data-compact-viewport");
      return;
    }
    const viewport = window.visualViewport;
    const updateHeight = () => {
      const height = Math.floor(viewport?.height ?? window.innerHeight);
      page?.style.setProperty("height", `${height}px`);
      page?.style.setProperty("--student-viewport-height", `${height}px`);
      // Mobile keyboards can shrink only the visual viewport, leaving CSS
      // height media queries unchanged. Keep the compact layout in sync too.
      page?.setAttribute("data-compact-viewport", String(height <= 560));
      window.scrollTo(0, 0);
    };
    document.body.classList.add("studentQuizBodyLocked");
    updateHeight();
    viewport?.addEventListener("resize", updateHeight);
    viewport?.addEventListener("scroll", updateHeight);
    window.addEventListener("resize", updateHeight);
    return () => {
      document.body.classList.remove("studentQuizBodyLocked");
      page?.removeAttribute("data-compact-viewport");
      page?.style.removeProperty("--student-viewport-height");
      viewport?.removeEventListener("resize", updateHeight);
      viewport?.removeEventListener("scroll", updateHeight);
      window.removeEventListener("resize", updateHeight);
    };
  }, [isActiveQuiz]);

  useEffect(() => {
    if (!activeQuizInputKey) return;
    let cancelled = false;
    const inputToBlur = quizAnswerInputRef.current;
    const focusAndShowKeyboard = () => {
      if (cancelled) return;
      const input = quizAnswerInputRef.current;
      if (!input || input.disabled) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      const virtualKeyboard = (navigator as Navigator & {
        virtualKeyboard?: { show?: () => void; hide?: () => void };
      }).virtualKeyboard;
      try {
        virtualKeyboard?.show?.();
      } catch {
        // Some mobile browsers expose the API but still require a direct user gesture.
      }
      window.scrollTo(0, 0);
    };
    const frame = window.requestAnimationFrame(focusAndShowKeyboard);
    const retry = window.setTimeout(focusAndShowKeyboard, 180);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(retry);
      inputToBlur?.blur();
      try {
        (navigator as Navigator & { virtualKeyboard?: { hide?: () => void } }).virtualKeyboard?.hide?.();
      } catch {
        // The input disappearing normally closes the keyboard; this is only an extra supported-browser hint.
      }
    };
  }, [activeQuizInputKey]);

  async function submitStroke(points: Point[]): Promise<StrokeResultPayload | null> {
    const socket = socketRef.current;
    if (!socket?.connected) return null;
    return new Promise((resolve) => {
      socket.timeout(8_000).emit("player:stroke-attempt", { roomCode, points }, (error, response) => {
        if (error) { resolve(null); return; }
        if (!response.ok) { setMessage(errorMessage[response.error.code] ?? response.error.message); resolve(null); return; }
        resolve(response.data);
      });
    });
  }

  function streamStroke(phase: StrokeProgressPhase, sequence: number, points: Point[]) {
    if (phase === "start") turnCue.onStrokeStart();
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.volatile.emit("player:stroke-progress", { roomCode, strokeIndex: strokeIndexRef.current, sequence, phase, points, replace: true });
  }

  function submitQuizAnswer(choiceId?: string, answerText?: string) {
    const socket = socketRef.current;
    if (!socket?.connected || !snapshot?.quiz || snapshot.quiz.phase !== "question") return;
    socket.emit("player:quiz-answer", { roomCode, choiceId, answerText, questionIndex: snapshot.quiz.questionIndex }, (response) => {
      if (!response.ok) {
        setMessage(errorMessage[response.error.code] ?? response.error.message);
        return;
      }
      if (response.data.correct) setQuizAnswerInput("");
      setMessage(response.data.correct ? `정답! +${response.data.scoreDelta}점` : response.data.attemptNumber < 2 ? "한 번 더! 다시 풀어 보세요." : "아쉬워요. 정답 공개를 기다려요.");
    });
  }

  function enterNextRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextRoomCode = normalizeRoomCodeInput(nextRoomCodeInput);
    if (nextRoomCode.length !== 6) {
      setMessage("\uC0C8 \uBC29 \uCF54\uB4DC 6\uC790\uB9AC\uB97C \uC785\uB825\uD574 \uC8FC\uC138\uC694.");
      return;
    }
    if (nextRoomCode === roomCode) {
      setMessage("\uD604\uC7AC \uBC29\uC774 \uC544\uB2CC \uC0C8 \uBC29 \uCF54\uB4DC\uB97C \uC785\uB825\uD574 \uC8FC\uC138\uC694.");
      return;
    }
    const nicknameToReuse = nickname || nicknameInput || localStorage.getItem(LAST_NICKNAME_KEY) || "";
    if (!nicknameToReuse.trim()) {
      setMessage("\uB2E4\uC2DC \uC0AC\uC6A9\uD560 \uB2C9\uB124\uC784\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC5B4\uC694. QR \uC785\uC7A5 \uD654\uBA74\uC5D0\uC11C \uB2C9\uB124\uC784\uC744 \uB2E4\uC2DC \uC785\uB825\uD574 \uC8FC\uC138\uC694.");
      return;
    }
    localStorage.setItem(LAST_NICKNAME_KEY, nicknameToReuse.trim());
    localStorage.setItem(AUTO_JOIN_ROOM_KEY, nextRoomCode);
    setEnteringNextRoom(true);
    setMessage(nicknameToReuse.trim() + " \uB2C9\uB124\uC784\uC73C\uB85C \uC0C8 \uBC29\uC5D0 \uB4E4\uC5B4\uAC00\uACE0 \uC788\uC5B4\uC694.");
    window.location.assign("/join/" + nextRoomCode);
  }

  const nextRoomForm = (
    <form className="nextRoomForm" onSubmit={enterNextRoom}>
      <label className="inputLabel" htmlFor="next-room-code">새로운 방에 들어가기</label>
      <div className="roomCodeEntry">
        <input id="next-room-code" inputMode="numeric" maxLength={6}
          onChange={(event) => setNextRoomCodeInput(normalizeRoomCodeInput(event.target.value))}
          placeholder="코드 6자리" value={nextRoomCodeInput} />
        <button className="secondaryButton" disabled={enteringNextRoom || nextRoomCodeInput.length !== 6} type="submit">
          {enteringNextRoom ? "입장 중" : "입장"}
        </button>
      </div>
      <p><strong>{nickname || nicknameInput}</strong> 닉네임으로 바로 들어갑니다.</p>
    </form>
  );

  if (roomClosed) {
    return (
      <main className={`studentPage joinPage ${styles.experience}`}>
        <header className="studentHeader"><span className="brandStamp">漢</span><StatusPill connected={connected} /></header>
        <section className="roomClosedCard surface">
          <p className="kicker">다음 게임 준비</p>
          <h1>새 방에서<br />계속할까요?</h1>
          <p className="notice" role="status">{message}</p>
          {nextRoomForm}
        </section>
      </main>
    );
  }

  if (!playerId || !snapshot) {
    return (
      <main className={`studentPage joinPage ${styles.experience}`}>
        <header className="studentHeader"><span className="brandStamp">漢</span><StatusPill connected={connected} /></header>
        <section className="joinCard surface">
          <div className="roomMiniTag">참여 코드 {roomCode}</div>
          <div className="joinIllustration" aria-hidden="true"><span>木</span><span>水</span><strong>漢</strong></div>
          <p className="kicker">오늘의 한자 플레이</p><h1>어떤 이름으로<br />참여할까요?</h1>
          <label className="inputLabel" htmlFor="nickname">학생 닉네임</label>
          <input id="nickname" maxLength={20} value={nicknameInput} onChange={(event) => setNicknameInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") join(nicknameInput, credentialsRef.current?.token); }}
            placeholder="예: 민준" autoComplete="nickname" />
          <button className="primaryButton" disabled={!connected || joining || !nicknameInput.trim()}
            onClick={() => join(nicknameInput, credentialsRef.current?.token)} type="button">
            <span>{joining ? "입장하는 중…" : "배틀 참여하기"}</span><span>→</span>
          </button>
          <p className="notice" role="status">{message}</p>
        </section>
      </main>
    );
  }

  const isSelectedTurn = snapshot.status === "in_progress" && snapshot.selectedPlayerId === playerId;
  const isResolvingOwnTurn = isSelectedTurn && inputLocked;
  const isMyTurn = isSelectedTurn && !inputLocked;
  const completedCount = snapshot.status === "finished" ? snapshot.character.strokeData.length : snapshot.currentStrokeIndex;
  const activeNickname = snapshot.players.find((candidate) => candidate.id === snapshot.selectedPlayerId)?.nickname ?? "\uCE5C\uAD6C";
  const characterInfo = splitHanjaLabel(snapshot.character.label);
  const ownQuizAnswers = snapshot.quiz?.answers.filter((answer) => answer.playerId === playerId) ?? [];
  const latestOwnQuizAnswer = ownQuizAnswers.at(-1);
  const quizAttemptCount = latestOwnQuizAnswer?.attemptNumber ?? 0;
  const quizFinalized = Boolean(latestOwnQuizAnswer?.correct || (latestOwnQuizAnswer && latestOwnQuizAnswer.attemptNumber == null) || quizAttemptCount >= 2 || snapshot.quiz?.phase === "revealed");
  const myScore = snapshot.players.find((candidate) => candidate.id === playerId)?.score ?? 0;
  const myRank = snapshot.players.filter((candidate) => candidate.score > myScore).length + 1;
  const tiedRank = snapshot.players.filter((candidate) => candidate.score === myScore).length > 1;
  const rankLabel = `${tiedRank ? "공동 " : ""}${myRank}위`;
  const liveRank = <span className="liveRank" aria-label={`현재 순위 ${rankLabel}, ${snapshot.players.length}명 중`}><strong key={rankLabel}>{rankLabel}</strong><small>/{snapshot.players.length}명</small></span>;
  const finalOwnRank = rankedPlayers.find((player) => player.id === playerId)?.rank;
  const effectiveNowMs = nowMs || snapshot.quiz?.questionStartedAt || 0;
  const quizRemainingMs = snapshot.quiz ? Math.max(0, snapshot.quiz.questionEndsAt - effectiveNowMs) : 0;
  const quizDurationMs = snapshot.quiz ? Math.max(1, snapshot.quiz.questionEndsAt - snapshot.quiz.questionStartedAt) : 1;
  const quizRemainingSeconds = Math.ceil(quizRemainingMs / 1000);
  const quizProgressPercent = Math.max(0, Math.min(100, (quizRemainingMs / quizDurationMs) * 100));
  const strokeTurnRemainingMs = snapshot.strokeTurnEndsAt === null
    ? 0
    : Math.max(0, snapshot.strokeTurnEndsAt - (nowMs || snapshot.strokeTurnStartedAt || 0));
  const strokeTurnRemainingSeconds = Math.ceil(strokeTurnRemainingMs / 1000);
  const strokeTurnProgressPercent = Math.max(0, Math.min(100, (strokeTurnRemainingMs / Math.max(1, snapshot.strokeTurnDurationSeconds * 1000)) * 100));
  const strokeTurnUrgent = strokeTurnRemainingSeconds > 0 && strokeTurnRemainingSeconds <= 3;
  const quizQuestionType = resolveQuizQuestionType(snapshot.quiz);
  const isQuizInputQuestion = quizQuestionType.endsWith("_input");
  const quizQuestionLabel = quizQuestionType.startsWith("reading") ? "음을 쓰세요" : "뜻을 쓰세요";
  const quizQuestionTitle = quizQuestionType === "legacy_choice" ? "이 한자의 뜻·음은?" : quizQuestionType === "hanja_choice" ? "음과 뜻에 맞는 한자는?" : quizQuestionType.startsWith("reading") ? "이 한자의 음은?" : "이 한자의 뜻은?";
  const turnStateClass = snapshot.status === "in_progress"
    ? isMyTurn
      ? "studentMyTurn"
      : isResolvingOwnTurn
        ? "studentResolvingTurn"
        : "studentWatchTurn"
    : "";

  return (
    <main
      className={`studentPage playPage ${styles.experience} ${turnStateClass} ${snapshot.status === "in_progress" && snapshot.gameMode === "stroke_battle" ? "studentStrokePage" : ""} ${snapshot.status === "in_progress" && !snapshot.quizFinished && snapshot.gameMode === "meaning_sound_quiz" ? "studentQuizPage" : ""}`}
      ref={quizPageRef}
    >
      <GameStartSequence schedule={countdownSchedule} nowMs={nowMs} variant="mobile" />
      {snapshot.status === "waiting" && <GameIntroPreloader delayMs={distributedPreloadDelay(playerId)} variant="mobile" />}
      <header className="studentHeader"><div><span className="brandStamp">漢</span><strong>{nickname}</strong></div><div className="studentHeaderActions">
        {snapshot.gameMode === "stroke_battle" && snapshot.status !== "finished" && <button className="turnSoundButton" type="button" onClick={turnCue.toggleSound} aria-label="내 차례 알림 소리" aria-pressed={turnCue.soundEnabled}>{turnCue.soundEnabled ? "🔔" : "🔕"}</button>}
        <StatusPill connected={connected} /></div></header>
      {snapshot.status === "waiting" && (
        <section className="waitingCard surface">
          <div className={styles.lobbyMeta}><span>참여 완료</span><span>{snapshot.players.length}명 함께하는 중</span></div>
          <div className="waitingGlyph">{snapshot.character.char}</div>
          <p className={styles.lobbyWord}>{snapshot.character.label}</p>
          <p className="kicker">준비됐나요?</p>
          <h1>선생님의 시작 신호를<br />기다리고 있어요</h1><div className="waitingPulse" aria-hidden="true"><span /><span /><span /></div>
          <p className="notice" role="status">{connected ? "곧 이 화면에서 게임이 시작돼요." : message}</p>
          {snapshot.gameMode === "stroke_battle" && <div className="turnAlertCheck"><button className="secondaryButton" type="button" onClick={turnCue.testAlerts}>진동·소리 확인</button><p role="status">{turnCue.alertStatus || "시작 전에 눌러 내 차례 알림을 확인해요."}</p></div>}
        </section>
      )}
      {snapshot.status === "in_progress" && snapshot.gameMode === "hanja_worm" && snapshot.worm && !snapshot.worm.finished && (
        <HanjaWorm key={snapshot.characterIndex} snapshot={snapshot} connected={connected} score={myScore} rank={liveRank} reachTarget={(point) => new Promise<boolean>((resolve) => {
          const socket = socketRef.current;
          if (!socket?.connected || !snapshot.worm) { resolve(false); return; }
          socket.timeout(8000).emit("player:worm-target", { roomCode, characterIndex: snapshot.characterIndex, targetIndex: snapshot.worm.targetIndex, point }, (error, response) => {
            if (error || !response?.ok) { resolve(false); return; }
            if (response.data.snapshot.characterIndex !== snapshot.characterIndex || response.data.snapshot.worm?.finished) {
              clearFinishTimer();
              const current = snapshotRef.current;
              if (current) applySnapshot({ ...current, players: response.data.snapshot.players });
              finishTimerRef.current = window.setTimeout(() => {
                applySnapshot({ ...response.data.snapshot, players: snapshotRef.current?.players ?? response.data.snapshot.players });
                finishTimerRef.current = null;
              }, 600);
            } else applySnapshot(response.data.snapshot);
            resolve(true);
          });
        })} reportHit={(hitNumber) => new Promise<boolean>((resolve) => {
          const socket = socketRef.current;
          if (!socket?.connected) { resolve(false); return; }
          socket.timeout(8000).emit("player:worm-hit", { roomCode, hitNumber }, (error, response) => {
            if (error || !response?.ok) { resolve(false); return; }
            applySnapshot(response.data.snapshot);
            resolve(true);
          });
        })} />
      )}
      {snapshot.status === "in_progress" && !snapshot.quizFinished && snapshot.gameMode !== "hanja_worm" && (
        <section className="mobileBattle">
          {snapshot.gameMode === "meaning_sound_quiz" && snapshot.quiz ? (
            <section className={`studentQuizPanel surface ${isQuizInputQuestion ? "quizInputPanel" : "quizChoicePanel"}`} data-question-type={quizQuestionType}>
              <div className="studentGameHud">
                <span>내 점수 <strong>{myScore}</strong>점</span>
                {liveRank}
                <span>문제 {snapshot.quiz.questionIndex + 1}/{snapshot.quiz.totalQuestions}</span>
              </div>
              <div className="quizTimer" aria-label={quizFinalized ? "다음 문제로 이동 중" : `남은 시간 ${quizRemainingSeconds}초`}>
                <div>{quizFinalized ? <span>다음 문제로 이동 중</span> : <><strong>{quizRemainingSeconds}</strong><span>초</span></>}</div>
                {!quizFinalized && <i style={{ width: quizProgressPercent + "%" }} />}
              </div>
              <div className={`quizPromptMobile${quizQuestionType === "hanja_choice" ? " wordPrompt" : ""}`}>{quizQuestionType === "hanja_choice" ? snapshot.quiz.promptHint : snapshot.quiz.promptChar}</div>
              <h1>{snapshot.quiz.phase === "revealed" ? "정답 확인" : quizQuestionTitle}</h1>
              {isQuizInputQuestion ? (
                <div className="quizInputAnswerArea">
                  {snapshot.quiz.promptHint && (
                    <div className="quizReadingHint" aria-label={`뜻 힌트 ${snapshot.quiz.promptHint}`}>
                      <small>뜻 힌트</small>
                      <strong>{snapshot.quiz.promptHint}</strong>
                    </div>
                  )}
                  <form
                    className="studentQuizInputForm"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitQuizAnswer(undefined, quizAnswerInput);
                    }}
                  >
                    <label htmlFor="quiz-answer-input">{quizQuestionLabel}</label>
                    <div className="quizInputRow">
                      <input
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        autoFocus
                        disabled={quizFinalized}
                        enterKeyHint="send"
                        id="quiz-answer-input"
                        inputMode="text"
                        maxLength={20}
                        onChange={(event) => setQuizAnswerInput(event.target.value)}
                        placeholder="한자의 음 입력"
                        ref={quizAnswerInputRef}
                        spellCheck={false}
                        value={quizAnswerInput}
                      />
                      <button className="primaryButton" disabled={quizFinalized || !quizAnswerInput.trim()} type="submit">
                        제출
                      </button>
                    </div>
                    {snapshot.quiz.phase === "revealed" && <p>정답: <strong>{snapshot.quiz.correctAnswer}</strong></p>}
                  </form>
                </div>
              ) : (
                <div className={`studentQuizChoices${quizQuestionType === "hanja_choice" ? " hanjaChoices" : ""}`}>
                  {snapshot.quiz.choices.map((choice, choiceIndex) => {
                    const selected = latestOwnQuizAnswer?.choiceId === choice.id;
                    const correct = snapshot.quiz?.correctChoiceId === choice.id;
                    const showCorrect = snapshot.quiz?.phase === "revealed" || Boolean(latestOwnQuizAnswer?.correct);
                    return (
                      <button
                        className={[selected ? "selected" : "", selected && latestOwnQuizAnswer && !latestOwnQuizAnswer.correct ? "incorrect" : "", showCorrect && correct ? "correct" : ""].filter(Boolean).join(" ")}
                        disabled={quizFinalized}
                        key={`${choice.id}-${choiceIndex}`}
                        onClick={() => submitQuizAnswer(choice.id)}
                        type="button"
                      >
                        <strong>{choice.label}</strong>
                        {showCorrect && correct && <span>정답</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="mobileHint">{quizFinalized
                ? latestOwnQuizAnswer ? "답을 냈어요. 바로 다음 문제로 넘어갑니다." : "시간이 끝났어요. 바로 다음 문제로 넘어갑니다."
                : quizAttemptCount > 0 ? "한 번 더 시도할 수 있어요." : "빠르게 맞힐수록 점수가 높아요."}</p>
              {miniFeedback && (
                <div key={`quiz-feedback-${miniFeedback.id}`} className={`miniGameFeedback ${miniFeedback.correct ? "correct" : "incorrect"}`} role="status" aria-live="assertive">
                  <span>{miniFeedback.emoji}</span>
                  <strong>{miniFeedback.title}</strong>
                  <small>{miniFeedback.description}</small>
                </div>
              )}
            </section>
          ) : (
            <>
              {isMyTurn ? (
                <div key={`stroke-turn-my-${turnPulse}-${turnCue.reminded}`} className={`turnCallout myTurnCallout${turnCue.awaitingInput ? " flashTurn" : ""}${strokeTurnUrgent ? " urgent" : ""}`}>
                  <div className="turnStatusRow"><span className="turnBadge">내 차례</span><span className="turnClock"><strong>{strokeTurnRemainingSeconds}</strong>초</span></div>
                  <strong className={`turnHeadline${nickname.length > 12 ? " longName" : ""}`} role="status" aria-live="assertive">{nickname}님, 지금 쓰세요!</strong>
                  <span className="turnDescription">{turnCue.reminded ? "아직 내 차례예요. 한 획을 그어 보세요!" : "화면을 손가락으로 한 획 그어 진행하세요."}</span>
                  <div className="strokeTurnTrack" aria-hidden="true"><i style={{ width: strokeTurnProgressPercent + "%" }} /></div>
                </div>
              ) : isResolvingOwnTurn ? (
                <div key={`stroke-turn-resolving-${turnPulse}`} className="turnCallout resolvingTurnCallout" role="status" aria-live="polite">
                  <div className="turnStatusRow"><span className="turnBadge">제출 완료</span><span className="turnClock">판정 중</span></div>
                  <strong className="turnHeadline">획을 확인하고 있어요</strong>
                  <span className="turnDescription">정답이면 바로 다음 획으로 넘어갑니다.</span>
                </div>
              ) : (
                <div key={`stroke-turn-watch-${turnPulse}`} className={`turnCallout watchTurnCallout${strokeTurnUrgent ? " urgent" : ""}`} role="status" aria-live="polite">
                  <div className="turnStatusRow"><span className="turnBadge">친구 획 보기</span><span className="turnClock"><strong>{strokeTurnRemainingSeconds}</strong>초</span></div>
                  <strong className="turnHeadline">{activeNickname} 학생 차례</strong>
                  <span className="turnDescription">친구가 그리는 획을 화면에서 함께 보세요.</span>
                  <div className="strokeTurnTrack" aria-hidden="true"><i style={{ width: strokeTurnProgressPercent + "%" }} /></div>
                </div>
              )}
              <div className="mobileProgress">
                <span>{snapshot.character.char}</span>
                <div>
                  <p>{"\uC9C4\uD589 \uD55C\uC790 \u00B7 "}{snapshot.characterIndex + 1}/{snapshot.characters.length}</p>
                  <strong><small>{"\uD604\uC7AC \uD68D "}</small>{snapshot.currentStrokeIndex + 1}<small>{" / "}{snapshot.character.strokeData.length}</small></strong>
                  <div className="characterReading">
                    <span>
                      {characterInfo.meaning
                        ? characterInfo.meaning + (characterInfo.reading ? " (" + characterInfo.reading + ")" : "")
                        : characterInfo.baseLabel || "\uB73B\uACFC \uC74C\uC744 \uD655\uC778\uD574 \uBCF4\uC138\uC694"}
                    </span>
                  </div>
                </div>
                <div className="progressTrack"><i style={{ width: (snapshot.currentStrokeIndex / snapshot.character.strokeData.length) * 100 + "%" }} /></div>
              </div>
              <div className="studentStrokeHud"><span>내 점수 <strong>{myScore}</strong>점</span>{liveRank}</div>
              <div className="strokeCanvasStage">
                <HanjaCanvas key={snapshot.character.char + ":" + snapshot.characterIndex} strokes={snapshot.character.strokeData} activeStrokeIndex={snapshot.currentStrokeIndex}
                  completedCount={completedCount} canDraw={isMyTurn && connected}
                  turnAttention={turnCue.awaitingInput}
                  pathCoordinateSystem={snapshot.character.pathCoordinateSystem} submitStroke={submitStroke}
                  streamStroke={streamStroke} remoteProgress={remoteProgress} resultSignal={resultSignal}
                  observerLabel={isSelectedTurn ? undefined : activeNickname + " \uD559\uC0DD\uC758 \uD68D\uC744 \uBCF4\uACE0 \uC788\uC5B4\uC694"}
                  resetKey={snapshot.character.char + ":" + snapshot.characterIndex} />
              </div>
              {!isMyTurn && (
                <p className="mobileHint">{isResolvingOwnTurn ? "\uD68D\uC744 \uD655\uC778\uD558\uACE0 \uC788\uC5B4\uC694." : "친구의 획은 보이지만, 내 차례가 아니면 입력되지 않아요."}</p>
              )}
            </>
          )}
        </section>
      )}
      {(snapshot.status === "finished" || snapshot.quizFinished || snapshot.worm?.finished) && (
        <section className={`resultCard surface ${styles.result}`}>
          <div className="resultGlyph">{snapshot.character.char}</div><p className="kicker">BATTLE COMPLETE</p>
          <h1>{snapshot.worm?.eliminated ? <>이번 도전은<br />여기까지!</> : snapshot.status === "finished" ? <>모두 함께<br />게임을 마쳤어요</> : snapshot.worm?.finished ? <>내 한자를<br />모두 완성했어요!</> : <>내 문제를<br />모두 풀었어요!</>}</h1>
          {snapshot.worm?.eliminated && <p className="notice">벌레에 3번 닿았어요. 완성한 획의 점수는 그대로 남아요.</p>}
          {snapshot.status !== "finished" && <p className="notice">친구들은 도전 중! 실시간 순위를 확인하세요.</p>}
          <div className={styles.myResult}>
            <span>내 점수 <strong>{myScore.toLocaleString("ko-KR")}</strong>점</span>
            {finalOwnRank != null ? <span>{finalOwnRank}위</span> : liveRank}
          </div>
          {rankedPlayers.length > 0 ? <>
            <StudentResultPodium players={rankedPlayers} highlightPlayerId={playerId} />
            <details className={styles.allRanks}>
              <summary>전체 순위 <span>{rankedPlayers.length}명</span></summary>
              <Scoreboard players={rankedPlayers} highlightPlayerId={playerId} showRanks />
            </details>
          </> : <Scoreboard players={snapshot.players} highlightPlayerId={playerId} showRanks />}
          {nextRoomForm}
          <p className="notice" role="status">{message}</p>
        </section>
      )}
      {snapshot.gameMode === "stroke_battle" && miniFeedback && <div className="strokeTransitionFeedback" role="status"><span aria-hidden="true">{miniFeedback.emoji}</span><div><strong>{miniFeedback.title}</strong><small>{miniFeedback.description}</small></div></div>}
    </main>
  );
}

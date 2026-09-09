"use client";

import type { PathCoordinateSystem, Point, Stroke, StrokeProgressPayload, StrokeProgressPhase, StrokeResultPayload } from "@hanja/contracts";
import { STROKE_COLORS } from "@hanja/stroke-engine";
import HanziWriter from "hanzi-writer";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { judgmentMessage } from "@/lib/feedback";

export interface CanvasResultSignal { id: number; result: StrokeResultPayload; celebrate: boolean; }
interface HanjaCanvasProps {
  strokes: Stroke[]; activeStrokeIndex: number; completedCount: number; canDraw: boolean;
  pathCoordinateSystem?: PathCoordinateSystem;
  submitStroke?: (points: Point[]) => Promise<StrokeResultPayload | null>;
  streamStroke?: (phase: StrokeProgressPhase, sequence: number, points: Point[]) => void;
  remoteProgress?: StrokeProgressPayload | null;
  resultSignal?: CanvasResultSignal | null;
  observerLabel?: string; label?: string; resetKey?: string;
  turnAttention?: boolean;
}
type TrailState = "idle" | "drawing" | "pending" | "correct" | "incorrect";
type CelebrationKind = "correct" | "incorrect";
type CelebrationVariant = "pop" | "confetti" | "stamp" | "sparkle" | "softshake" | "peek" | "think" | "retry";
type CelebrationReaction = {
  kind: CelebrationKind;
  variant: CelebrationVariant;
  emoji: string;
  title: string;
  description: string;
  stamp?: string;
};
type Celebration = CelebrationReaction | null;

const CORRECT_REACTIONS: readonly CelebrationReaction[] = [
  { kind: "correct", variant: "pop", emoji: "😆", title: "좋았어!", description: "획이 정확해요. 다음 획으로 갑니다." },
  { kind: "correct", variant: "confetti", emoji: "🎉", title: "획! 완벽", description: "교실 전체가 한 획 더 완성했어요." },
  { kind: "correct", variant: "stamp", emoji: "👍", title: "바로 그거야", description: "시작과 끝이 잘 맞았어요.", stamp: "정답" },
  { kind: "correct", variant: "sparkle", emoji: "🤩", title: "반짝 정답", description: "방향과 길이가 또렷했어요." },
] as const;

const INCORRECT_REACTIONS: readonly CelebrationReaction[] = [
  { kind: "incorrect", variant: "softshake", emoji: "😅", title: "앗, 다시!", description: "조금 더 천천히 따라 그어 보세요." },
  { kind: "incorrect", variant: "peek", emoji: "🫣", title: "조금 빗나갔어", description: "시작점과 끝점을 다시 확인해요." },
  { kind: "incorrect", variant: "think", emoji: "🤔", title: "한 번 더 생각!", description: "획의 방향을 보고 다시 도전해요." },
  { kind: "incorrect", variant: "retry", emoji: "🙂", title: "괜찮아, 다시!", description: "실패가 아니라 한 번 더 연습이에요.", stamp: "다시" },
] as const;

export function HanjaCanvas({
  strokes, activeStrokeIndex, completedCount, canDraw, pathCoordinateSystem, submitStroke,
  streamStroke, remoteProgress, resultSignal, observerLabel, resetKey, turnAttention = false, label = "한자 획 그리기 캔버스",
}: HanjaCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const celebrationTimerRef = useRef<number | null>(null);
  const pointsRef = useRef<Point[]>([]);
  const remotePointsRef = useRef<Point[]>([]);
  const trailStateRef = useRef<TrailState>("idle");
  const opacityRef = useRef(1);
  const displayedCompletedRef = useRef(completedCount);
  const previousResetKeyRef = useRef(resetKey);
  const fillingStrokeRef = useRef<number | null>(null);
  const fillOpacityRef = useRef(0);
  const sequenceRef = useRef(0);
  const pathCacheRef = useRef(new Map<string, Path2D>());
  const lastStreamAtRef = useRef(0);
  const lastAnimatedResultRef = useRef<{ key: string; at: number } | null>(null);
  const lastCelebrationVariantRef = useRef<CelebrationVariant | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const [feedback, setFeedback] = useState("");
  const [celebration, setCelebration] = useState<Celebration>(null);
  const renderIssue = useMemo(() => strokes.some((stroke) => !stroke.svgPath), [strokes]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(1, Math.min(rect.width, rect.height));
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const pixelSize = Math.round(size * ratio);
    if (canvas.width !== pixelSize || canvas.height !== pixelSize) { canvas.width = pixelSize; canvas.height = pixelSize; }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size, size);
    context.lineCap = "round"; context.lineJoin = "round";

    const fillOutline = (stroke: Stroke, color: string, opacity = 1) => {
      if (!stroke.svgPath) return;
      let path = pathCacheRef.current.get(stroke.svgPath);
      if (!path) { path = new Path2D(stroke.svgPath); pathCacheRef.current.set(stroke.svgPath, path); }
      context.save(); context.globalAlpha = opacity;
      if (pathCoordinateSystem) {
        const isHanziWriter = pathCoordinateSystem.width === 1024 && pathCoordinateSystem.height === 1024 && pathCoordinateSystem.originY === 900 && pathCoordinateSystem.flipY;
        if (isHanziWriter) {
          const transform = HanziWriter.getScalingTransform(size, size, 0);
          context.translate(transform.x, size - transform.y); context.scale(transform.scale, -transform.scale);
        } else {
          const scaleX = size / pathCoordinateSystem.width; const scaleY = size / pathCoordinateSystem.height;
          context.translate(0, pathCoordinateSystem.originY * scaleY);
          context.scale(scaleX, pathCoordinateSystem.flipY ? -scaleY : scaleY);
        }
      } else context.scale(size / 100, size / 100);
      context.fillStyle = color; context.fill(path); context.restore();
    };

    strokes.forEach((stroke) => fillOutline(stroke, STROKE_COLORS.guide));
    strokes.slice(0, displayedCompletedRef.current).forEach((stroke) => fillOutline(stroke, STROKE_COLORS.correct));
    const fillingIndex = fillingStrokeRef.current;
    if (fillingIndex !== null) {
      const stroke = strokes[fillingIndex];
      if (stroke) fillOutline(stroke, STROKE_COLORS.correct, fillOpacityRef.current);
    }

    const localPoints = pointsRef.current;
    const points = localPoints.length > 0 ? localPoints : remotePointsRef.current;
    if (points.length > 0) {
      context.save(); context.globalAlpha = opacityRef.current;
      context.strokeStyle = trailStateRef.current === "incorrect" ? STROKE_COLORS.incorrect : localPoints.length > 0 ? STROKE_COLORS.active : "#2f7de1";
      context.lineWidth = 8; context.beginPath();
      context.moveTo(points[0]!.x * size, points[0]!.y * size);
      for (const point of points.slice(1)) context.lineTo(point.x * size, point.y * size);
      context.stroke(); context.restore();
    }
  }, [pathCoordinateSystem, strokes]);

  const requestRender = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => { frameRef.current = null; render(); });
  }, [render]);

  const showCelebration = useCallback((kind: CelebrationKind) => {
    if (celebrationTimerRef.current !== null) clearTimeout(celebrationTimerRef.current);
    const reactions = kind === "correct" ? CORRECT_REACTIONS : INCORRECT_REACTIONS;
    const candidates = reactions.filter((reaction) => reaction.variant !== lastCelebrationVariantRef.current);
    const pool = candidates.length > 0 ? candidates : reactions;
    const reaction = pool[Math.floor(Math.random() * pool.length)] ?? reactions[0]!;
    lastCelebrationVariantRef.current = reaction.variant;
    setCelebration(null);
    requestAnimationFrame(() => setCelebration(reaction));
    celebrationTimerRef.current = window.setTimeout(() => { setCelebration(null); celebrationTimerRef.current = null; }, 1400);
  }, []);

  const animateResult = useCallback((result: StrokeResultPayload, celebrate = true) => {
    const resultKey = `${result.strokeIndex}:${result.correct}:${result.reason}:${result.scoreDelta}:${result.players.map((player) => `${player.id}:${player.score}`).join("|")}`;
    const now = performance.now();
    if (lastAnimatedResultRef.current?.key === resultKey && now - lastAnimatedResultRef.current.at < 500) return;
    lastAnimatedResultRef.current = { key: resultKey, at: now };
    if (pendingTimerRef.current !== null) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    const source = pointsRef.current.length > 0 ? pointsRef.current : remotePointsRef.current;
    pointsRef.current = [...source]; remotePointsRef.current = []; opacityRef.current = 1;
    setFeedback(celebrate ? judgmentMessage[result.reason] : `${result.nickname} 학생의 획을 확인했어요.`);
    if (celebrate) showCelebration(result.correct ? "correct" : "incorrect");
    const startedAt = performance.now(); const duration = result.correct ? 260 : 300;
    if (result.correct) { trailStateRef.current = "correct"; fillingStrokeRef.current = result.strokeIndex; fillOpacityRef.current = 0; }
    else trailStateRef.current = "incorrect";
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      opacityRef.current = 1 - progress;
      if (result.correct) fillOpacityRef.current = progress;
      render();
      if (progress < 1) { animationFrameRef.current = requestAnimationFrame(step); return; }
      if (result.correct) displayedCompletedRef.current = Math.max(displayedCompletedRef.current, result.strokeIndex + 1);
      fillingStrokeRef.current = null; fillOpacityRef.current = 0; pointsRef.current = [];
      trailStateRef.current = "idle"; opacityRef.current = 1; animationFrameRef.current = null; render();
    };
    animationFrameRef.current = requestAnimationFrame(step);
  }, [render, showCelebration]);

  useEffect(() => {
    if (previousResetKeyRef.current === resetKey) return;
    previousResetKeyRef.current = resetKey;
    if (animationFrameRef.current !== null) { cancelAnimationFrame(animationFrameRef.current); animationFrameRef.current = null; }
    if (celebrationTimerRef.current !== null) { clearTimeout(celebrationTimerRef.current); celebrationTimerRef.current = null; }
    if (pendingTimerRef.current !== null) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    pointsRef.current = []; remotePointsRef.current = [];
    trailStateRef.current = "idle"; opacityRef.current = 1;
    displayedCompletedRef.current = completedCount;
    fillingStrokeRef.current = null; fillOpacityRef.current = 0;
    sequenceRef.current = 0; lastStreamAtRef.current = 0; pathCacheRef.current.clear();
    lastAnimatedResultRef.current = null; lastCelebrationVariantRef.current = null; pointerIdRef.current = null;
    setCelebration(null); setFeedback("");
    requestRender();
  }, [completedCount, resetKey, requestRender]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const observer = new ResizeObserver(requestRender); observer.observe(canvas); render();
    return () => {
      observer.disconnect();
      if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    };
  }, [render, requestRender]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (celebrationTimerRef.current !== null) clearTimeout(celebrationTimerRef.current);
    if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current);
  }, []);

  useEffect(() => {
    if (!remoteProgress) { remotePointsRef.current = []; requestRender(); return; }
    if (canDraw) return;
    if (remoteProgress.strokeIndex !== activeStrokeIndex) return;
    if (remoteProgress.replace) {
      remotePointsRef.current = remoteProgress.points; requestRender(); return;
    }
    if (remoteProgress.phase === "start" || remoteProgress.sequence === 0) remotePointsRef.current = [];
    remotePointsRef.current.push(...remoteProgress.points); requestRender();
  }, [activeStrokeIndex, canDraw, remoteProgress, requestRender]);

  useEffect(() => {
    if (!resultSignal) return;
    const frame = requestAnimationFrame(() => animateResult(resultSignal.result, resultSignal.celebrate));
    return () => cancelAnimationFrame(frame);
  }, [animateResult, resultSignal]);

  useEffect(() => {
    if (completedCount < displayedCompletedRef.current) displayedCompletedRef.current = completedCount;
    else if (completedCount > displayedCompletedRef.current && animationFrameRef.current === null) displayedCompletedRef.current = completedCount;
    render();
  }, [completedCount, render]);

  function normalizedPoint(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  }

  function emitProgress(phase: StrokeProgressPhase, force = false) {
    if (!streamStroke) return;
    const now = performance.now();
    if (!force && now - lastStreamAtRef.current < 50) return;
    // Each preview repairs a dropped frame; final judgment still uses every original point.
    const points = pointsRef.current;
    const count = Math.min(32, points.length);
    const batch = Array.from({ length: count }, (_, index) => {
      const point = points[Math.round(index * (points.length - 1) / Math.max(1, count - 1))]!;
      return { x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 };
    });
    if (batch.length === 0) return;
    streamStroke(phase, sequenceRef.current++, batch);
    lastStreamAtRef.current = now;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    if (!canDraw || trailStateRef.current === "pending" || animationFrameRef.current !== null) return;
    pointerIdRef.current = event.pointerId;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    pointsRef.current = [normalizedPoint(event)]; remotePointsRef.current = [];
    trailStateRef.current = "drawing"; opacityRef.current = 1;
    sequenceRef.current = 0; lastStreamAtRef.current = 0;
    setFeedback("획을 끝까지 그린 뒤 손을 떼 주세요.");
    emitProgress("start", true); requestRender();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    if (trailStateRef.current !== "drawing" || pointerIdRef.current !== event.pointerId) return;
    const point = normalizedPoint(event); const previous = pointsRef.current.at(-1);
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.002) {
      pointsRef.current.push(point); emitProgress("move"); requestRender();
    }
  }

  async function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    if (trailStateRef.current !== "drawing" || pointerIdRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pointerIdRef.current = null;
    pointsRef.current.push(normalizedPoint(event)); emitProgress("end", true);
    trailStateRef.current = "pending"; setFeedback("획을 판정하고 있어요. 잠시만 기다려 주세요."); requestRender();
    if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = window.setTimeout(() => {
      if (trailStateRef.current !== "pending") return;
      trailStateRef.current = "idle";
      pointsRef.current = [];
      pointerIdRef.current = null;
      setFeedback("서버 응답이 늦어졌어요. 다시 한 번 그려 주세요.");
      requestRender();
      pendingTimerRef.current = null;
    }, 8_000);
    const result = (await submitStroke?.([...pointsRef.current])) ?? null;
    if (pendingTimerRef.current !== null) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    if (result) { animateResult(result); return; }
    trailStateRef.current = "idle"; pointsRef.current = []; setFeedback("판정 결과를 받지 못했어요. 다시 그려 주세요."); requestRender();
  }

  return (
    <div className="canvasShell">
      <div className="canvasSafe">
        {canDraw && <svg className={`turnOrbit${turnAttention ? " isMoving" : ""}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <rect x="1" y="1" width="98" height="98" rx="5" vectorEffect="non-scaling-stroke" />
          <rect x="1" y="1" width="98" height="98" rx="5" pathLength="100" vectorEffect="non-scaling-stroke" />
        </svg>}
        <canvas ref={canvasRef} className={"hanjaCanvas " + (canDraw ? "canDraw" : "")} aria-label={label}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
        {!canDraw && observerLabel && <div className="observerCurtain" aria-live="polite"><span>관전 중</span><strong>{observerLabel}</strong></div>}
        {celebration && (
          <div
            className={`strokeCelebration emojiFeedback ${celebration.kind} ${celebration.variant}`}
            role="status"
            aria-live="assertive"
            data-feedback-kind={celebration.kind}
            data-feedback-variant={celebration.variant}
          >
            <div className="emojiScreenFlash" aria-hidden="true" />
            <div className="emojiFx" aria-hidden="true">
              <span className="emojiPiece emojiPieceOne">✦</span>
              <span className="emojiPiece emojiPieceTwo">●</span>
              <span className="emojiPiece emojiPieceThree">✦</span>
              <span className="emojiPiece emojiPieceFour">●</span>
              <span className="emojiInkDrop emojiInkDropOne" />
              <span className="emojiInkDrop emojiInkDropTwo" />
            </div>
            {(celebration.variant === "stamp" || celebration.variant === "retry") && <span className="emojiStamp" aria-hidden="true">{celebration.stamp}</span>}
            {celebration.variant === "think" && <span className="emojiThought" aria-hidden="true">?</span>}
            <div className="emojiStage" aria-hidden="true">
              <div className="emojiShadow" />
              <span className="emojiBubble"><span className="emojiSymbol">{celebration.emoji}</span></span>
            </div>
            <strong>{celebration.title}</strong>
            <small>{celebration.description}</small>
          </div>
        )}
      </div>
      <div className="canvasFeedback" role="status">
        {renderIssue ? "일부 획의 외곽선 정보가 없어 채색을 생략합니다." : feedback || "시작 위치와 획의 방향을 스스로 찾아보세요."}
      </div>
    </div>
  );
}

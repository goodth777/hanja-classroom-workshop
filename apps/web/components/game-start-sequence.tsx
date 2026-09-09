"use client";

import type { GameCountdownPayload } from "@hanja/contracts";
import { useEffect, useRef, useState } from "react";

export const GAME_INTRO_SRC = "/media/dokkaebi-game-intro-v1.mp4";
export const GAME_INTRO_MOBILE_SRC = "/media/dokkaebi-game-intro-mobile-v1.mp4";
type GameIntroVariant = "desktop" | "mobile";

function introSource(variant: GameIntroVariant) {
  return variant === "mobile" ? GAME_INTRO_MOBILE_SRC : GAME_INTRO_SRC;
}

export function GameIntroPreloader({
  variant = "desktop",
  delayMs = 0,
}: {
  variant?: GameIntroVariant;
  delayMs?: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const video = videoRef.current;
      if (!video) return;
      video.src = introSource(variant);
      video.preload = "auto";
      video.load();
    }, Math.max(0, delayMs));
    return () => window.clearTimeout(timer);
  }, [delayMs, variant]);

  return (
    <video
      ref={videoRef}
      aria-hidden="true"
      className="gameIntroPreloader"
      muted
      playsInline
      preload="none"
      tabIndex={-1}
    />
  );
}

export function GameStartSequence({
  schedule,
  nowMs,
  variant = "desktop",
}: {
  schedule: GameCountdownPayload | null;
  nowMs: number;
  variant?: GameIntroVariant;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [failedIntroStartedAt, setFailedIntroStartedAt] = useState<number | null>(null);
  const effectiveNowMs = nowMs || schedule?.introStartedAt || 0;
  const videoFailed = failedIntroStartedAt === schedule?.introStartedAt;
  const showingIntro = Boolean(
    schedule
    && schedule.introEndsAt > schedule.introStartedAt
    && effectiveNowMs < schedule.introEndsAt,
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !schedule || !showingIntro || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const expectedSeconds = Math.max(0, (effectiveNowMs - schedule.introStartedAt) / 1000);
    if (Math.abs(video.currentTime - expectedSeconds) > 0.75) video.currentTime = expectedSeconds;
    if (video.paused) void video.play().catch(() => setFailedIntroStartedAt(schedule.introStartedAt));
  }, [effectiveNowMs, schedule, showingIntro]);

  if (!schedule || effectiveNowMs >= schedule.startsAt) return null;

  if (showingIntro) {
    return (
      <div className="gameIntroOverlay" role="status" aria-live="polite" aria-label="게임 시작 영상 재생 중">
        {videoFailed ? (
          <div className="gameIntroFallback">
            <span aria-hidden="true">획!</span>
            <strong>게임 시작 준비 중</strong>
          </div>
        ) : (
          <video
            ref={videoRef}
            aria-label="도깨비 게임 시작 영상"
            autoPlay
            className="gameIntroVideo"
            disablePictureInPicture
            muted
            onError={() => setFailedIntroStartedAt(schedule.introStartedAt)}
            onLoadedMetadata={(event) => {
              const expectedSeconds = Math.max(0, (effectiveNowMs - schedule.introStartedAt) / 1000);
              event.currentTarget.currentTime = Math.min(expectedSeconds, event.currentTarget.duration || expectedSeconds);
              void event.currentTarget.play().catch(() => setFailedIntroStartedAt(schedule.introStartedAt));
            }}
            playsInline
            preload="auto"
            src={introSource(variant)}
          />
        )}
      </div>
    );
  }

  const countdownStep = Math.ceil(Math.max(0, schedule.startsAt - effectiveNowMs) / 1000);
  const countdownDisplay = countdownStep > 3 ? "READY!" : String(countdownStep);
  return (
    <div className="gameCountdownOverlay" role="status" aria-live="assertive" aria-label={countdownStep > 3 ? "게임 준비" : `게임 시작 ${countdownStep}`}>
      <strong key={countdownDisplay} data-count={countdownStep > 3 ? "ready" : countdownStep}>{countdownDisplay}</strong>
    </div>
  );
}

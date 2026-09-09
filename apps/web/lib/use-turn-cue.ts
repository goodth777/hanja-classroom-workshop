"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Local feedback only: no media download and no extra Socket.IO traffic.
export function useTurnCue(turnKey: string | null) {
  const audioRef = useRef<AudioContext | null>(null);
  const soundRef = useRef(true);
  const alertedRef = useRef<string | null>(null);
  const remindedRef = useRef<string | null>(null);
  const drawnRef = useRef<string | null>(null);
  const [drawnTurn, setDrawnTurn] = useState<string | null>(null);
  const [reminder, setReminder] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [alertStatus, setAlertStatus] = useState("");
  const awaitingInput = turnKey !== null && drawnTurn !== turnKey;

  const unlock = useCallback(() => {
    try {
      if (!audioRef.current && typeof AudioContext !== "undefined") audioRef.current = new AudioContext();
      return audioRef.current?.resume().catch(() => {});
    } catch { /* Visual cues remain available if audio is blocked. */ }
  }, []);

  const playSound = useCallback(() => {
    const audio = audioRef.current;
    if (!soundRef.current || audio?.state !== "running") return;
    for (const [index, frequency] of [660, 880].entries()) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const start = audio.currentTime + index * 0.14;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.09, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.10);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start); oscillator.stop(start + 0.11);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  }, []);

  const vibrate = useCallback(() => {
    if (typeof navigator.vibrate !== "function") return "이 브라우저는 진동을 지원하지 않아요. 소리와 테두리로 알려드려요.";
    try {
      if (navigator.vibrate([180, 80, 180])) return "진동이 느껴졌나요? 없다면 휴대폰의 진동·방해 금지 설정을 확인해 주세요.";
    } catch { /* A denied vibration must not stop the turn cue. */ }
    return "진동 요청이 차단됐어요. 화면을 누르고 다시 확인해 주세요.";
  }, []);

  useEffect(() => {
    // Touch activation is granted on pointerup, not touch pointerdown.
    window.addEventListener("pointerup", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerup", unlock);
      window.removeEventListener("keydown", unlock);
      void audioRef.current?.close().catch(() => {});
      audioRef.current = null;
    };
  }, [unlock]);

  useEffect(() => {
    if (!turnKey || !awaitingInput) return;
    const notify = () => {
      if (document.hidden) return;
      setAlertStatus(vibrate());
      playSound();
    };
    if (alertedRef.current !== turnKey) { alertedRef.current = turnKey; notify(); }
    if (remindedRef.current === turnKey) return;
    const timer = window.setTimeout(() => {
      if (drawnRef.current === turnKey) return;
      remindedRef.current = turnKey;
      setReminder(turnKey);
      notify();
    }, 2_000);
    const onVisible = () => { if (!document.hidden && drawnRef.current !== turnKey) { void unlock()?.then(playSound); setAlertStatus(vibrate()); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [turnKey, awaitingInput, playSound, unlock, vibrate]);

  return {
    awaitingInput,
    reminded: awaitingInput && reminder === turnKey,
    soundEnabled,
    alertStatus,
    testAlerts: () => { setAlertStatus(vibrate()); void unlock()?.then(playSound); },
    toggleSound: () => {
      soundRef.current = !soundRef.current;
      setSoundEnabled(soundRef.current);
    },
    onStrokeStart: () => { drawnRef.current = turnKey; setDrawnTurn(turnKey); },
  };
}

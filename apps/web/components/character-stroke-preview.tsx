"use client";

import type { CharacterData } from "@hanja/contracts";
import HanziWriter, { type CharacterJson } from "hanzi-writer";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { splitHanjaLabel } from "@/lib/hanja-label";
import styles from "./character-stroke-preview.module.css";

function toWriterData(character: CharacterData): CharacterJson {
  return {
    strokes: character.strokeData.map((stroke) => stroke.svgPath ?? ""),
    medians: character.strokeData.map((stroke) =>
      (stroke.median ?? []).map((point) => [Math.round(point.x * 1024), Math.round(900 - point.y * 1024)]),
    ),
  };
}

function StrokePlayer({ character, large = false }: { character: CharacterData; large?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const writerRef = useRef<HanziWriter | null>(null);
  const [strokeIndex, setStrokeIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const playAll = useCallback(() => {
    setPaused(false);
    setStrokeIndex(0);
    void writerRef.current?.animateCharacter();
  }, []);

  const playStroke = useCallback((index: number) => {
    const bounded = Math.max(0, Math.min(character.strokeData.length - 1, index));
    setPaused(false);
    setStrokeIndex(bounded);
    void writerRef.current?.animateStroke(bounded);
  }, [character.strokeData.length]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";
    const size = large ? Math.min(window.innerWidth * 0.72, window.innerHeight * 0.68, 760) : 300;
    const writer = HanziWriter.create(container, character.char, {
      width: size,
      height: size,
      padding: large ? 28 : 20,
      showOutline: true,
      showCharacter: false,
      strokeColor: "#176846",
      highlightColor: "#f0a51b",
      outlineColor: "#dfe4e1",
      strokeAnimationSpeed: large ? 0.8 : 1.2,
      strokeHighlightSpeed: 0.8,
      delayBetweenStrokes: 420,
      charDataLoader: () => toWriterData(character),
    });
    writerRef.current = writer;
    setStrokeIndex(0);
    setPaused(false);
    void writer.animateCharacter();
    return () => {
      writerRef.current = null;
      container.innerHTML = "";
    };
  }, [character, large]);

  return (
    <div className={`strokeTeachingPlayer${large ? " large" : ""}`}>
      <div className="strokeTeachingCanvas" aria-label={`${character.char} 획순 애니메이션`} ref={containerRef} />
      <div className="strokeStepStatus" aria-live="polite"><strong>{strokeIndex + 1}획</strong><span>/ {character.strokeData.length}획</span></div>
      <div className="strokeTeachingControls">
        <button className="secondaryButton" onClick={playAll} type="button">처음부터 자동 재생</button>
        <button className="secondaryButton" onClick={() => {
          if (paused) void writerRef.current?.resumeAnimation();
          else void writerRef.current?.pauseAnimation();
          setPaused((value) => !value);
        }} type="button">{paused ? "계속 재생" : "일시정지"}</button>
        <button className="primaryButton" onClick={() => playStroke(Math.min(character.strokeData.length - 1, strokeIndex + 1))} type="button">다음 획 보기</button>
      </div>
    </div>
  );
}

export function CharacterStrokePreview({ character }: { character: CharacterData }) {
  const [expanded, setExpanded] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const label = splitHanjaLabel(character.label);

  useEffect(() => () => document.body.classList.remove("strokeTeachingOpen"), []);

  useEffect(() => {
    if (!expanded) return;
    const closeWhenBrowserLeavesFullscreen = () => {
      if (document.fullscreenElement) return;
      document.body.classList.remove("strokeTeachingOpen");
      setExpanded(false);
    };
    document.addEventListener("fullscreenchange", closeWhenBrowserLeavesFullscreen);
    return () => document.removeEventListener("fullscreenchange", closeWhenBrowserLeavesFullscreen);
  }, [expanded]);

  async function openLarge() {
    setExpanded(true);
    document.body.classList.add("strokeTeachingOpen");
    window.setTimeout(() => void overlayRef.current?.requestFullscreen?.().catch(() => undefined), 0);
  }

  async function closeLarge() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    document.body.classList.remove("strokeTeachingOpen");
    setExpanded(false);
  }

  return (
    <div className="strokePreviewCard">
      <div className={`strokePreviewHeading ${styles.heading}`} data-testid="stroke-preview-heading">
        <div className={styles.characterInfo}><strong>{character.char}</strong><span className={styles.characterText}><span>{label.meaning} <b>{label.reading}</b></span><small>{character.strokeData.length}획</small></span></div>
        <button className={`secondaryButton ${styles.expandButton}`} onClick={() => void openLarge()} type="button">크게 보기</button>
      </div>
      <StrokePlayer character={character} />
      {expanded && createPortal(
        <div className="strokeTeachingOverlay" ref={overlayRef} role="dialog" aria-modal="true" aria-label={`${character.char} 전체 화면 획순 보기`}>
          <header><div><span className="kicker">획순 수업 화면</span><h2>{character.char} <small>{label.meaning} {label.reading}</small></h2></div><button className="secondaryButton" onClick={() => void closeLarge()} type="button">전체 화면 닫기</button></header>
          <StrokePlayer character={character} large />
        </div>,
        document.body,
      )}
    </div>
  );
}

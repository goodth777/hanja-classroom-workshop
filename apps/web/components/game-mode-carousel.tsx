"use client";

import { useRef } from "react";
import type { GameMode } from "@hanja/contracts";

interface Option { mode: GameMode; title: string; description: string }

export function GameModeCarousel({ options, selected, onSelect }: { options: Option[]; selected: GameMode; onSelect: (mode: GameMode) => void }) {
  const index = Math.max(0, options.findIndex(option => option.mode === selected));
  const start = useRef<{ x: number; y: number } | null>(null);
  function move(step: number) { onSelect(options[(index + step + options.length) % options.length]!.mode); }
  return <section className="gameCarousel" aria-label="한자 게임 종류 선택" aria-roledescription="캐러셀">
    <div className="gameCarouselRow">
      <button className="gameCarouselArrow" type="button" aria-label="이전 게임" onClick={() => move(-1)}>
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5m6-6-6 6 6 6" /></svg>
      </button>
      <div className="gameCarouselViewport" tabIndex={0} aria-label="좌우 방향키로 게임 선택"
        onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); move(event.key === "ArrowLeft" ? -1 : 1); } }}
        onTouchStart={event => { const touch = event.touches[0]; start.current = touch ? { x: touch.clientX, y: touch.clientY } : null; }}
        onTouchCancel={() => { start.current = null; }}
        onTouchEnd={event => { const touch = event.changedTouches[0], from = start.current; start.current = null; if (!touch || !from) return; const dx = touch.clientX - from.x, dy = touch.clientY - from.y; if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1); }}>
        <div className="gameCarouselTrack">
          {options.map((option, i) => <button type="button" onClick={() => onSelect(option.mode)} tabIndex={i === index ? 0 : -1} className={`gameCarouselSlide gameCarouselSlide-${option.mode} ${i === index ? "isFront" : (i - index + options.length) % options.length === 1 ? "isRight" : "isLeft"}`} key={option.mode} aria-label={`${option.title} 선택`} aria-pressed={i === index}>
            <span className="gameCarouselGlyph" aria-hidden="true">{["筆", "問", "蛇"][i]}</span>
            <span className="gameCarouselCopy"><span className="gameCarouselEyebrow">{i === index ? "선택한 게임" : "게임 선택"} · 0{i + 1}</span><span className="gameCarouselTitle">{option.title}</span><span className="gameCarouselDescription">{option.description}</span></span>
          </button>)}
        </div>
      </div>
      <button className="gameCarouselArrow" type="button" aria-label="다음 게임" onClick={() => move(1)}>
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
      </button>
    </div>
    <div className="gameCarouselNavigation" role="group" aria-label="게임 바로 선택">{options.map((option, i) => <button type="button" key={option.mode} aria-pressed={i === index} onClick={() => onSelect(option.mode)}>{option.title}</button>)}</div>
    <span className="sr-only" aria-live="polite" aria-atomic="true">{options[index]!.title} 선택됨</span>
  </section>;
}

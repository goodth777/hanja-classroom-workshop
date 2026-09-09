"use client";

import { useLayoutEffect, useRef } from "react";
import type { PublicPlayer, RankedPlayer } from "@hanja/contracts";

export function Scoreboard({
  players,
  selectedPlayerId,
  highlightPlayerId,
  showRanks = false,
  animateChanges = false,
}: {
  players: (PublicPlayer | RankedPlayer)[];
  selectedPlayerId?: string | null;
  highlightPlayerId?: string | null;
  showRanks?: boolean;
  animateChanges?: boolean;
}) {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname, "ko"));
  const listRef = useRef<HTMLDivElement>(null);
  const previous = useRef({ signature: "", width: 0, rows: new Map<string, { top: number; score: number; rank: number }>() });
  const animations = useRef(new Map<HTMLElement, Animation>());

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !animateChanges) return;
    const owned = animations.current;
    const reset = () => {
      for (const [row, animation] of owned) {
        animation.cancel();
        delete row.dataset.rankMove;
      }
      owned.clear();
      previous.current.signature = "";
      previous.current.rows.clear();
    };
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    preference.addEventListener("change", reset);
    const resize = new ResizeObserver(() => {
      if (list.clientWidth !== previous.current.width) reset();
    });
    resize.observe(list);
    return () => {
      preference.removeEventListener("change", reset);
      resize.disconnect();
      reset();
    };
  }, [animateChanges]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !animateChanges) return;
    const elements = Array.from(list.querySelectorAll<HTMLElement>(".scoreRow"));
    const signature = elements.map(row => `${row.dataset.playerId}:${row.dataset.score}:${row.dataset.rank}`).join("|");
    // Clock/turn snapshots must not restart a rank transition every 200 ms.
    if (signature === previous.current.signature) return;
    const width = list.clientWidth;
    const canAnimate = width === previous.current.width && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Read all positions before writes. offsetTop is independent of page/list scrolling.
    const measured = elements.map(row => {
      const style = getComputedStyle(row);
      const translateY = style.transform === "none" ? 0 : new DOMMatrixReadOnly(style.transform).m42;
      return { row, id: row.dataset.playerId!, top: row.offsetTop, score: Number(row.dataset.score), rank: Number(row.dataset.rank), translateY };
    });
    for (const [row, animation] of animations.current) {
      if (!list.contains(row)) {
        animation.cancel();
        animations.current.delete(row);
      }
    }
    for (const { row, id, top, score, rank, translateY } of measured) {
      const before = previous.current.rows.get(id);
      animations.current.get(row)?.cancel();
      animations.current.delete(row);
      delete row.dataset.rankMove;
      if (!canAnimate || !before || typeof row.animate !== "function") continue;
      // On rapid overtakes, start at the currently visible position, not the old destination.
      const delta = before.top + translateY - top;
      if (Math.abs(delta) < 0.5 && score === before.score) continue;
      if (rank !== before.rank) row.dataset.rankMove = rank < before.rank ? "up" : "down";
      const animation = row.animate([
        { transform: `translateY(${delta}px)` },
        { transform: "translateY(0)" },
      ], { duration: 480, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      animations.current.set(row, animation);
      animation.onfinish = () => {
        if (animations.current.get(row) !== animation) return;
        animations.current.delete(row);
        delete row.dataset.rankMove;
      };
    }
    previous.current = { signature, width, rows: new Map(measured.map(({ id, top, score, rank }) => [id, { top, score, rank }])) };
  });

  return (
    <div className={`scoreList${animateChanges ? " scoreListAnimated" : ""}`} aria-live="polite" ref={listRef}>
      {sorted.map((player, index) => (
        <div
          className={`scoreRow ${player.id === selectedPlayerId ? "isTurn" : ""} ${player.id === highlightPlayerId ? "isSelf" : ""}`}
          key={player.id}
          data-player-id={player.id}
          data-score={player.score}
          data-rank={showRanks && "rank" in player ? player.rank : sorted.findIndex(candidate => candidate.score === player.score) + 1}
        >
          <span className="rankMark">{showRanks ? "rank" in player ? player.rank : sorted.findIndex((candidate) => candidate.score === player.score) + 1 : index + 1}</span>
          <span className="playerName" title={player.nickname}>
            {player.nickname}
            {!player.connected && <small> 재연결 대기</small>}
          </span>
          <strong>{player.score}</strong>
        </div>
      ))}
      {sorted.length === 0 && <p className="emptyText">아직 입장한 학생이 없습니다.</p>}
    </div>
  );
}

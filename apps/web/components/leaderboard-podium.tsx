import type { CSSProperties } from "react";
import type { AverageRank } from "@hanja/contracts";
import styles from "./leaderboard-podium.module.css";

const displayScore = (value: number) => value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const RANKS = [1, 2, 3] as const;
const CONFETTI = Array.from({ length: 18 }, (_, index) => ({
  left: `${8 + ((index * 29) % 85)}%`,
  delay: `${280 + (index % 6) * 75}ms`,
  drift: `${(index % 2 === 0 ? 1 : -1) * (18 + (index % 5) * 9)}px`,
  turn: `${180 + index * 31}deg`,
}));

function MedalFace({ rank }: { rank: number }) {
  return <div className={styles.medallion} aria-hidden="true">
    {rank === 1 && <svg className={styles.crown} viewBox="0 0 48 30" fill="none">
      <path d="m5 8 10 7L24 3l9 12 10-7-5 18H10Z" fill="currentColor" />
      <circle cx="5" cy="6" r="3" fill="currentColor" /><circle cx="24" cy="3" r="3" fill="currentColor" /><circle cx="43" cy="6" r="3" fill="currentColor" />
    </svg>}
    <svg className={styles.face} viewBox="0 0 80 80" fill="none">
      <circle cx="40" cy="40" r="32" fill="currentColor" opacity=".08" />
      <path d="M24 34c1.5-5 6.5-5 8 0M48 34c1.5-5 6.5-5 8 0" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M29 46c4 9 18 9 22 0" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      <ellipse cx="22" cy="44" rx="5" ry="3" fill="currentColor" opacity=".14" /><ellipse cx="58" cy="44" rx="5" ry="3" fill="currentColor" opacity=".14" />
      <path d="m62 18 1.4 3.5L67 23l-3.6 1.5L62 28l-1.4-3.5L57 23l3.6-1.5Z" fill="currentColor" opacity=".65" />
    </svg>
  </div>;
}

/** Rankings are owned by the server. A tie shares a podium; no client-side reranking. */
export function LeaderboardPodium({ players }: { players: AverageRank[] }) {
  const groups = RANKS.map(rank => ({ rank, players: players.filter(player => player.rank === rank) })).filter(group => group.players.length > 0);
  if (groups.length === 0) return null;

  return <div className={styles.podium} data-testid="leaderboard-podium" role="group" aria-label="평균 점수 상위 3위 시상대">
    <div className={styles.confetti} aria-hidden="true">{CONFETTI.map((piece, index) => <i key={index} style={{ left: piece.left, animationDelay: piece.delay, "--drift": piece.drift, "--turn": piece.turn } as CSSProperties} />)}</div>
    <div className={styles.stage}>
      {groups.map(group => <article key={group.rank} className={`${styles.place} ${styles[`rank${group.rank}`]}`} data-podium-rank={group.rank} aria-label={`${group.players.length > 1 ? "공동 " : ""}${group.rank}위`}>
        <div className={styles.winners}>
          <MedalFace rank={group.rank} />
          <span className={styles.rankLabel}>{group.players.length > 1 ? "공동 " : ""}{group.rank}위</span>
          <div className={styles.players}>{group.players.map(player => <div className={styles.player} key={player.nickname} data-podium-player={player.nickname}>
            <strong className={styles.nickname}>{player.nickname}</strong>
            <span className={styles.score}><span className={styles.srOnly}>평균 </span>{displayScore(player.average)}<small>점</small></span>
            <span className={styles.games}>{player.games}회 참여</span>
          </div>)}</div>
        </div>
        <div className={styles.stand} data-podium-stand="" aria-hidden="true"><span>{group.rank}</span><svg viewBox="0 0 100 56" fill="none"><path d="M29 48C7 35 8 11 22 4M24 42l-11 1M18 31 7 28M17 20l-8-7M21 10l-3-8M71 48c22-13 21-37 7-44M76 42l11 1M82 31l11-3M83 20l8-7M79 10l3-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg></div>
      </article>)}
    </div>
  </div>;
}

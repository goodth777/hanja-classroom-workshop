import type { RankedPlayer } from "@hanja/contracts";
import styles from "./student-result-podium.module.css";

/** Show the server's final ranks as awarded, including shared ranks. */
export function StudentResultPodium({ players, highlightPlayerId }: { players: RankedPlayer[]; highlightPlayerId: string }) {
  const places = [2, 1, 3].map((rank) => ({ rank, players: players.filter((player) => player.rank === rank) }));
  if (!places.some((place) => place.players.length)) return null;

  return <div className={styles.podium} aria-label="최종 순위 상위 3위 시상대" role="group" data-testid="student-final-podium">
    {places.map(({ rank, players: winners }) => <div key={rank} className={`${styles.place} ${styles[`rank${rank}`]}`} data-podium-rank={rank}>
      {winners.length > 0 ? <>
        <div className={styles.medal} aria-hidden="true">
          {rank === 1 && <svg className={styles.crown} viewBox="0 0 40 26"><path d="m3 7 9 6L20 2l8 11 9-6-5 16H8Z" fill="currentColor" /></svg>}
          <svg viewBox="0 0 60 60" fill="none"><circle cx="30" cy="30" r="27" fill="currentColor" opacity=".08" /><path d="M17 26c1-4 5-4 6 0m14 0c1-4 5-4 6 0M22 36c4 7 12 7 16 0" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /><circle cx="15" cy="34" r="3" fill="currentColor" opacity=".2" /><circle cx="45" cy="34" r="3" fill="currentColor" opacity=".2" /></svg>
        </div>
        <div className={styles.winners}>
          {winners.slice(0, 2).map((player) => <div key={player.id} className={styles.winner}>
            <strong>{player.nickname}{player.id === highlightPlayerId && <small>나</small>}</strong>
            <span>{player.score.toLocaleString("ko-KR")}<small>점</small></span>
          </div>)}
          {winners.length > 2 && <span className={styles.moreWinners}>외 {winners.length - 2}명 · 공동 {rank}위<span className={styles.srOnly}>. 전체 순위에서 모든 학생을 확인할 수 있습니다.</span></span>}
        </div>
        <div className={styles.stand}><span>{winners.length > 1 ? "공동 " : ""}{rank}<small>위</small></span></div>
      </> : <div className={styles.empty} aria-hidden="true" />}
    </div>)}
  </div>;
}

import type { GameMode } from "@hanja/contracts";
import styles from "./teacher-experience.module.css";

const GAMES: Array<{ mode: GameMode; title: string; label: string; description: string; category: string }> = [
  { mode: "stroke_battle", title: "획 배틀", label: "함께 쓰는 즐거움", description: "한 획씩 이어 쓰며, 하나의 한자를 완성해요.", category: "함께 · 협동" },
  { mode: "meaning_sound_quiz", title: "뜻·음 스피드 퀴즈", label: "생각보다 빠르게", description: "한자와 뜻, 음을 연결하고 정답에 도전해요.", category: "각자의 속도 · 퀴즈" },
  { mode: "hanja_worm", title: "한자 지렁이", label: "손끝에서 시작되는 모험", description: "벌레를 피해 획을 따라, 한자를 완성해요.", category: "손끝으로 · 탐험" },
];

export function GameDirectionIcon({ back = false }: { back?: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className={styles.directionIcon}><path d={back ? "M19 12H5m6-6-6 6 6 6" : "M5 12h14m-6-6 6 6-6 6"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** Small, self-contained vectors: dimensional art without downloads or a 3D runtime. */
export function TeacherGameArt({ mode }: { mode: GameMode }) {
  return <svg viewBox="0 0 320 230" aria-hidden="true" focusable="false" className={styles.gameArtSvg}>
    <ellipse cx="162" cy="205" rx="100" ry="12" fill="#173f32" opacity=".08" />
    {mode === "stroke_battle" ? <>
      <g transform="translate(82 15) rotate(-10 80 88)">
        <rect x="8" y="9" width="154" height="178" rx="24" fill="#aacdbc" />
        <rect width="154" height="178" rx="24" fill="#fffff9" stroke="#d1e4d8" />
        <path d="M77 20v140M20 86h114M28 35l98 109m-98 0 98-109" fill="none" stroke="#dcebdd" strokeDasharray="4 6" />
        <path d="M37 66h82M77 32v113M73 70C62 96 40 120 25 130M83 75c15 23 34 43 48 47" stroke="#126044" strokeWidth="8" strokeLinecap="round" fill="none" />
        <circle cx="37" cy="66" r="6" fill="#e7c55f" />
      </g>
      <g transform="translate(242 93) rotate(25)"><path d="M0 0h14v84L7 101 0 84Z" fill="#196d50" /><path d="M0 0h14v11H0" fill="#e5c57d" /><path d="m0 84 7 17 7-17" fill="#e4d2b1" /><path d="m5 95 2 6 2-6" fill="#243d30" /></g>
      <path d="m61 39 3 9 9 3-9 3-3 9-3-9-9-3 9-3Z" fill="#91bfa8" /><circle cx="269" cy="36" r="4" fill="#d6bd72" />
    </> : mode === "meaning_sound_quiz" ? <>
      <g transform="translate(61 34) rotate(-15 58 75)"><rect width="121" height="158" rx="22" fill="#c7dcd0" stroke="#a9c8b7" /><path d="M23 29h66M23 43h39" stroke="#9fbeac" strokeWidth="4" strokeLinecap="round" /></g>
      <g transform="translate(129 18) rotate(9 66 83)"><rect x="5" y="6" width="130" height="168" rx="22" fill="#b5c9b7" /><rect width="130" height="168" rx="22" fill="#fffdf1" stroke="#e3e7d3" /><text x="65" y="106" textAnchor="middle" fontFamily="Batang,serif" fontSize="79" fill="#205b40">泉</text><path d="M26 136h78" stroke="#d8e2d1" strokeWidth="3" /></g>
      <g transform="translate(49 159) rotate(-4)"><rect x="2" y="3" width="118" height="42" rx="13" fill="#bbd3be" /><rect width="118" height="42" rx="13" fill="#17684b" /><text x="59" y="28" textAnchor="middle" fill="#fffef4" fontSize="20" fontFamily="Malgun Gothic,sans-serif" fontWeight="700">샘 천</text></g>
      <g transform="translate(255 138)"><circle cx="21" cy="21" r="23" fill="#ead48e" /><path d="m11 21 7 7 14-15" stroke="#71602a" strokeWidth="3" fill="none" strokeLinecap="round" /></g>
      <path d="m53 66 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="#a0c2ac" />
    </> : <>
      <g transform="translate(64 26) rotate(-7 94 78)"><rect x="6" y="9" width="191" height="166" rx="30" fill="#abc9b3" /><rect width="191" height="166" rx="30" fill="#e1eee0" stroke="#c5dac5" />
        <path d="M37 34h113M95 34v104" stroke="#bccfba" strokeWidth="2" strokeDasharray="5 6" /><circle cx="37" cy="34" r="11" fill="#e6c266" /><circle cx="151" cy="34" r="10" fill="#fff4c9" stroke="#d9ba6e" /><circle cx="95" cy="139" r="9" fill="#f8fbef" stroke="#bdd3b8" />
        <path d="M34 126c-16-7-20-31 0-43 21-14 46 5 69-3 26-8 19-33 47-29" fill="none" stroke="#adc8a9" strokeWidth="31" strokeLinecap="round" />
        <path d="M34 118c-16-7-20-31 0-43 21-14 46 5 69-3 26-8 19-33 47-29" fill="none" stroke="#418966" strokeWidth="28" strokeLinecap="round" />
        <path d="m49 77 1 15m19-11v15m21-13 4 13" stroke="#76ac82" strokeWidth="3" strokeLinecap="round" /><ellipse cx="155" cy="44" rx="24" ry="21" fill="#226d50" /><circle cx="151" cy="35" r="7" fill="#fffcee" /><circle cx="167" cy="35" r="7" fill="#fffcee" /><circle cx="153" cy="35" r="3" fill="#183e31" /><circle cx="169" cy="35" r="3" fill="#183e31" /><path d="M153 50q7 7 13-1" stroke="#b4d6b4" strokeWidth="3" strokeLinecap="round" fill="none" />
      </g><path d="m49 55 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" fill="#a0c2a1" /><circle cx="279" cy="166" r="4" fill="#d2b66b" />
    </>}
  </svg>;
}

export function TeacherGameHub({ onChoose, onLibrary }: { onChoose: (mode: GameMode) => void; onLibrary: () => void }) {
  return <section className={styles.hub} aria-labelledby="game-hub-title" data-testid="game-hub">
    <div className={styles.hubHeading}><div><p className={styles.eyebrow}>PLAY. LEARN. TOGETHER.</p><h1 id="game-hub-title" tabIndex={-1}>오늘의 한자,<br /><span>어떤 게임으로 만날까요?</span></h1></div><p className={styles.hubLead}>게임을 고르고, 한자를 담으면 준비 끝.<br />QR 하나로 우리 반이 함께해요.</p></div>
    <div className={styles.gameDeck} aria-label="한자 게임 선택">
      {GAMES.map((game, index) => <button type="button" key={game.mode} className={styles.gameCard} data-mode={game.mode} data-game-mode={game.mode} aria-label={`${game.title} 선택`} onClick={() => onChoose(game.mode)}>
        <span className={styles.cardNumber}>0{index + 1}</span><span className={styles.cardCategory}>{game.category}</span>
        <span className={styles.gameArt}><TeacherGameArt mode={game.mode} /></span>
        <span className={styles.cardCopy}><span className={styles.cardLabel}>{game.label}</span><strong>{game.title}</strong><span className={styles.cardDescription}>{game.description}</span></span>
        <span className={styles.cardFooter}>수업 준비하기<span className={styles.cardArrow}><GameDirectionIcon /></span></span>
      </button>)}
    </div>
    <div className={styles.hubFooter}><span>서로 다른 세 가지 도전, 한자를 배우는 한 가지 즐거움.</span><button type="button" onClick={onLibrary}>수업 자료 정리하기<GameDirectionIcon /></button></div>
  </section>;
}

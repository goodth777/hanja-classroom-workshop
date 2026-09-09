"use client";

import { useEffect, useState } from "react";
import type { GameHistoryResponse, GameMode } from "@hanja/contracts";
import { SERVER_URL } from "@/lib/socket";
import { LeaderboardPodium } from "./leaderboard-podium";

const MODES: Array<[GameMode, string]> = [["stroke_battle", "획 배틀"], ["meaning_sound_quiz", "스피드 퀴즈"], ["hanja_worm", "한자 지렁이"]];
const score = (value: number) => value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });

export function TeacherGameHistory({ accessToken }: { accessToken: string }) {
  const [mode, setMode] = useState<GameMode>("stroke_battle");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<GameHistoryResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setData(null); setError("");
      try {
        const response = await fetch(`${SERVER_URL}/api/teacher/results?gameMode=${mode}&offset=${offset}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: controller.signal });
        if (!response.ok) throw new Error("기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
        const result = await response.json() as GameHistoryResponse;
        if (!controller.signal.aborted) setData(result);
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "연결을 확인해 주세요."); }
    }
    void load();
    return () => controller.abort();
  }, [mode, offset, refresh, accessToken]);
  return <section className="teacherSection gameHistory" aria-label="기록과 랭킹">
    <div className="teacherSectionHeader"><div><p className="kicker">수업 기록</p><h2>기록·랭킹</h2></div><button className="secondaryButton" onClick={() => setRefresh(n => n + 1)} type="button">새로고침</button></div>
    <div className="historyTabs" aria-label="기록 게임 선택">{MODES.map(([key, title]) => <button className="secondaryButton" aria-pressed={mode === key} key={key} onClick={() => { if (key !== mode) setData(null); setMode(key); setOffset(0); }} type="button">{title}</button>)}</div>
    <p className="notice">같은 닉네임의 완료한 게임 평균입니다. 중단 기록은 평균에서 제외됩니다. 기록 기능 적용 후의 게임부터 표시됩니다.</p>
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">기록을 불러오는 중…</p> : <>
      <h3>평균 점수 랭킹</h3>
      {data.leaderboard.length === 0 ? <p className="historyEmpty">아직 완료한 게임이 없습니다.</p> : <>
        <LeaderboardPodium players={data.leaderboard} />
        <details className="historyRanking"><summary>전체 순위 · {data.leaderboard.length}명</summary><table><thead><tr><th>순위</th><th>닉네임</th><th>평균 점수</th><th>참여</th></tr></thead><tbody>{data.leaderboard.map(p => <tr key={p.nickname}><td>{p.rank}</td><th scope="row">{p.nickname}</th><td>{score(p.average)}</td><td>{p.games}회</td></tr>)}</tbody></table></details>
      </>}
      <h3>지난 게임</h3>
      {data.results.length === 0 && <p className="historyEmpty">저장된 게임이 없습니다.</p>}
      <div className="historyGames">{data.results.map(r => <details key={r.resultKey}><summary><span><strong>{r.character}</strong><small>{new Date(r.completedAt).toLocaleString("ko-KR")} · {r.playerCount}명 · {r.status === "stopped" ? "교사 중단" : "완료"}</small></span><b>점수 보기</b></summary><ol>{r.scores.map(p => <li key={p.nickname}><span>{p.rank}위 · {p.nickname}</span><strong>{score(p.score)}점</strong></li>)}</ol></details>)}</div>
      <div className="historyPagination"><button type="button" className="secondaryButton" disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 20))}>이전</button><span>{offset / 20 + 1}페이지</span><button type="button" className="secondaryButton" disabled={!data.hasMore} onClick={() => setOffset(n => n + 20)}>다음</button></div>
    </>}
  </section>;
}

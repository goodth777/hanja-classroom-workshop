import type { AverageRank, GameHistoryResponse, GameMode, SavedGameResult } from "@hanja/contracts";
import { supabaseServiceHeaders } from "./supabase-headers.js";

export interface ResultStore {
  save(result: SavedGameResult): Promise<void>;
  history?(teacherId: string, gameMode: GameMode, offset: number): Promise<GameHistoryResponse>;
}

export class MemoryResultStore implements ResultStore {
  readonly results: SavedGameResult[] = [];
  async save(result: SavedGameResult): Promise<void> {
    const index = this.results.findIndex(r => r.resultKey === result.resultKey);
    if (index < 0) this.results.push(structuredClone(result));
    else this.results[index] = structuredClone(result);
  }
  async history(teacherId: string, gameMode: GameMode, offset: number): Promise<GameHistoryResponse> {
    const all = this.results.filter(r => r.teacherId === teacherId && r.gameMode === gameMode).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    const totals = new Map<string, { total: number; games: number }>();
    for (const result of all.filter(r => r.status === "completed")) for (const player of result.scores) {
      const row = totals.get(player.nickname) ?? { total: 0, games: 0 };
      row.total += player.score; row.games++; totals.set(player.nickname, row);
    }
    const leaderboard: AverageRank[] = [...totals].map(([nickname, row]) => ({ nickname, average: Math.round(row.total / row.games * 100) / 100, games: row.games, rank: 0 })).sort((a, b) => b.average - a.average || a.nickname.localeCompare(b.nickname));
    let rank = 0;
    leaderboard.forEach((row, i) => { if (i === 0 || row.average !== leaderboard[i - 1]!.average) rank++; row.rank = rank; });
    return { results: structuredClone(all.slice(offset, offset + 20)), leaderboard, hasMore: all.length > offset + 20 };
  }
}

export class SupabaseResultStore implements ResultStore {
  constructor(private readonly url: string, private readonly serviceRoleKey: string) {}
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      ...init, signal: AbortSignal.timeout(8000),
      headers: { ...supabaseServiceHeaders(this.serviceRoleKey), ...init.headers },
    });
    if (!response.ok) throw new Error(`Game history request failed (${response.status})`);
    return response;
  }
  async save(result: SavedGameResult): Promise<void> {
    const scores = result.teacherId ? result.scores : result.scores.map(({ rank, score }) => ({ rank, score }));
    await this.request("game_results?on_conflict=result_key", {
      method: "POST", headers: { prefer: "return=minimal,resolution=merge-duplicates" },
      body: JSON.stringify({ result_key: result.resultKey, teacher_id: result.teacherId ?? null, game_mode: result.gameMode, status: result.status, character: result.character, player_count: result.playerCount, scores, completed_at: result.completedAt }),
    });
  }
  async history(teacherId: string, gameMode: GameMode, offset: number): Promise<GameHistoryResponse> {
    const query = new URLSearchParams({ teacher_id: `eq.${teacherId}`, game_mode: `eq.${gameMode}`, order: "completed_at.desc,id.desc", offset: String(offset), limit: "21", select: "result_key,game_mode,status,character,player_count,scores,completed_at" });
    const [history, ranking] = await Promise.all([
      this.request(`game_results?${query}`),
      this.request("rpc/teacher_result_leaderboard", { method: "POST", body: JSON.stringify({ p_teacher_id: teacherId, p_game_mode: gameMode }) }),
    ]);
    const rows = await history.json() as Array<{ result_key: string; game_mode: GameMode; status: SavedGameResult["status"]; character: string; player_count: number; scores: SavedGameResult["scores"]; completed_at: string }>;
    return { results: rows.slice(0, 20).map(r => ({ resultKey: r.result_key, gameMode: r.game_mode, status: r.status, character: r.character, playerCount: r.player_count, scores: r.scores, completedAt: r.completed_at })), leaderboard: await ranking.json() as AverageRank[], hasMore: rows.length > 20 };
  }
}

export function createResultStore(environment: NodeJS.ProcessEnv = process.env): ResultStore {
  const url = environment.SUPABASE_URL, key = environment.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? new SupabaseResultStore(url, key) : new MemoryResultStore();
}

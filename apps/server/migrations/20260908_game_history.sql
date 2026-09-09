-- Existing anonymous records remain untouched and cannot be assigned to a teacher.
alter table public.game_results add column if not exists result_key uuid;
alter table public.game_results add column if not exists teacher_id uuid references auth.users(id) on delete cascade;
alter table public.game_results add column if not exists game_mode text;
alter table public.game_results add column if not exists status text not null default 'completed';
create unique index if not exists game_results_result_key on public.game_results(result_key);
create index if not exists game_results_teacher_mode_date on public.game_results(teacher_id, game_mode, completed_at desc);
alter table public.game_results enable row level security;
revoke all on public.game_results from anon, authenticated;
grant select on public.game_results to authenticated;
grant all on public.game_results to service_role;
drop policy if exists teacher_read_own_results on public.game_results;
create policy teacher_read_own_results on public.game_results for select to authenticated using ((select auth.uid()) = teacher_id);

create or replace function public.teacher_result_leaderboard(p_teacher_id uuid, p_game_mode text)
returns table(nickname text, average numeric, games bigint, rank bigint)
language sql stable security invoker set search_path = '' as $$
  with averages as (
    select s->>'nickname' as nickname, round(avg((s->>'score')::numeric), 2) as average, count(*) as games
    from public.game_results r cross join lateral jsonb_array_elements(r.scores) s
    where r.teacher_id = p_teacher_id and r.game_mode = p_game_mode and r.status = 'completed'
      and s->>'nickname' is not null
    group by s->>'nickname'
  )
  select nickname, average, games, dense_rank() over(order by average desc) as rank
  from averages order by average desc, nickname;
$$;
revoke all on function public.teacher_result_leaderboard(uuid, text) from public, anon, authenticated;
grant execute on function public.teacher_result_leaderboard(uuid, text) to service_role;

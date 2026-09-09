-- Identity inserts require sequence privileges separately from table privileges.
grant usage, select on sequence public.game_results_id_seq to service_role;
notify pgrst, 'reload schema';

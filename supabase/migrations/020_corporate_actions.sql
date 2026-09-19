-- Corporate actions: mergers, splits, renames used to remap trades before ledger save.

create table if not exists public.corporate_actions (
  id text primary key,
  user_id text not null,
  action_type text not null check (action_type in ('merge', 'split', 'rename')),
  from_symbol text not null,
  from_name text not null default '',
  from_isin text not null default '',
  to_symbol text not null,
  to_name text not null default '',
  to_isin text not null default '',
  -- Swap / split ratio: ratio_from of old shares become ratio_to of new shares.
  -- Mindtree→LTIM: 100 → 73. TV18→NETWORK18: 172 → 100.
  ratio_from double precision not null default 1,
  ratio_to double precision not null default 1,
  effective_date text not null,
  record_date text,
  notes text not null default '',
  source_url text not null default '',
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create index if not exists idx_corporate_actions_user
  on public.corporate_actions (user_id, effective_date desc);

create index if not exists idx_corporate_actions_from_symbol
  on public.corporate_actions (user_id, from_symbol);

alter table public.trades
  add column if not exists original_symbol text,
  add column if not exists original_stock_name text,
  add column if not exists original_isin text,
  add column if not exists corporate_action_id text;

create index if not exists idx_trades_corporate_action
  on public.trades (user_id, corporate_action_id)
  where corporate_action_id is not null;

drop policy if exists corporate_actions_all on public.corporate_actions;
create policy corporate_actions_all on public.corporate_actions for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

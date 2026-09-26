-- Price trackers: watch a registry stock against a target + next levels.
-- CMP is stored on the row so Screener (now) or Groww (later) can refresh it.

create table if not exists public.price_trackers (
  id text primary key,
  user_id text not null,
  symbol text not null,
  stock_name text,
  isin text default '',
  action text not null default 'buy',
  target_price double precision not null,
  next_targets jsonb not null default '[]'::jsonb,
  cmp double precision,
  cmp_source text not null default 'screener',
  cmp_fetched_at bigint,
  notes text,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create index if not exists idx_price_trackers_user_updated
  on public.price_trackers (user_id, updated_at desc);

create index if not exists idx_price_trackers_user_symbol
  on public.price_trackers (user_id, symbol);

alter table public.price_trackers enable row level security;

drop policy if exists price_trackers_all on public.price_trackers;
create policy price_trackers_all on public.price_trackers for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

do $$
begin
  execute 'alter publication supabase_realtime add table public.price_trackers';
exception
  when duplicate_object then null;
end $$;

-- User signal watch: stocks with scale-in prices, optional brokerage targets, and guidance notes.

create table if not exists public.signal_watch (
  id text primary key,
  user_id text not null,
  symbol text not null,
  name text not null default '',
  isin text,
  prices jsonb not null default '[]'::jsonb,
  broker_targets jsonb not null default '[]'::jsonb,
  guidance_profit text not null default '',
  guidance_sales text not null default '',
  sort_order int not null default 0,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

create unique index if not exists idx_signal_watch_user_symbol
  on public.signal_watch (user_id, symbol);

create index if not exists idx_signal_watch_user_sort
  on public.signal_watch (user_id, sort_order, created_at);

alter table public.signal_watch enable row level security;

drop policy if exists signal_watch_all on public.signal_watch;
create policy signal_watch_all on public.signal_watch for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

do $$
begin
  execute 'alter publication supabase_realtime add table public.signal_watch';
exception
  when duplicate_object then null;
end $$;

-- Close a plan by recording fills, then keep it in history.
alter table public.price_trackers
  add column if not exists status text not null default 'open',
  add column if not exists executed_at bigint,
  add column if not exists buy_legs jsonb not null default '[]'::jsonb,
  add column if not exists sell_legs jsonb not null default '[]'::jsonb,
  add column if not exists realized_pnl double precision;

alter table public.price_trackers
  drop constraint if exists price_trackers_status_check;

alter table public.price_trackers
  add constraint price_trackers_status_check
  check (status in ('open', 'executed'));

create index if not exists idx_price_trackers_user_status
  on public.price_trackers (user_id, status, executed_at desc);

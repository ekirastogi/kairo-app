-- Optional size + exit ladder on a price watch so Tracking can show charges and net P&L.
alter table public.price_trackers
  add column if not exists quantity double precision,
  add column if not exists segment text,
  add column if not exists entry_price double precision,
  add column if not exists stop_loss double precision,
  add column if not exists targets jsonb not null default '[]'::jsonb;

alter table public.price_trackers
  drop constraint if exists price_trackers_segment_check;

alter table public.price_trackers
  add constraint price_trackers_segment_check
  check (segment is null or segment in ('intraday', 'delivery'));

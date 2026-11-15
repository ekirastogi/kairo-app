-- Groww historical candles mirrored from the local python-worker so the hosted UI can chart.

create table if not exists public.ohlc_candles (
  symbol text not null,
  interval text not null,
  ts timestamptz not null,
  open double precision not null,
  high double precision not null,
  low double precision not null,
  close double precision not null,
  volume double precision not null default 0,
  primary key (symbol, interval, ts)
);

create index if not exists idx_ohlc_candles_symbol_interval_ts
  on public.ohlc_candles (symbol, interval, ts desc);

alter table public.ohlc_candles enable row level security;

drop policy if exists ohlc_candles_read on public.ohlc_candles;
create policy ohlc_candles_read on public.ohlc_candles
  for select using (public.is_allowed_user());

NOTIFY pgrst, 'reload schema';

create table if not exists candles (
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

create index if not exists candles_symbol_interval_ts_idx
  on candles (symbol, interval, ts desc);

create table if not exists level_alerts (
  symbol text not null,
  price double precision not null,
  last_fired_at timestamptz not null default now(),
  last_ltp double precision,
  primary key (symbol, price)
);

create table if not exists tracker_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

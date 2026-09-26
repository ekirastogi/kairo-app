-- Kairo / Groww Trader — Supabase schema (data layer)
-- Firebase Firestore remains for worker eventing only (workerJobs, worker/listen, worker/status)

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_allowed_user()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'ekirastogi@gmail.com';
$$;

-- ---------------------------------------------------------------------------
-- Universe (shared symbol book)
-- ---------------------------------------------------------------------------
create table if not exists public.universe (
  symbol text primary key,
  name text,
  isin text default '',
  exchange text default 'NSE',
  source text not null default 'manual',
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create index if not exists idx_universe_symbol on public.universe (symbol);

-- ---------------------------------------------------------------------------
-- Market data (worker → Supabase)
-- ---------------------------------------------------------------------------
create table if not exists public.stocks (
  symbol text primary key,
  name text,
  exchange text default 'NSE',
  ltp double precision default 0,
  change_amt double precision default 0,
  change_pct double precision default 0,
  market_cap double precision default 0,
  pe double precision default 0,
  week52_high double precision default 0,
  week52_low double precision default 0,
  support_levels jsonb default '[]'::jsonb,
  resistance_levels jsonb default '[]'::jsonb,
  quarterly_perf double precision default 0,
  yearly_perf double precision default 0,
  indicators jsonb default '{}'::jsonb,
  pe_series jsonb default '[]'::jsonb,
  vs_nifty_pct double precision default 0,
  vs_cap_index_pct double precision default 0,
  vs_sector_pct double precision default 0,
  cap_bucket text default '',
  sector text default '',
  volume_ratio double precision default 0,
  last_updated text,
  data_source text default ''
);

create table if not exists public.stock_charts (
  symbol text primary key references public.stocks(symbol) on delete cascade,
  candles jsonb not null default '[]'::jsonb,
  sma20 jsonb default '[]'::jsonb,
  sma50 jsonb default '[]'::jsonb,
  sma200 jsonb default '[]'::jsonb,
  updated_at text
);

create table if not exists public.market_catalog (
  id text primary key default 'summary',
  updated_at bigint not null default 0,
  count int not null default 0,
  stocks jsonb not null default '[]'::jsonb
);

create table if not exists public.volume_shockers_active (
  id text primary key default 'active',
  symbols jsonb not null default '[]'::jsonb,
  updated_at text
);

create table if not exists public.volume_shockers_daily (
  trade_date text primary key,
  symbols jsonb not null default '[]'::jsonb,
  updated_at text
);

-- ---------------------------------------------------------------------------
-- Recommendations (signals)
-- ---------------------------------------------------------------------------
create table if not exists public.recommendations (
  id text primary key,
  symbol text not null,
  rule_id text,
  rule_name text,
  side text,
  entry double precision,
  sl double precision,
  targets jsonb default '[]'::jsonb,
  confidence double precision default 0,
  horizon text default 'intraday',
  cap_bucket text,
  sector text,
  vs_nifty_pct double precision,
  vs_cap_index_pct double precision,
  vs_sector_pct double precision,
  volume_ratio double precision,
  status text not null default 'pending_approval',
  approval_status text not null default 'pending',
  signal_snapshot jsonb,
  created_at text,
  approved_at text,
  approved_by text,
  rejected_at text,
  rejected_by text,
  executing_at text,
  resolved_at text,
  exit_price double precision,
  exit_reason text,
  outcome_pct double precision,
  platform text default 'groww'
);

create index if not exists idx_recommendations_pending on public.recommendations (approval_status, confidence desc);
create index if not exists idx_recommendations_status on public.recommendations (status);
create index if not exists idx_recommendations_created on public.recommendations (created_at desc);

-- ---------------------------------------------------------------------------
-- User-scoped P&L / journal data (user_id = Firebase/Supabase auth uid)
-- ---------------------------------------------------------------------------
create table if not exists public.client_accounts (
  user_id text not null,
  client_code text not null,
  client_name text not null,
  trade_count int not null default 0,
  last_upload_at bigint not null default 0,
  updated_at bigint not null default 0,
  total_realised_pnl double precision,
  total_net_pnl double precision,
  total_charges double precision,
  period_label text,
  primary key (user_id, client_code)
);

create table if not exists public.trades (
  id text primary key,
  user_id text not null,
  client_code text not null,
  dedupe_key text not null,
  fingerprint text,
  upload_id text,
  symbol text,
  stock_name text,
  isin text,
  quantity int,
  buy_date text,
  buy_price double precision,
  buy_value double precision,
  sell_date text,
  sell_price double precision,
  sell_value double precision,
  realised_pnl double precision,
  remark text,
  trade_type text,
  holding_days int,
  allocated_charges double precision,
  net_pnl double precision,
  client_name text,
  created_at bigint not null default 0
);

create index if not exists idx_trades_user_client on public.trades (user_id, client_code);
create index if not exists idx_trades_sell_date on public.trades (user_id, client_code, sell_date desc);
create index if not exists idx_trades_fingerprint on public.trades (user_id, client_code, fingerprint);

create table if not exists public.uploads (
  id text primary key,
  user_id text not null,
  client_code text not null,
  file_name text,
  content_hash text,
  uploaded_at bigint not null,
  client_name text,
  period_label text,
  period_start text,
  period_end text,
  report_realised_pnl double precision,
  report_unrealised_pnl double precision,
  charges_total double precision,
  charges jsonb default '[]'::jsonb,
  trade_count int,
  new_trades_added int,
  duplicates_skipped int,
  status text default 'completed'
);

create index if not exists idx_uploads_hash on public.uploads (user_id, client_code, content_hash);

create table if not exists public.stock_profiles (
  user_id text not null,
  client_code text not null,
  symbol text not null,
  stock_name text,
  isin text,
  quantity int default 0,
  buy_value double precision default 0,
  sell_value double precision default 0,
  realised_pnl double precision default 0,
  allocated_charges double precision default 0,
  net_pnl double precision default 0,
  trade_count int default 0,
  winning_trades int default 0,
  losing_trades int default 0,
  win_rate double precision default 0,
  primary key (user_id, client_code, symbol)
);

create index if not exists idx_stock_profiles_pnl on public.stock_profiles (user_id, client_code, net_pnl desc);

create table if not exists public.registry_stocks (
  user_id text not null,
  symbol text not null,
  name text,
  current_price double precision default 0,
  market_cap double precision,
  pe double precision,
  rsi double precision,
  macd double precision,
  macd_hist double precision,
  macd_signal double precision,
  sma20 double precision,
  sma50 double precision,
  supports jsonb default '[]'::jsonb,
  resistances jsonb default '[]'::jsonb,
  notes text,
  updated_at bigint not null default 0,
  primary key (user_id, symbol)
);

create table if not exists public.user_stock_levels (
  user_id text not null,
  symbol text not null,
  supports jsonb default '[]'::jsonb,
  resistances jsonb default '[]'::jsonb,
  updated_at bigint not null default 0,
  primary key (user_id, symbol)
);

create table if not exists public.watchlists (
  id text primary key,
  user_id text not null,
  name text not null,
  list_type text,
  symbols jsonb default '[]'::jsonb,
  updated_at bigint not null default 0
);

create index if not exists idx_watchlists_user on public.watchlists (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.universe enable row level security;
alter table public.stocks enable row level security;
alter table public.stock_charts enable row level security;
alter table public.market_catalog enable row level security;
alter table public.volume_shockers_active enable row level security;
alter table public.volume_shockers_daily enable row level security;
alter table public.recommendations enable row level security;
alter table public.client_accounts enable row level security;
alter table public.trades enable row level security;
alter table public.uploads enable row level security;
alter table public.stock_profiles enable row level security;
alter table public.registry_stocks enable row level security;
alter table public.user_stock_levels enable row level security;
alter table public.watchlists enable row level security;

-- Shared read-only market data for allowed user
create policy universe_read on public.universe for select using (public.is_allowed_user());
create policy universe_write on public.universe for insert with check (public.is_allowed_user());
create policy universe_update on public.universe for update using (public.is_allowed_user());

create policy stocks_read on public.stocks for select using (public.is_allowed_user());
create policy stock_charts_read on public.stock_charts for select using (public.is_allowed_user());
create policy market_catalog_read on public.market_catalog for select using (public.is_allowed_user());
create policy volume_active_read on public.volume_shockers_active for select using (public.is_allowed_user());
create policy volume_daily_read on public.volume_shockers_daily for select using (public.is_allowed_user());

-- Recommendations: read + approve/reject fields only from UI
create policy recommendations_read on public.recommendations for select using (public.is_allowed_user());
create policy recommendations_update on public.recommendations for update using (public.is_allowed_user());

-- User-owned rows
create policy client_accounts_all on public.client_accounts for all
  using (public.is_allowed_user() and user_id = auth.uid()::text)
  with check (public.is_allowed_user() and user_id = auth.uid()::text);

create policy trades_all on public.trades for all
  using (public.is_allowed_user() and user_id = auth.uid()::text)
  with check (public.is_allowed_user() and user_id = auth.uid()::text);

create policy uploads_all on public.uploads for all
  using (public.is_allowed_user() and user_id = auth.uid()::text)
  with check (public.is_allowed_user() and user_id = auth.uid()::text);

create policy stock_profiles_all on public.stock_profiles for all
  using (public.is_allowed_user() and user_id = auth.uid()::text)
  with check (public.is_allowed_user() and user_id = auth.uid()::text);

create policy registry_stocks_all on public.registry_stocks for all
  using (public.is_allowed_user() and user_id = auth.uid()::text)
  with check (public.is_allowed_user() and user_id = auth.uid()::text);

create policy user_levels_all on public.user_stock_levels for all
  using (public.is_allowed_user() and user_id = auth.uid()::text)
  with check (public.is_allowed_user() and user_id = auth.uid()::text);

create policy watchlists_all on public.watchlists for all
  using (public.is_allowed_user() and user_id = auth.uid()::text)
  with check (public.is_allowed_user() and user_id = auth.uid()::text);

-- Backend service role bypasses RLS when using postgres superuser connection.

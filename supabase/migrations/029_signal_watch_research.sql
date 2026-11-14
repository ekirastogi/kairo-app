-- News, overall call, and market context on each signal watch row.

alter table public.signal_watch
  add column if not exists news jsonb not null default '[]'::jsonb,
  add column if not exists overall_signal text not null default 'neutral',
  add column if not exists signal_reason text not null default '',
  add column if not exists nifty_note text not null default '',
  add column if not exists sector_note text not null default '',
  add column if not exists news_updated_at bigint not null default 0,
  add column if not exists ai_analyses jsonb not null default '[]'::jsonb;

alter table public.signal_watch drop constraint if exists signal_watch_overall_signal_check;
alter table public.signal_watch
  add constraint signal_watch_overall_signal_check
  check (overall_signal in ('positive', 'negative', 'neutral'));

NOTIFY pgrst, 'reload schema';

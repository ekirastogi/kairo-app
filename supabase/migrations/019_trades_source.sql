-- Tag realised trades by ingest source so Sunday Excel can supersede mid-week contract notes.
alter table public.trades
  add column if not exists source text;

comment on column public.trades.source is 'excel | contract_note — ingest provenance';

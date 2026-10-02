-- Query paths used by Performance custom lists and Utility/trade-plan stock search.
-- listManual() filters watchlists by (user_id, list_type); registry typeahead uses ILIKE.

create index if not exists idx_watchlists_user_list_type
  on public.watchlists (user_id, list_type);

create extension if not exists pg_trgm;

create index if not exists idx_registry_stocks_symbol_trgm
  on public.registry_stocks using gin (symbol gin_trgm_ops);

create index if not exists idx_registry_stocks_name_trgm
  on public.registry_stocks using gin (name gin_trgm_ops);

-- Enable Supabase Realtime for tables used by frontend watchTable().

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'client_accounts',
    'trades',
    'stock_profiles',
    'recommendations',
    'watchlists',
    'registry_stocks',
    'user_stock_levels',
    'universe',
    'stocks'
  ]
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', tbl);
    exception
      when duplicate_object then null;
    end;
  end loop;
end $$;

-- Firebase Third-Party Auth: use JWT sub (Firebase uid) instead of auth.uid() (UUID).

create or replace function public.firebase_user_id()
returns text
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '');
$$;

-- Replace user-scoped policies (auth.uid() does not work with Firebase JWTs).

drop policy if exists client_accounts_all on public.client_accounts;
create policy client_accounts_all on public.client_accounts for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

drop policy if exists trades_all on public.trades;
create policy trades_all on public.trades for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

drop policy if exists uploads_all on public.uploads;
create policy uploads_all on public.uploads for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

drop policy if exists stock_profiles_all on public.stock_profiles;
create policy stock_profiles_all on public.stock_profiles for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

drop policy if exists registry_stocks_all on public.registry_stocks;
create policy registry_stocks_all on public.registry_stocks for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

drop policy if exists user_levels_all on public.user_stock_levels;
create policy user_levels_all on public.user_stock_levels for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

drop policy if exists watchlists_all on public.watchlists;
create policy watchlists_all on public.watchlists for all
  using (public.is_allowed_user() and user_id = public.firebase_user_id())
  with check (public.is_allowed_user() and user_id = public.firebase_user_id());

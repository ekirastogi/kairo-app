-- Canonicalise merger ISINs so pre/post amalgamation trades share one stock profile.
-- Mindtree (INE018I01017) → LTIM / former LTI (INE214T01019)
-- TV18 (INE886H01027) → NETWORK18 (INE870H01013)

update public.corporate_actions
set
  from_isin = 'INE018I01017',
  to_isin = 'INE214T01019',
  to_symbol = 'LTIM',
  to_name = coalesce(nullif(to_name, ''), 'LTIMindtree Ltd'),
  updated_at = (extract(epoch from now()) * 1000)::bigint
where upper(from_symbol) = 'MINDTREE'
  and (coalesce(from_isin, '') = '' or coalesce(to_isin, '') = '');

update public.corporate_actions
set
  from_isin = 'INE886H01027',
  to_isin = 'INE870H01013',
  to_symbol = 'NETWORK18',
  to_name = coalesce(nullif(to_name, ''), 'Network18 Media & Investments Ltd'),
  updated_at = (extract(epoch from now()) * 1000)::bigint
where upper(from_symbol) in ('TV18BRDCST', 'TV18BROADCAST')
  and (coalesce(from_isin, '') = '' or coalesce(to_isin, '') = '');

-- Mindtree / remapped Mindtree → surviving LTIM ISIN
update public.trades
set
  original_isin = coalesce(nullif(original_isin, ''), isin),
  original_symbol = coalesce(nullif(original_symbol, ''), symbol),
  original_stock_name = coalesce(nullif(original_stock_name, ''), stock_name),
  isin = 'INE214T01019',
  symbol = 'LTIM',
  stock_name = 'LTIMindtree Ltd'
where isin = 'INE018I01017'
   or upper(coalesce(original_symbol, '')) = 'MINDTREE'
   or upper(coalesce(symbol, '')) = 'MINDTREE';

-- Surviving LTI / LTM rows → LTIM display
update public.trades
set
  symbol = 'LTIM',
  stock_name = 'LTIMindtree Ltd'
where isin = 'INE214T01019'
  and (upper(coalesce(symbol, '')) <> 'LTIM' or upper(coalesce(stock_name, '')) <> 'LTIMINDTREE LTD');

-- TV18 / remapped TV18 → surviving NETWORK18 ISIN
update public.trades
set
  original_isin = coalesce(nullif(original_isin, ''), isin),
  original_symbol = coalesce(nullif(original_symbol, ''), symbol),
  original_stock_name = coalesce(nullif(original_stock_name, ''), stock_name),
  isin = 'INE870H01013',
  symbol = 'NETWORK18',
  stock_name = 'Network18 Media & Investments Ltd'
where isin = 'INE886H01027'
   or upper(coalesce(original_symbol, '')) like 'TV18%'
   or upper(coalesce(symbol, '')) like 'TV18%';

-- Surviving NETWORK18 rows → canonical ticker/name
update public.trades
set
  symbol = 'NETWORK18',
  stock_name = 'Network18 Media & Investments Ltd'
where isin = 'INE870H01013'
  and (
    upper(coalesce(symbol, '')) <> 'NETWORK18'
    or upper(coalesce(stock_name, '')) not like 'NETWORK18 MEDIA & INVESTMENTS%'
  );

-- Drop stale split profiles; app rebuilds from trades on next load.
delete from public.stock_profiles
where isin in ('INE018I01017', 'INE214T01019', 'INE886H01027', 'INE870H01013')
   or upper(symbol) in ('MINDTREE', 'LTIM', 'LTM', 'LTM-T01019', 'TV18BRDCST', 'TV18BROADCAST', 'NETWORK18', 'NETWORK18MEDIA&INV')
   or upper(stock_name) ~ 'MINDTREE|LTIMINDTREE|^LTM LIMITED|NETWORK18|TV18';

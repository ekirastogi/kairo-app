-- TradeBook / trade history used price_trackers (open + executed).
-- planned_trades was already dropped in 024.
drop table if exists public.price_trackers cascade;
drop table if exists public.planned_trades cascade;

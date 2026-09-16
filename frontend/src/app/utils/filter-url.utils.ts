import { ParamMap } from '@angular/router';
import { TradeType } from '../models/trade.models';
import { MarketCapTier } from './market-cap.utils';
import { PnlTierMode } from './pnl-watchlist.utils';
import { PnLBook } from './holdings.utils';
import { defaultTradeTypesForRoute } from './trade-type-filter.utils';

export { defaultTradeTypesForRoute };

export const FILTER_QUERY_KEYS = {
  types: 'types',
  from: 'from',
  to: 'to',
  /** Explicit date preset — all|ytd|fytd|mtd|wtd|last|custom. Prevents All↔Last confusion. */
  period: 'period',
  chart: 'chart',
  top: 'top',
  cap: 'cap',
  side: 'side',
  bands: 'bands',
  tier: 'tier',
  book: 'book',
} as const;

export interface GlobalFilterParams {
  tradeTypes: TradeType[];
  startDate?: string;
  endDate?: string;
  /** URL period key: all | ytd | fytd | mtd | wtd | last | custom */
  period?: string;
  chartPeriod?: 'daily' | 'weekly' | 'monthly';
  topStocks?: number;
}

export interface WatchlistFilterParams {
  side?: 'losing' | 'profitable';
  bands?: PnlTierMode;
  tier?: string | null;
  marketCapTiers: MarketCapTier[];
  book?: PnLBook;
}

export function parseTradeTypes(raw: string | null, fallback: TradeType[]): TradeType[] {
  if (!raw) return fallback;
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean) as TradeType[];
  if (!parts.length) return fallback;
  if (parts.includes('all')) return ['all'];
  const withoutMtf = parts.filter((part) => part !== 'mtf');
  return withoutMtf.length ? withoutMtf : fallback;
}

export function serializeTradeTypes(types: TradeType[]): string | null {
  if (!types.length) return null;
  if (types.includes('all')) return 'all';
  return types.join(',');
}

export function parseMarketCapTiers(raw: string | null): MarketCapTier[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is MarketCapTier =>
      part === 'large' || part === 'mid' || part === 'small' || part === 'micro'
    );
}

export function serializeMarketCapTiers(tiers: MarketCapTier[]): string | null {
  return tiers.length ? tiers.join(',') : null;
}

export function readGlobalFilters(params: ParamMap, defaultTypes: TradeType[]): GlobalFilterParams {
  const tradeTypes = parseTradeTypes(params.get(FILTER_QUERY_KEYS.types), defaultTypes);
  const startDate = params.get(FILTER_QUERY_KEYS.from) ?? undefined;
  const endDate = params.get(FILTER_QUERY_KEYS.to) ?? undefined;
  const period = params.get(FILTER_QUERY_KEYS.period) ?? undefined;
  const chartRaw = params.get(FILTER_QUERY_KEYS.chart);
  const chartPeriod =
    chartRaw === 'weekly' || chartRaw === 'monthly' || chartRaw === 'daily' ? chartRaw : undefined;
  const topRaw = params.get(FILTER_QUERY_KEYS.top);
  const topStocks = topRaw ? Number(topRaw) : undefined;

  return {
    tradeTypes,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    period: period || undefined,
    chartPeriod,
    topStocks: Number.isFinite(topStocks) && topStocks! > 0 ? topStocks : undefined,
  };
}

export function readWatchlistFilters(params: ParamMap): WatchlistFilterParams {
  const sideRaw = params.get(FILTER_QUERY_KEYS.side);
  const side = sideRaw === 'profitable' || sideRaw === 'losing' ? sideRaw : undefined;
  const bandsRaw = params.get(FILTER_QUERY_KEYS.bands);
  const bands = bandsRaw === 'band' || bandsRaw === 'cumulative' ? bandsRaw : undefined;
  const tier = params.get(FILTER_QUERY_KEYS.tier);
  const bookRaw = params.get(FILTER_QUERY_KEYS.book);
  const book = bookRaw === 'holdings' || bookRaw === 'realised' ? bookRaw : undefined;
  return {
    side,
    bands,
    tier: tier || null,
    marketCapTiers: parseMarketCapTiers(params.get(FILTER_QUERY_KEYS.cap)),
    book,
  };
}

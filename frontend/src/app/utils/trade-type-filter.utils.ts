import { TradeType } from '../models/trade.models';

/** DB/UI trade types included when the user picks "Intraday". */
export const INTRADAY_TRADE_TYPES: TradeType[] = ['intraday', 'same_day'];

const ROUTES_WITH_INTRADAY_DEFAULT = [
  '/charges',
  '/analytics',
];

const ROUTES_WITH_ALL_DEFAULT: string[] = [];

export interface TradeTypeSource {
  tradeType: TradeType;
  buyDate: string;
  sellDate: string;
  remark?: string;
  holdingDays?: number;
}

export function defaultTradeTypesForRoute(url: string): TradeType[] {
  if (ROUTES_WITH_ALL_DEFAULT.some((route) => url.includes(route))) return ['all'];
  return ROUTES_WITH_INTRADAY_DEFAULT.some((route) => url.includes(route))
    ? ['intraday', 'delivery']
    : ['all'];
}

export function routeNeedsDefaultTypes(url: string, hasTypesParam: boolean): boolean {
  const needsDefault =
    ROUTES_WITH_INTRADAY_DEFAULT.some((route) => url.includes(route)) ||
    ROUTES_WITH_ALL_DEFAULT.some((route) => url.includes(route));
  return needsDefault && !hasTypesParam;
}

/** Previous default was Intraday-only; upgrade those URLs to Intraday + Delivery. */
export function typesParamIsStaleIntradayDefault(url: string, typesParam: string | null): boolean {
  return (
    ROUTES_WITH_INTRADAY_DEFAULT.some((route) => url.includes(route)) && typesParam === 'intraday'
  );
}

/**
 * Resolve the effective trade type from stored data.
 *
 * The single classifier for the whole app: `ParserService` calls this at parse time too, so a
 * trade cannot be filed under one type on upload and filtered as another. Handles a stale or
 * null `trade_type` in the database by re-deriving from the remark and dates.
 */
export function effectiveTradeType(trade: TradeTypeSource): TradeType {
  const remark = (trade.remark ?? '').toLowerCase();
  if (remark.includes('intraday')) return 'intraday';
  if (remark.includes('mtf')) return 'mtf';
  if (remark.includes('fno') || remark.includes('future') || remark.includes('option')) return 'fno';

  if (trade.buyDate && trade.sellDate && trade.buyDate === trade.sellDate) return 'same_day';
  if (trade.holdingDays === 0) return 'same_day';

  const stored = trade.tradeType;
  if (stored && stored !== 'all') return stored;
  return 'delivery';
}

/** Expand UI filter types to the trade_type values stored in the database. */
export function expandTradeTypes(types?: TradeType[]): TradeType[] | undefined {
  if (!types?.length || types.includes('all')) return types;
  const expanded = new Set<TradeType>();
  for (const type of types) {
    if (type === 'intraday') {
      INTRADAY_TRADE_TYPES.forEach((t) => expanded.add(t));
    } else {
      expanded.add(type);
    }
  }
  return [...expanded];
}

export function buildTradeTypeFilter(types?: TradeType[]): Set<TradeType> | null {
  const expanded = expandTradeTypes(types);
  if (!expanded?.length || expanded.includes('all')) return null;
  return new Set(expanded);
}

export function matchesTradeTypeFilter(tradeType: TradeType, types?: TradeType[]): boolean {
  const filter = buildTradeTypeFilter(types);
  if (!filter) return true;
  return filter.has(tradeType);
}

export function tradeMatchesTypeFilter(trade: TradeTypeSource, types?: TradeType[]): boolean {
  return matchesTradeTypeFilter(effectiveTradeType(trade), types);
}

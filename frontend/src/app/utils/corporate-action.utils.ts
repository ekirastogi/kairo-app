import { CorporateAction } from '../models/corporate-action.models';
import { Trade } from '../models/trade.models';
import { normalizeIsin, normalizeSymbol } from './stock-identity.utils';

export type TradeWithCorporateAction = Trade & {
  symbol?: string;
  originalSymbol?: string;
  originalStockName?: string;
  originalIsin?: string;
  corporateActionId?: string;
};

function nameKey(value: string | undefined | null): string {
  return (value ?? '')
    .toUpperCase()
    .replace(/\bLTD\b\.?/g, '')
    .replace(/\bLIMITED\b/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function matchesFrom(action: CorporateAction, trade: Trade & { symbol?: string }): boolean {
  const fromSym = normalizeSymbol(action.fromSymbol);
  const tradeSym = normalizeSymbol(trade.symbol || trade.stockName);
  if (fromSym && tradeSym && fromSym === tradeSym) return true;

  const fromIsin = normalizeIsin(action.fromIsin);
  const tradeIsin = normalizeIsin(trade.isin);
  if (fromIsin && tradeIsin && fromIsin === tradeIsin) return true;

  const fromName = nameKey(action.fromName || action.fromSymbol);
  const tradeName = nameKey(trade.stockName);
  if (fromName && tradeName && (tradeName === fromName || tradeName.includes(fromName) || fromName.includes(tradeName))) {
    return true;
  }
  return false;
}

/**
 * Remap a trade's identity (and optionally quantity/prices for splits) using the
 * earliest matching corporate action. Preserves original_* so the UI can link back.
 */
export function applyCorporateActionToTrade<T extends TradeWithCorporateAction>(
  trade: T,
  actions: CorporateAction[]
): T {
  if (!actions.length || trade.corporateActionId) return trade;

  const sorted = [...actions].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const action = sorted.find((item) => matchesFrom(item, trade));
  if (!action) return trade;

  const originalSymbol = trade.symbol || normalizeSymbol(trade.stockName);
  const originalStockName = trade.stockName;
  const originalIsin = trade.isin;

  if (action.actionType === 'split') {
    const factor = action.ratioFrom > 0 ? action.ratioTo / action.ratioFrom : 1;
    if (factor !== 1 && Number.isFinite(factor) && factor > 0) {
      const quantity = Math.round(trade.quantity * factor);
      const buyPrice = trade.buyPrice / factor;
      const sellPrice = trade.sellPrice / factor;
      return {
        ...trade,
        quantity,
        buyPrice,
        sellPrice,
        // Values and PnL stay the same for a pure split.
        symbol: normalizeSymbol(action.toSymbol) || originalSymbol,
        stockName: action.toName || trade.stockName,
        isin: normalizeIsin(action.toIsin) || trade.isin,
        originalSymbol,
        originalStockName,
        originalIsin,
        corporateActionId: action.id,
      };
    }
  }

  return {
    ...trade,
    symbol: normalizeSymbol(action.toSymbol) || originalSymbol,
    stockName: action.toName || trade.stockName,
    isin: normalizeIsin(action.toIsin) || trade.isin,
    originalSymbol,
    originalStockName,
    originalIsin,
    corporateActionId: action.id,
  };
}

export function applyCorporateActionsToTrades<T extends TradeWithCorporateAction>(
  trades: T[],
  actions: CorporateAction[]
): T[] {
  if (!actions.length) return trades;
  return trades.map((trade) => applyCorporateActionToTrade(trade, actions));
}

export function formatSwapRatio(action: Pick<CorporateAction, 'ratioFrom' | 'ratioTo'>): string {
  const from = action.ratioFrom || 1;
  const to = action.ratioTo || 1;
  if (from === 1 && to === 1) return '1 : 1';
  return `${from} → ${to}`;
}

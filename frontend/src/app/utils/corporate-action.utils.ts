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

  const originalIsin = normalizeIsin((trade as TradeWithCorporateAction).originalIsin);
  if (fromIsin && originalIsin && fromIsin === originalIsin) return true;

  const fromName = nameKey(action.fromName || action.fromSymbol);
  const tradeName = nameKey(trade.stockName);
  if (
    fromName &&
    tradeName &&
    (tradeName === fromName || tradeName.includes(fromName) || fromName.includes(tradeName))
  ) {
    return true;
  }
  return false;
}

/** Surviving entity after a merge (already on the "to" ISIN/ticker). */
function matchesTo(action: CorporateAction, trade: Trade & { symbol?: string }): boolean {
  const toIsin = normalizeIsin(action.toIsin);
  const tradeIsin = normalizeIsin(trade.isin);
  if (toIsin && tradeIsin && toIsin === tradeIsin) return true;

  const toSym = normalizeSymbol(action.toSymbol);
  const tradeSym = normalizeSymbol(trade.symbol || trade.stockName);
  if (toSym && tradeSym && toSym === tradeSym) return true;

  const toName = nameKey(action.toName || action.toSymbol);
  const tradeName = nameKey(trade.stockName);
  if (toName && tradeName && (tradeName === toName || tradeName.includes(toName) || toName.includes(tradeName))) {
    return true;
  }
  return false;
}

function applyToIdentity<T extends TradeWithCorporateAction>(
  trade: T,
  action: CorporateAction,
  opts: { preserveOriginal: boolean }
): T {
  const originalSymbol =
    trade.originalSymbol || trade.symbol || normalizeSymbol(trade.stockName);
  const originalStockName = trade.originalStockName || trade.stockName;
  const originalIsin = trade.originalIsin || trade.isin;

  const next: T = {
    ...trade,
    symbol: normalizeSymbol(action.toSymbol) || trade.symbol || originalSymbol,
    stockName: action.toName || trade.stockName,
    isin: normalizeIsin(action.toIsin) || trade.isin,
    corporateActionId: trade.corporateActionId || action.id,
  };

  if (opts.preserveOriginal) {
    next.originalSymbol = originalSymbol;
    next.originalStockName = originalStockName;
    next.originalIsin = originalIsin;
  }

  return next;
}

/**
 * Remap a trade's identity (and optionally quantity/prices for splits) using the
 * earliest matching corporate action. Preserves original_* so the UI can link back.
 *
 * Also normalizes rows already on the surviving ("to") ISIN/ticker so post-merger
 * Groww names (e.g. LTM LIMITED, NETWORK18 MEDIA & INV LTD) collapse with remapped
 * pre-merger trades.
 */
export function applyCorporateActionToTrade<T extends TradeWithCorporateAction>(
  trade: T,
  actions: CorporateAction[]
): T {
  if (!actions.length) return trade;

  const sorted = [...actions].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

  if (trade.corporateActionId) {
    const linked = sorted.find((item) => item.id === trade.corporateActionId);
    if (linked) {
      return applyToIdentity(trade, linked, { preserveOriginal: true });
    }
  }

  const fromAction = sorted.find((item) => matchesFrom(item, trade));
  if (fromAction) {
    if (fromAction.actionType === 'split') {
      const factor = fromAction.ratioFrom > 0 ? fromAction.ratioTo / fromAction.ratioFrom : 1;
      if (factor !== 1 && Number.isFinite(factor) && factor > 0 && !trade.corporateActionId) {
        const quantity = Math.round(trade.quantity * factor);
        const buyPrice = trade.buyPrice / factor;
        const sellPrice = trade.sellPrice / factor;
        return applyToIdentity(
          { ...trade, quantity, buyPrice, sellPrice },
          fromAction,
          { preserveOriginal: true }
        );
      }
    }
    return applyToIdentity(trade, fromAction, { preserveOriginal: true });
  }

  const toAction = sorted.find((item) => matchesTo(item, trade));
  if (toAction) {
    return applyToIdentity(trade, toAction, { preserveOriginal: false });
  }

  return trade;
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

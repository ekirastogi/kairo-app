import {
  ContractNoteEquitySummary,
  ContractNoteMatchResult,
  OpenInventoryLot,
  ParsedContractNote,
} from '../models/contract-note.models';
import { Trade, UnrealisedHolding, UnrealisedLot } from '../models/trade.models';
import { aggregateLotsToHolding } from './holdings.utils';
import { normalizeIsin } from './stock-identity.utils';
import { effectiveTradeType } from './trade-type-filter.utils';
import { normalizeSymbol } from './upload-merge.utils';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function cloneLots(lots: OpenInventoryLot[]): OpenInventoryLot[] {
  return lots.map((lot) => ({ ...lot }));
}

/** Flatten stored holdings into FIFO open lots (prefer explicit lots when present). */
export function holdingsToOpenLots(holdings: UnrealisedHolding[]): OpenInventoryLot[] {
  const out: OpenInventoryLot[] = [];
  for (const holding of holdings) {
    const lots = holding.lots ?? [];
    if (lots.length) {
      for (const lot of lots) {
        if (!(lot.quantity > 0)) continue;
        out.push({
          stockName: lot.stockName || holding.stockName,
          isin: normalizeIsin(lot.isin || holding.isin),
          quantity: lot.quantity,
          buyDate: lot.buyDate,
          buyPrice: lot.buyPrice,
          buyValue: lot.buyValue || lot.quantity * lot.buyPrice,
        });
      }
      continue;
    }
    if (!(holding.quantity > 0)) continue;
    out.push({
      stockName: holding.stockName,
      isin: normalizeIsin(holding.isin),
      quantity: holding.quantity,
      buyDate: holding.asOfDate || '',
      buyPrice: holding.avgBuyPrice,
      buyValue: holding.buyValue || holding.quantity * holding.avgBuyPrice,
    });
  }
  return out;
}

function lotsForIsin(lots: OpenInventoryLot[], isin: string): OpenInventoryLot[] {
  const key = normalizeIsin(isin);
  return lots.filter((lot) => normalizeIsin(lot.isin) === key);
}

function removeLotsForIsin(lots: OpenInventoryLot[], isin: string): OpenInventoryLot[] {
  const key = normalizeIsin(isin);
  return lots.filter((lot) => normalizeIsin(lot.isin) !== key);
}

function fifoConsume(
  open: OpenInventoryLot[],
  sellQty: number,
  sellPrice: number,
  sellDate: string,
  stockName: string,
  isin: string
): { trades: Trade[]; remaining: OpenInventoryLot[] } {
  let need = sellQty;
  const remaining = cloneLots(open);
  const trades: Trade[] = [];

  while (need > 1e-9 && remaining.length) {
    const lot = remaining[0];
    const take = Math.min(lot.quantity, need);
    const buyValue = round2(take * lot.buyPrice);
    const sellValue = round2(take * sellPrice);
    const trade: Trade = {
      stockName: lot.stockName || stockName,
      isin: normalizeIsin(isin),
      quantity: take,
      buyDate: lot.buyDate || sellDate,
      buyPrice: lot.buyPrice,
      buyValue,
      sellDate,
      sellPrice,
      sellValue,
      realisedPnL: round2(sellValue - buyValue),
      remark: lot.buyDate && lot.buyDate !== sellDate ? 'Delivery trade' : 'Contract note',
      tradeType: 'delivery',
      holdingDays: 0,
    };
    trade.tradeType = effectiveTradeType(trade);
    trade.holdingDays =
      trade.buyDate && trade.sellDate && trade.buyDate !== trade.sellDate
        ? Math.max(
            0,
            Math.round(
              (Date.parse(trade.sellDate) - Date.parse(trade.buyDate)) / (24 * 60 * 60 * 1000)
            )
          )
        : 0;
    trades.push(trade);

    lot.quantity = round2(lot.quantity - take);
    lot.buyValue = round2(lot.quantity * lot.buyPrice);
    need = round2(need - take);
    if (lot.quantity <= 1e-9) remaining.shift();
  }

  if (need > 1e-6) {
    // No open lot — treat as same-day unknown basis using sell price (P&L 0) so the day is not dropped.
    const sellValue = round2(need * sellPrice);
    const trade: Trade = {
      stockName,
      isin: normalizeIsin(isin),
      quantity: need,
      buyDate: sellDate,
      buyPrice: sellPrice,
      buyValue: sellValue,
      sellDate,
      sellPrice,
      sellValue,
      realisedPnL: 0,
      remark: 'Contract note (missing buy lot)',
      tradeType: 'delivery',
      holdingDays: 0,
    };
    trade.tradeType = effectiveTradeType(trade);
    trades.push(trade);
  }

  return { trades, remaining };
}

function sameDayTrade(row: ContractNoteEquitySummary, tradeDate: string, qty: number): Trade {
  const buyPrice = row.buyWap;
  const sellPrice = row.sellWap;
  const buyValue = round2(qty * buyPrice);
  const sellValue = round2(qty * sellPrice);
  // Prefer Groww summary net scaled to the matched qty when the row is fully flat.
  const fullQty = Math.max(row.buyQuantity, row.sellQuantity, qty);
  const realisedPnL =
    fullQty > 0 && Math.abs(row.netQuantity) < 1e-9
      ? round2(row.netAmount * (qty / fullQty))
      : round2(sellValue - buyValue);

  const trade: Trade = {
    stockName: row.stockName,
    isin: normalizeIsin(row.isin),
    quantity: qty,
    buyDate: tradeDate,
    buyPrice,
    buyValue,
    sellDate: tradeDate,
    sellPrice,
    sellValue,
    realisedPnL,
    remark: 'Intraday trade',
    tradeType: 'intraday',
    holdingDays: 0,
  };
  trade.tradeType = effectiveTradeType(trade);
  return trade;
}

/**
 * Match one contract note day against open inventory.
 * Primary path: same-day overlap. Secondary: FIFO delivery for excess sells; leftover buys open lots.
 */
export function matchContractNoteDay(
  note: ParsedContractNote,
  priorOpenLots: OpenInventoryLot[]
): ContractNoteMatchResult {
  let openLots = cloneLots(priorOpenLots);
  const trades: Trade[] = [];

  for (const row of note.equity) {
    const buyQty = row.buyQuantity;
    const sellQty = row.sellQuantity;
    const overlap = Math.min(buyQty, sellQty);

    if (overlap > 0) {
      trades.push(sameDayTrade(row, note.tradeDate, overlap));
    }

    const excessSell = round2(sellQty - overlap);
    const excessBuy = round2(buyQty - overlap);
    const isinLots = lotsForIsin(openLots, row.isin);
    const otherLots = removeLotsForIsin(openLots, row.isin);

    if (excessSell > 0) {
      const { trades: deliveryTrades, remaining } = fifoConsume(
        isinLots,
        excessSell,
        row.sellWap || (sellQty ? row.sellValue / sellQty : 0),
        note.tradeDate,
        row.stockName,
        row.isin
      );
      trades.push(...deliveryTrades);
      openLots = [...otherLots, ...remaining];
    } else {
      openLots = [...otherLots, ...isinLots];
    }

    if (excessBuy > 0) {
      const buyPrice = row.buyWap || (buyQty ? row.buyValue / buyQty : 0);
      openLots.push({
        stockName: row.stockName,
        isin: normalizeIsin(row.isin),
        quantity: excessBuy,
        buyDate: note.tradeDate,
        buyPrice,
        buyValue: round2(excessBuy * buyPrice),
      });
    }
  }

  const unrealisedLots: UnrealisedLot[] = openLots
    .filter((lot) => lot.quantity > 0)
    .map((lot) => ({
      stockName: lot.stockName,
      isin: lot.isin,
      quantity: lot.quantity,
      buyDate: lot.buyDate,
      buyPrice: lot.buyPrice,
      buyValue: lot.buyValue,
      closingDate: note.tradeDate,
      closingPrice: lot.buyPrice,
      closingValue: lot.buyValue,
      unrealisedPnL: 0,
      remark: '',
      holdingDays: 0,
    }));

  const byIsin = new Map<string, UnrealisedLot[]>();
  for (const lot of unrealisedLots) {
    const key = normalizeIsin(lot.isin) || lot.stockName;
    const list = byIsin.get(key) ?? [];
    list.push(lot);
    byIsin.set(key, list);
  }

  const holdings: UnrealisedHolding[] = [...byIsin.values()].map((group) => {
    const holding = aggregateLotsToHolding(group, note.tradeDate);
    holding.symbol = normalizeSymbol(holding.stockName);
    return holding;
  });

  return {
    trades,
    openLots: openLots.filter((lot) => lot.quantity > 0),
    holdings,
    unrealisedLots,
  };
}

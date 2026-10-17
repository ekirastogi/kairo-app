import { ExecutionLeg, TradeDirection } from '../models/trading-journal.models';

export type FillSide = 'buy' | 'sell';

export interface AvgFill {
  id: string;
  side: FillSide;
  price: number;
  quantity: number;
}

/** A partial exit level: sell this many shares of the position at this price. */
export interface AvgTarget {
  id: string;
  price: number;
  quantity: number;
}

export interface AvgCalculatorSummary {
  buyQty: number;
  buyValue: number;
  avgBuy: number | null;
  sellQty: number;
  sellValue: number;
  avgSell: number | null;
  matchedQty: number;
  netQty: number;
  realizedPnL: number | null;
  matchedAvgBuy: number | null;
  matchedAvgSell: number | null;
  remainingSide: FillSide | null;
  remainingQty: number;
  remainingAvg: number | null;
}

/** Remaining lots after matching buys and sells. Fully closed books have no position. */
export interface AvgPosition {
  side: FillSide;
  quantity: number;
  avgPrice: number;
}

function newId(): string {
  return crypto.randomUUID();
}

export function createFill(side: FillSide, price: number, quantity: number): AvgFill {
  return { id: newId(), side, price, quantity };
}

export function createTarget(price: number, quantity: number): AvgTarget {
  return { id: newId(), price, quantity };
}

interface OpenLot {
  price: number;
  quantity: number;
}

export function summarizeFills(fills: AvgFill[]): AvgCalculatorSummary {
  let buyQty = 0;
  let buyValue = 0;
  let sellQty = 0;
  let sellValue = 0;
  const buyLots: OpenLot[] = [];
  const sellLots: OpenLot[] = [];

  for (const fill of fills) {
    const value = fill.price * fill.quantity;
    if (fill.side === 'buy') {
      buyQty += fill.quantity;
      buyValue += value;
      buyLots.push({ price: fill.price, quantity: fill.quantity });
    } else {
      sellQty += fill.quantity;
      sellValue += value;
      sellLots.push({ price: fill.price, quantity: fill.quantity });
    }
  }

  let matchedQty = 0;
  let matchedBuyValue = 0;
  let matchedSellValue = 0;
  let bi = 0;
  let si = 0;
  while (bi < buyLots.length && si < sellLots.length) {
    const buy = buyLots[bi];
    const sell = sellLots[si];
    const qty = Math.min(buy.quantity, sell.quantity);
    matchedQty += qty;
    matchedBuyValue += qty * buy.price;
    matchedSellValue += qty * sell.price;
    buy.quantity -= qty;
    sell.quantity -= qty;
    if (buy.quantity <= 0) bi += 1;
    if (sell.quantity <= 0) si += 1;
  }

  let remainingQty = 0;
  let remainingValue = 0;
  let remainingSide: FillSide | null = null;
  for (let i = bi; i < buyLots.length; i++) {
    remainingQty += buyLots[i].quantity;
    remainingValue += buyLots[i].quantity * buyLots[i].price;
    remainingSide = 'buy';
  }
  for (let i = si; i < sellLots.length; i++) {
    remainingQty += sellLots[i].quantity;
    remainingValue += sellLots[i].quantity * sellLots[i].price;
    remainingSide = 'sell';
  }

  const avgBuy = buyQty > 0 ? buyValue / buyQty : null;
  const avgSell = sellQty > 0 ? sellValue / sellQty : null;
  const realizedPnL = matchedQty > 0 ? matchedSellValue - matchedBuyValue : null;
  const remainingAvg = remainingQty > 0 ? remainingValue / remainingQty : null;

  return {
    buyQty,
    buyValue,
    avgBuy,
    sellQty,
    sellValue,
    avgSell,
    matchedQty,
    netQty: buyQty - sellQty,
    realizedPnL,
    matchedAvgBuy: matchedQty > 0 ? matchedBuyValue / matchedQty : null,
    matchedAvgSell: matchedQty > 0 ? matchedSellValue / matchedQty : null,
    remainingSide,
    remainingQty,
    remainingAvg,
  };
}

export function openPosition(summary: AvgCalculatorSummary): AvgPosition | null {
  if (summary.remainingQty > 0 && summary.remainingAvg != null && summary.remainingSide) {
    return {
      side: summary.remainingSide,
      quantity: summary.remainingQty,
      avgPrice: summary.remainingAvg,
    };
  }
  return null;
}

/** Position direction in the terms the charges service and trade book use. */
export function positionDirection(position: AvgPosition): TradeDirection {
  return position.side === 'buy' ? 'long' : 'short';
}

/** Buy and sell fills as execution legs for trade history. */
export function fillsToExecutionLegs(fills: AvgFill[]): {
  buyLegs: ExecutionLeg[];
  sellLegs: ExecutionLeg[];
} {
  const buyLegs: ExecutionLeg[] = [];
  const sellLegs: ExecutionLeg[] = [];
  for (const fill of fills) {
    const leg = { quantity: fill.quantity, price: fill.price };
    if (fill.side === 'buy') buyLegs.push(leg);
    else sellLegs.push(leg);
  }
  return { buyLegs, sellLegs };
}

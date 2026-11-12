import { StockSummary } from '../models/trade.models';
import { groupStocksByLetter, stockLetter } from './letter-pnl.utils';

function stock(partial: Partial<StockSummary>): StockSummary {
  return {
    stockName: 'Alpha',
    isin: 'INE000',
    symbol: 'ALPHA',
    quantity: 1,
    avgBuyPrice: 1,
    buyValue: 1,
    avgSellPrice: 1,
    sellValue: 1,
    realisedPnL: 0,
    realisedPnLPct: 0,
    tradeCount: 1,
    allocatedCharges: 0,
    netPnL: 0,
    ...partial,
  };
}

describe('stockLetter', () => {
  it('uses the first letter of the stock name', () => {
    expect(stockLetter(stock({ stockName: 'asian paints' }))).toBe('A');
  });

  it('falls back to the ticker and groups non-letters under #', () => {
    expect(stockLetter(stock({ stockName: '', symbol: 'TCS' }))).toBe('T');
    expect(stockLetter(stock({ stockName: '  3M India', symbol: 'MMM' }))).toBe('#');
  });
});

describe('groupStocksByLetter', () => {
  it('rolls losing, profitable, and net P&L per letter', () => {
    const rows = groupStocksByLetter([
      stock({ stockName: 'Asian Paints', netPnL: 1000 }),
      stock({ stockName: 'Adani Ent', netPnL: -400 }),
      stock({ stockName: 'TCS', netPnL: 250 }),
    ]);
    expect(rows.map((row) => row.letter)).toEqual(['A', 'T']);
    const a = rows[0];
    expect(a.stockCount).toBe(2);
    expect(a.losingCount).toBe(1);
    expect(a.profitableCount).toBe(1);
    expect(a.losingPnL).toBe(-400);
    expect(a.profitablePnL).toBe(1000);
    expect(a.netPnL).toBe(600);
  });
});

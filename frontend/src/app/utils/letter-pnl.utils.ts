import { StockSummary } from '../models/trade.models';

export interface LetterPnLRow {
  letter: string;
  stocks: StockSummary[];
  stockCount: number;
  losingCount: number;
  profitableCount: number;
  losingPnL: number;
  profitablePnL: number;
  netPnL: number;
}

/** First A–Z of the stock name (or ticker). Anything else groups under "#". */
export function stockLetter(stock: Pick<StockSummary, 'stockName' | 'symbol'>): string {
  const source = (stock.stockName || stock.symbol || '').trim();
  const ch = source.charAt(0).toUpperCase();
  return ch >= 'A' && ch <= 'Z' ? ch : '#';
}

export function groupStocksByLetter(stocks: StockSummary[]): LetterPnLRow[] {
  const buckets = new Map<string, StockSummary[]>();
  for (const stock of stocks) {
    const letter = stockLetter(stock);
    const list = buckets.get(letter);
    if (list) list.push(stock);
    else buckets.set(letter, [stock]);
  }

  const letters = [...buckets.keys()].sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });

  return letters.map((letter) => {
    const list = [...(buckets.get(letter) ?? [])].sort((a, b) =>
      a.stockName.localeCompare(b.stockName, undefined, { sensitivity: 'base' })
    );
    let losingCount = 0;
    let profitableCount = 0;
    let losingPnL = 0;
    let profitablePnL = 0;
    let netPnL = 0;
    for (const stock of list) {
      netPnL += stock.netPnL;
      if (stock.netPnL < 0) {
        losingCount += 1;
        losingPnL += stock.netPnL;
      } else if (stock.netPnL > 0) {
        profitableCount += 1;
        profitablePnL += stock.netPnL;
      }
    }
    return {
      letter,
      stocks: list,
      stockCount: list.length,
      losingCount,
      profitableCount,
      losingPnL,
      profitablePnL,
      netPnL,
    };
  });
}

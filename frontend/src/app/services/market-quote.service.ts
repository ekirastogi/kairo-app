import { Injectable, inject } from '@angular/core';
import { ScreenerService } from './screener.service';

export type MarketQuoteSource = 'screener' | 'groww';

export interface MarketQuote {
  symbol: string;
  price: number;
  source: MarketQuoteSource;
  fetchedAt: number;
}

/**
 * Live CMP for trackers. Screener is the current provider; swap `source`
 * (or add a Groww client in `quoteFromGroww`) when those APIs are wired.
 */
@Injectable({ providedIn: 'root' })
export class MarketQuoteService {
  private screener = inject(ScreenerService);

  /** Change to `'groww'` once a Groww quote client exists. */
  readonly source: MarketQuoteSource = 'screener';

  async quote(symbol: string, name?: string): Promise<MarketQuote> {
    switch (this.source) {
      case 'groww':
        return this.quoteFromGroww(symbol);
      default:
        return this.quoteFromScreener(symbol, name);
    }
  }

  private async quoteFromScreener(symbol: string, name?: string): Promise<MarketQuote> {
    const snap = await this.screener.fetchStock(symbol, name);
    const price = snap.currentPrice ?? 0;
    if (!(price > 0)) {
      throw new Error(`Screener returned no CMP for ${symbol.toUpperCase()}`);
    }
    return {
      symbol: symbol.toUpperCase(),
      price,
      source: 'screener',
      fetchedAt: snap.fetchedAt || Date.now(),
    };
  }

  private async quoteFromGroww(symbol: string): Promise<MarketQuote> {
    throw new Error(`Groww quotes are not wired yet (${symbol.toUpperCase()})`);
  }
}

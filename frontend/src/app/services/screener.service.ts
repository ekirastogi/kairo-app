import { Injectable, inject } from '@angular/core';
import { supabaseConfig } from '../../environments/supabase.config';
import { RegistryFinancialTable } from '../models/trading-journal.models';
import { looksLikeIsin, normalizeIsin } from '../utils/stock-identity.utils';
import { RegistryStockService } from './registry-stock.service';
import { StockFirestoreService } from './stock-firestore.service';
import { SupabaseService } from './supabase.service';

export interface ScreenerSnapshot {
  symbol: string;
  name: string;
  url: string;
  currentPrice?: number;
  marketCap?: number;
  pe?: number;
  bookValue?: number;
  dividendYield?: number;
  roce?: number;
  roe?: number;
  faceValue?: number;
  highLow?: string;
  salesGrowth3y?: number;
  salesGrowth5y?: number;
  salesGrowth10y?: number;
  salesGrowthTtm?: number;
  profitGrowth3y?: number;
  profitGrowth5y?: number;
  profitGrowth10y?: number;
  profitGrowthTtm?: number;
  stockCagr1y?: number;
  stockCagr3y?: number;
  stockCagr5y?: number;
  stockCagr10y?: number;
  promoterHolding?: number;
  fiiHolding?: number;
  diiHolding?: number;
  publicHolding?: number;
  governmentHolding?: number;
  otherHolding?: number;
  quarterlyResults: RegistryFinancialTable;
  profitLoss: RegistryFinancialTable;
  cashFlow: RegistryFinancialTable;
  balanceSheet: RegistryFinancialTable;
  shareholding: RegistryFinancialTable;
  fetchedAt: number;
}

export interface ScreenerFetchOpts {
  isin?: string;
}

@Injectable({ providedIn: 'root' })
export class ScreenerService {
  private supabase = inject(SupabaseService);
  private registry = inject(RegistryStockService);
  private stocks = inject(StockFirestoreService);

  async fetchStock(symbol: string, opts?: ScreenerFetchOpts): Promise<ScreenerSnapshot> {
    const resolved = await this.resolveLookup(symbol, opts?.isin);
    // Use fetch directly — supabase.functions.invoke always attaches the Firebase JWT
    // from accessToken, which the Edge gateway rejects even when JWT verify is off.
    const res = await fetch(`${supabaseConfig.url}/functions/v1/screener-fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseConfig.anonKey,
        Authorization: `Bearer ${supabaseConfig.anonKey}`,
      },
      body: JSON.stringify({
        symbol: resolved.symbol,
        isin: resolved.isin || undefined,
      }),
    });

    let payload: ScreenerSnapshot & { error?: string; message?: string } | null = null;
    try {
      payload = (await res.json()) as ScreenerSnapshot & { error?: string; message?: string };
    } catch {
      payload = null;
    }

    if (!res.ok) {
      throw new Error(payload?.error ?? payload?.message ?? `Screener fetch failed (${res.status})`);
    }
    if (!payload || payload.error) {
      throw new Error(payload?.error ?? 'Screener fetch failed');
    }
    return payload;
  }

  /** Prefer ISIN → exchange ticker. Never send a company name to Screener search. */
  private async resolveLookup(
    rawSymbol: string,
    rawIsin?: string
  ): Promise<{ symbol: string; isin: string }> {
    const typed = rawSymbol.trim().toUpperCase().replace(/\.(NS|BO|BSE)$/i, '');
    const isin = looksLikeIsin(rawIsin)
      ? normalizeIsin(rawIsin)
      : looksLikeIsin(typed)
        ? typed
        : '';
    let ticker = looksLikeIsin(typed) ? '' : typed;

    if (isin) {
      const registry = await this.registry.getByIsin(isin);
      if (registry?.symbol) ticker = registry.symbol.trim().toUpperCase();
      if (!ticker || looksLikeIsin(ticker)) {
        const market = await this.stocks.fetchStockByIsin(isin);
        if (market?.symbol) ticker = market.symbol.trim().toUpperCase();
      }
    }

    return { symbol: ticker || typed, isin };
  }
}

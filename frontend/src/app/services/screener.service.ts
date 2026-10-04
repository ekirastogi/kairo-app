import { Injectable, inject } from '@angular/core';
import { supabaseConfig } from '../../environments/supabase.config';
import { RegistryFinancialTable } from '../models/trading-journal.models';
import { looksLikeIsin, normalizeIsin } from '../utils/stock-identity.utils';
import {
  parseScreenerHtml,
  snapshotMatchesPage,
  tickerFromScreenerUrl,
} from '../utils/screener-page.utils';
import { RegistryStockService } from './registry-stock.service';
import { StockFirestoreService } from './stock-firestore.service';
import { SupabaseService } from './supabase.service';

export interface ScreenerSnapshot {
  symbol: string;
  name: string;
  url: string;
  isin?: string;
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
  /** Company name. Used when the stored symbol is not the exchange ticker. */
  name?: string;
  /** Exact Screener.in company page. Skips search when the ticker maps to the wrong stock. */
  pageUrl?: string;
}

@Injectable({ providedIn: 'root' })
export class ScreenerService {
  private supabase = inject(SupabaseService);
  private registry = inject(RegistryStockService);
  private stocks = inject(StockFirestoreService);

  async fetchStock(symbol: string, opts?: ScreenerFetchOpts): Promise<ScreenerSnapshot> {
    const pageUrl = opts?.pageUrl?.trim();
    const resolved = pageUrl
      ? { symbol: symbol.trim().toUpperCase(), isin: opts?.isin?.trim() ?? '' }
      : await this.resolveLookup(symbol, opts?.isin);
    let payload: ScreenerSnapshot | null = null;
    try {
      payload = await this.postScreenerFetch({
        symbol: resolved.symbol,
        isin: resolved.isin || undefined,
        name: opts?.name?.trim() || undefined,
        pageUrl: pageUrl || undefined,
      });
    } catch (error) {
      if (!pageUrl) throw error;
    }

    // Live edge function still ignores pageUrl and searches by ticker. If the
    // pasted company page is a different stock, scrape that page instead.
    if (pageUrl && !snapshotMatchesPage(payload, pageUrl)) {
      payload = await this.fetchSnapshotFromPageUrl(pageUrl, opts?.name);
    }
    if (!payload) throw new Error('Screener fetch failed');

    if (!payload.isin && payload.symbol) {
      const market = await this.stocks.fetchStockBySymbol(payload.symbol);
      if (market?.isin) payload = { ...payload, isin: market.isin };
    }
    return payload;
  }

  private async postScreenerFetch(body: {
    symbol: string;
    isin?: string;
    name?: string;
    pageUrl?: string;
  }): Promise<ScreenerSnapshot> {
    const res = await fetch(`${supabaseConfig.url}/functions/v1/screener-fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseConfig.anonKey,
        Authorization: `Bearer ${supabaseConfig.anonKey}`,
      },
      body: JSON.stringify(body),
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

  private async fetchSnapshotFromPageUrl(pageUrl: string, fallbackName?: string): Promise<ScreenerSnapshot> {
    const ticker = tickerFromScreenerUrl(pageUrl);
    if (!ticker) throw new Error('That is not a Screener company page URL');
    const html = await this.readScreenerHtml(pageUrl);
    const snapshot = parseScreenerHtml(html, pageUrl, fallbackName);
    if (!snapshotMatchesPage(snapshot, pageUrl) || !snapshot.name) {
      throw new Error('Could not read that Screener company page');
    }
    return snapshot;
  }

  private async readScreenerHtml(pageUrl: string): Promise<string> {
    const res = await fetch(`https://r.jina.ai/${pageUrl}`, {
      headers: {
        Accept: 'text/html',
        'X-Return-Format': 'html',
      },
    });
    if (!res.ok) {
      throw new Error('Could not load the pasted Screener page. Try again in a moment.');
    }
    const html = await res.text();
    if (html.length < 2000 || /page not found/i.test(html)) {
      throw new Error('That Screener URL did not return a company page');
    }
    return html;
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

import { Injectable, inject } from '@angular/core';
import { Observable, of, switchMap } from 'rxjs';
import { AuthService } from './auth.service';
import { MarketQuote, MarketQuoteSource } from './market-quote.service';
import { objectToSnake, rowToCamel, SupabaseService } from './supabase.service';
import { parsePositivePrices } from '../utils/price-tracker.utils';

export interface PriceTracker {
  id: string;
  symbol: string;
  stockName?: string;
  isin?: string;
  action: string;
  targetPrice: number;
  nextTargets: number[];
  cmp?: number;
  cmpSource?: MarketQuoteSource;
  cmpFetchedAt?: number;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SavePriceTrackerInput {
  symbol: string;
  stockName?: string;
  isin?: string;
  action: string;
  targetPrice: number;
  nextTargets?: Array<string | number>;
  cmp?: number;
  cmpSource?: MarketQuoteSource;
  cmpFetchedAt?: number;
  notes?: string;
}

@Injectable({ providedIn: 'root' })
export class PriceTrackerService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  watchAll(): Observable<PriceTracker[]> {
    return this.auth.user$.pipe(
      switchMap((user) => {
        if (!user) return of([]);
        return this.supabase.watchTable('price_trackers', () => this.listAll(), undefined, 'price_trackers');
      })
    );
  }

  async listAll(): Promise<PriceTracker[]> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];
    const { data, error } = await this.supabase.client
      .from('price_trackers')
      .select('*')
      .eq('user_id', uid)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => rowToPriceTracker(row));
  }

  async save(input: SavePriceTrackerInput, id?: string): Promise<string> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to save trackers');
    const symbol = input.symbol.toUpperCase().trim();
    if (!symbol) throw new Error('Symbol is required');
    const action = input.action.trim();
    if (!action) throw new Error('Action is required');
    if (!(input.targetPrice > 0)) throw new Error('Target price is required');

    const now = Date.now();
    const rowId = id ?? crypto.randomUUID();
    const row = objectToSnake({
      id: rowId,
      userId: uid,
      symbol,
      stockName: input.stockName?.trim() || symbol,
      isin: input.isin?.trim() || '',
      action,
      targetPrice: input.targetPrice,
      nextTargets: parsePositivePrices(input.nextTargets ?? []),
      cmp: input.cmp ?? null,
      cmpSource: input.cmpSource ?? 'screener',
      cmpFetchedAt: input.cmpFetchedAt ?? null,
      notes: input.notes?.trim() ?? '',
      updatedAt: now,
      ...(id ? {} : { createdAt: now }),
    });

    if (id) {
      const { error } = await this.supabase.client
        .from('price_trackers')
        .update(row)
        .eq('id', id)
        .eq('user_id', uid);
      if (error) throw error;
      return rowId;
    }

    const { error } = await this.supabase.client.from('price_trackers').insert(row);
    if (error) throw error;
    return rowId;
  }

  async remove(id: string): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to remove trackers');
    const { error } = await this.supabase.client
      .from('price_trackers')
      .delete()
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
  }

  async applyQuote(symbol: string, quote: MarketQuote): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to refresh CMP');
    const { error } = await this.supabase.client
      .from('price_trackers')
      .update(
        objectToSnake({
          cmp: quote.price,
          cmpSource: quote.source,
          cmpFetchedAt: quote.fetchedAt,
          updatedAt: Date.now(),
        })
      )
      .eq('user_id', uid)
      .eq('symbol', symbol.toUpperCase());
    if (error) throw error;
  }
}

function rowToPriceTracker(row: Record<string, unknown>): PriceTracker {
  const camel = rowToCamel<Record<string, unknown>>(row);
  const nextRaw = camel['nextTargets'];
  const nextTargets = Array.isArray(nextRaw)
    ? parsePositivePrices(nextRaw as Array<string | number>)
    : [];
  return {
    id: String(camel['id'] ?? ''),
    symbol: String(camel['symbol'] ?? ''),
    stockName: camel['stockName'] as string | undefined,
    isin: camel['isin'] as string | undefined,
    action: String(camel['action'] ?? 'buy'),
    targetPrice: Number(camel['targetPrice'] ?? 0),
    nextTargets,
    cmp: camel['cmp'] == null ? undefined : Number(camel['cmp']),
    cmpSource: camel['cmpSource'] as MarketQuoteSource | undefined,
    cmpFetchedAt: camel['cmpFetchedAt'] == null ? undefined : Number(camel['cmpFetchedAt']),
    notes: camel['notes'] as string | undefined,
    createdAt: Number(camel['createdAt'] ?? 0),
    updatedAt: Number(camel['updatedAt'] ?? 0),
  };
}

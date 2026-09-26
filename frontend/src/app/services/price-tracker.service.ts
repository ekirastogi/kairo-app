import { Injectable, inject } from '@angular/core';
import { Observable, of, switchMap } from 'rxjs';
import { TradeSegment } from '../models/trading-journal.models';
import { AuthService } from './auth.service';
import { MarketQuote, MarketQuoteSource } from './market-quote.service';
import { objectToSnake, rowToCamel, SupabaseService } from './supabase.service';
import {
  TrackerTarget,
  parsePositivePrices,
  parseTrackerTargets,
} from '../utils/price-tracker.utils';

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
  quantity?: number;
  segment?: TradeSegment;
  entryPrice?: number;
  stopLoss?: number;
  targets?: TrackerTarget[];
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
  quantity?: number | null;
  segment?: TradeSegment | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  targets?: TrackerTarget[];
}

@Injectable({ providedIn: 'root' })
export class PriceTrackerService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  watchAll(): Observable<PriceTracker[]> {
    return this.auth.user$.pipe(
      switchMap((user) => {
        if (!user) return of([]);
        return this.supabase.watchTable('price_trackers', () => this.listAll(), 0, 'price_trackers');
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

    const quantity = input.quantity != null && input.quantity > 0 ? input.quantity : null;
    const entryPrice = input.entryPrice != null && input.entryPrice > 0 ? input.entryPrice : null;
    const stopLoss = input.stopLoss != null && input.stopLoss > 0 ? input.stopLoss : null;
    const targets = parseTrackerTargets(input.targets ?? []);
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
      nextTargets: parsePositivePrices(input.nextTargets ?? targets.map((t) => t.price)),
      cmp: input.cmp ?? null,
      cmpSource: input.cmpSource ?? 'screener',
      cmpFetchedAt: input.cmpFetchedAt ?? null,
      notes: input.notes?.trim() ?? '',
      quantity,
      segment: quantity ? (input.segment === 'delivery' ? 'delivery' : 'intraday') : null,
      entryPrice,
      stopLoss,
      targets,
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

function optionalPositive(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function rowToPriceTracker(row: Record<string, unknown>): PriceTracker {
  const camel = rowToCamel<Record<string, unknown>>(row);
  const nextRaw = camel['nextTargets'];
  const nextTargets = Array.isArray(nextRaw)
    ? parsePositivePrices(nextRaw as Array<string | number>)
    : [];
  const targets = parseTrackerTargets(camel['targets']);
  const segment = camel['segment'] === 'delivery' ? 'delivery' : camel['segment'] === 'intraday' ? 'intraday' : undefined;
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
    quantity: optionalPositive(camel['quantity']),
    segment,
    entryPrice: optionalPositive(camel['entryPrice']),
    stopLoss: optionalPositive(camel['stopLoss']),
    targets,
    createdAt: Number(camel['createdAt'] ?? 0),
    updatedAt: Number(camel['updatedAt'] ?? 0),
  };
}

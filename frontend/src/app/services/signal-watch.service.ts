import { Injectable, inject } from '@angular/core';
import { Observable, of, switchMap } from 'rxjs';
import { AuthService } from './auth.service';
import { objectToSnake, rowToCamel, SupabaseService } from './supabase.service';
import { parseBrokerTargets, parsePriceListText, SignalBrokerTarget } from '../utils/signal-watch.utils';

export interface SignalWatch {
  id: string;
  symbol: string;
  name: string;
  isin?: string;
  prices: number[];
  brokerTargets: SignalBrokerTarget[];
  guidanceProfit: string;
  guidanceSales: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

function parsePrices(raw: unknown): number[] {
  if (Array.isArray(raw)) return parsePriceListText(raw.join(','));
  if (typeof raw === 'string') return parsePriceListText(raw);
  return [];
}

function rowToWatch(row: Record<string, unknown>): SignalWatch {
  const camel = rowToCamel<Record<string, unknown>>(row);
  return {
    id: String(camel['id'] ?? ''),
    symbol: String(camel['symbol'] ?? '').toUpperCase(),
    name: String(camel['name'] ?? ''),
    isin: camel['isin'] ? String(camel['isin']) : undefined,
    prices: parsePrices(camel['prices']),
    brokerTargets: parseBrokerTargets(camel['brokerTargets']),
    guidanceProfit: String(camel['guidanceProfit'] ?? ''),
    guidanceSales: String(camel['guidanceSales'] ?? ''),
    sortOrder: Number(camel['sortOrder'] ?? 0),
    createdAt: Number(camel['createdAt'] ?? 0),
    updatedAt: Number(camel['updatedAt'] ?? 0),
  };
}

@Injectable({ providedIn: 'root' })
export class SignalWatchService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  watchAll(): Observable<SignalWatch[]> {
    return this.auth.user$.pipe(
      switchMap((user) => {
        if (!user) return of([]);
        return this.supabase.watchTable('signal_watch', () => this.listAll(), undefined, 'signal_watch');
      })
    );
  }

  async listAll(): Promise<SignalWatch[]> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];
    return this.fetchAll(uid);
  }

  async create(input: {
    symbol: string;
    name: string;
    isin?: string;
    prices?: number[];
  }): Promise<string> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to save signals');
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) throw new Error('Symbol is required');
    const existing = await this.fetchAll(uid);
    const sortOrder = existing.reduce((min, row) => Math.min(min, row.sortOrder), 0) - 1;
    const now = Date.now();
    const id = crypto.randomUUID();
    const { error } = await this.supabase.client.from('signal_watch').insert(
      objectToSnake({
        id,
        userId: uid,
        symbol,
        name: input.name.trim() || symbol,
        isin: input.isin ?? null,
        prices: input.prices ?? [],
        brokerTargets: [],
        guidanceProfit: '',
        guidanceSales: '',
        sortOrder,
        createdAt: now,
        updatedAt: now,
      })
    );
    if (error) {
      if (error.code === '23505') throw new Error(`${symbol} is already on Signals`);
      throw error;
    }
    return id;
  }

  async update(
    id: string,
    patch: Partial<Pick<SignalWatch, 'prices' | 'brokerTargets' | 'guidanceProfit' | 'guidanceSales' | 'name' | 'isin'>>
  ): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to update signals');
    const body: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.prices != null) body['prices'] = patch.prices;
    if (patch.brokerTargets != null) body['brokerTargets'] = patch.brokerTargets;
    if (patch.guidanceProfit != null) body['guidanceProfit'] = patch.guidanceProfit;
    if (patch.guidanceSales != null) body['guidanceSales'] = patch.guidanceSales;
    if (patch.name != null) body['name'] = patch.name;
    if (patch.isin !== undefined) body['isin'] = patch.isin;
    const { error } = await this.supabase.client
      .from('signal_watch')
      .update(objectToSnake(body))
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
  }

  async remove(id: string): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to remove signals');
    const { error } = await this.supabase.client.from('signal_watch').delete().eq('id', id).eq('user_id', uid);
    if (error) throw error;
  }

  private async fetchAll(uid: string): Promise<SignalWatch[]> {
    const { data, error } = await this.supabase.client
      .from('signal_watch')
      .select('*')
      .eq('user_id', uid)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => rowToWatch(row as Record<string, unknown>));
  }
}

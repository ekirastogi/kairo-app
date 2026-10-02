import { Injectable, inject } from '@angular/core';
import { Observable, of, switchMap } from 'rxjs';
import { StockProfile } from '../models/trade.models';
import { Watchlist } from '../models/watchlist.models';
import { AuthService } from './auth.service';
import { objectToSnake, SupabaseService } from './supabase.service';
import { getPnlWatchlistTier, PNL_WATCHLIST_TIERS, symbolsForPnlTier } from '../utils/pnl-watchlist.utils';

const DEFAULT_WATCHLIST_COLOR = '#6366f1';

function rowToWatchlist(row: Record<string, unknown>): Watchlist {
  const id = String(row['id'] ?? '');
  const listType = String(row['list_type'] ?? 'manual') as Watchlist['type'];
  const updatedAt = Number(row['updated_at'] ?? 0);
  const tier = getPnlWatchlistTier(id);
  const symbols = (row['symbols'] as string[]) ?? [];
  return {
    id,
    name: String(row['name'] ?? ''),
    type: listType,
    color: tier?.color ?? DEFAULT_WATCHLIST_COLOR,
    sortOrder: tier?.sortOrder ?? updatedAt,
    stockSymbols: symbols,
    createdAt: updatedAt,
    updatedAt,
  };
}

@Injectable({ providedIn: 'root' })
export class WatchlistService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  watchAll(): Observable<Watchlist[]> {
    return this.auth.user$.pipe(
      switchMap((user) => {
        if (!user) return of([]);
        return this.supabase.watchTable('watchlists', () => this.listAll());
      })
    );
  }

  async listAll(): Promise<Watchlist[]> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];
    const { data, error } = await this.supabase.client
      .from('watchlists')
      .select('id, name, list_type, symbols, updated_at')
      .eq('user_id', uid)
      .order('updated_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => rowToWatchlist(row)).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async listManual(): Promise<Watchlist[]> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];
    const { data, error } = await this.supabase.client
      .from('watchlists')
      .select('id, name, list_type, symbols, updated_at')
      .eq('user_id', uid)
      .eq('list_type', 'manual')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => rowToWatchlist(row));
  }

  async create(watchlist: Omit<Watchlist, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to manage watchlists');
    const now = Date.now();
    const id = crypto.randomUUID();
    const row = objectToSnake({
      id,
      userId: uid,
      name: watchlist.name,
      listType: watchlist.type,
      symbols: watchlist.stockSymbols,
      updatedAt: now,
    });
    const { error } = await this.supabase.client.from('watchlists').insert(row);
    if (error) throw error;
    return id;
  }

  async update(id: string, data: Partial<Watchlist>): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to manage watchlists');
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (data.name !== undefined) patch['name'] = data.name;
    if (data.type !== undefined) patch['listType'] = data.type;
    if (data.stockSymbols !== undefined) patch['symbols'] = data.stockSymbols;
    const { error } = await this.supabase.client
      .from('watchlists')
      .update(objectToSnake(patch))
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
  }

  async remove(id: string): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to manage watchlists');
    const { error } = await this.supabase.client
      .from('watchlists')
      .delete()
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
  }

  async addSymbol(id: string, symbol: string, current: string[]): Promise<void> {
    const sym = symbol.toUpperCase();
    if (current.includes(sym)) return;
    await this.update(id, { stockSymbols: [...current, sym] });
  }

  async removeSymbol(id: string, symbol: string, current: string[]): Promise<void> {
    await this.update(id, {
      stockSymbols: current.filter((s) => s !== symbol.toUpperCase()),
    });
  }

  async syncPnlTierWatchlists(profiles: StockProfile[]): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return;

    const now = Date.now();
    const rows = PNL_WATCHLIST_TIERS.map((tier) => {
      const stockSymbols = symbolsForPnlTier(profiles, tier, 'band');
      return objectToSnake({
        id: tier.id,
        userId: uid,
        name: tier.name,
        listType: 'pnl_derived',
        symbols: stockSymbols,
        updatedAt: now,
      });
    });
    const { error } = await this.supabase.client
      .from('watchlists')
      .upsert(rows, { onConflict: 'user_id,id' });
    if (error) throw error;
  }

  async deleteAllWatchlists(): Promise<number> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return 0;
    const { data, error: selectError } = await this.supabase.client
      .from('watchlists')
      .select('id')
      .eq('user_id', uid);
    if (selectError) throw selectError;
    if (!data?.length) return 0;
    const { error } = await this.supabase.client.from('watchlists').delete().eq('user_id', uid);
    if (error) throw error;
    return data.length;
  }

  async deleteAutoWatchlists(): Promise<void> {
    await this.deleteAllWatchlists();
  }

  isAutoWatchlist(watchlist: Watchlist): boolean {
    return watchlist.type === 'pnl_derived';
  }
}

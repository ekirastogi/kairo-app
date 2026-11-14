import { Injectable, inject } from '@angular/core';
import { Observable, Subject, catchError, from, merge, of, switchMap } from 'rxjs';
import { AuthService } from './auth.service';
import { objectToSnake, rowToCamel, SupabaseService } from './supabase.service';
import {
  OverallSignal,
  parseBrokerTargets,
  parseAiAnalyses,
  parseNewsItems,
  parseOverallSignal,
  parsePriceListText,
  SignalAiAnalysis,
  SignalBrokerTarget,
  SignalNewsItem,
} from '../utils/signal-watch.utils';

function throwDb(error: { message?: string; code?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

export interface SignalWatch {
  id: string;
  symbol: string;
  name: string;
  isin?: string;
  prices: number[];
  brokerTargets: SignalBrokerTarget[];
  news: SignalNewsItem[];
  overallSignal: OverallSignal;
  signalReason: string;
  niftyNote: string;
  sectorNote: string;
  newsUpdatedAt: number;
  aiAnalyses: SignalAiAnalysis[];
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
    news: parseNewsItems(camel['news']),
    overallSignal: parseOverallSignal(camel['overallSignal']),
    signalReason: String(camel['signalReason'] ?? ''),
    niftyNote: String(camel['niftyNote'] ?? ''),
    sectorNote: String(camel['sectorNote'] ?? ''),
    newsUpdatedAt: Number(camel['newsUpdatedAt'] ?? 0),
    aiAnalyses: parseAiAnalyses(camel['aiAnalyses']),
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

  private refresh$ = new Subject<void>();

  watchAll(): Observable<SignalWatch[]> {
    return this.auth.user$.pipe(
      switchMap((user) => {
        if (!user) return of([]);
        return merge(
          this.supabase.watchTable('signal_watch', () => this.listAll(), undefined, 'signal_watch'),
          this.refresh$.pipe(switchMap(() => from(this.listAll()).pipe(catchError(() => of([] as SignalWatch[])))))
        );
      })
    );
  }

  reload(): void {
    this.refresh$.next();
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
  }): Promise<SignalWatch> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to save signals');
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) throw new Error('Symbol is required');
    const existing = await this.fetchAll(uid);
    const sortOrder = existing.reduce((min, row) => Math.min(min, row.sortOrder), 0) - 1;
    const now = Date.now();
    const row: SignalWatch = {
      id: crypto.randomUUID(),
      symbol,
      name: input.name.trim() || symbol,
      isin: input.isin,
      prices: input.prices ?? [],
      brokerTargets: [],
      news: [],
      overallSignal: 'neutral',
      signalReason: '',
      niftyNote: '',
      sectorNote: '',
      newsUpdatedAt: 0,
      aiAnalyses: [],
      guidanceProfit: '',
      guidanceSales: '',
      sortOrder,
      createdAt: now,
      updatedAt: now,
    };
    const { error } = await this.supabase.client.from('signal_watch').insert(
      objectToSnake({
        ...row,
        userId: uid,
        isin: row.isin ?? null,
      })
    );
    if (error) {
      if (error.code === '23505') throw new Error(`${symbol} is already on Signals`);
      throwDb(error, 'Could not add stock');
    }
    this.reload();
    return row;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        SignalWatch,
        | 'prices'
        | 'brokerTargets'
        | 'news'
        | 'overallSignal'
        | 'signalReason'
        | 'niftyNote'
        | 'sectorNote'
        | 'newsUpdatedAt'
        | 'aiAnalyses'
        | 'guidanceProfit'
        | 'guidanceSales'
        | 'name'
        | 'isin'
      >
    >
  ): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to update signals');
    const body: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.prices != null) body['prices'] = patch.prices;
    if (patch.brokerTargets != null) body['brokerTargets'] = patch.brokerTargets;
    if (patch.news != null) body['news'] = patch.news;
    if (patch.overallSignal != null) body['overallSignal'] = patch.overallSignal;
    if (patch.signalReason != null) body['signalReason'] = patch.signalReason;
    if (patch.niftyNote != null) body['niftyNote'] = patch.niftyNote;
    if (patch.sectorNote != null) body['sectorNote'] = patch.sectorNote;
    if (patch.newsUpdatedAt != null) body['newsUpdatedAt'] = patch.newsUpdatedAt;
    if (patch.aiAnalyses != null) body['aiAnalyses'] = patch.aiAnalyses;
    if (patch.guidanceProfit != null) body['guidanceProfit'] = patch.guidanceProfit;
    if (patch.guidanceSales != null) body['guidanceSales'] = patch.guidanceSales;
    if (patch.name != null) body['name'] = patch.name;
    if (patch.isin !== undefined) body['isin'] = patch.isin;
    const { error } = await this.supabase.client
      .from('signal_watch')
      .update(objectToSnake(body))
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throwDb(error, 'Could not update signal');
    this.reload();
  }

  async remove(id: string): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to remove signals');
    const { error } = await this.supabase.client.from('signal_watch').delete().eq('id', id).eq('user_id', uid);
    if (error) throwDb(error, 'Could not remove stock');
    this.reload();
  }

  private async fetchAll(uid: string): Promise<SignalWatch[]> {
    const { data, error } = await this.supabase.client
      .from('signal_watch')
      .select('*')
      .eq('user_id', uid)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throwDb(error, 'Could not load signals');
    return (data ?? []).map((row) => rowToWatch(row as Record<string, unknown>));
  }
}

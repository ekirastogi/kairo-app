import { Injectable, inject } from '@angular/core';
import { Observable, Subject, from, merge, of, shareReplay, switchMap } from 'rxjs';
import { RegistryStock } from '../models/trading-journal.models';
import { normalizeIsin, uniqueByKey } from '../utils/stock-identity.utils';
import { AuthService } from './auth.service';
import { objectToSnake, rowToCamel, rowsToCamel, SupabaseService } from './supabase.service';

const UPSERT_BATCH_LIMIT = 400;
const REGISTRY_SEARCH_COLUMNS = 'symbol, name, isin, exchange, current_price, source, updated_at';

function isMissingColumnError(error: { message?: string; code?: string }, column: string): boolean {
  const message = (error.message ?? '').toLowerCase();
  return (
    error.code === 'PGRST204' ||
    (message.includes(column) && message.includes('does not exist'))
  );
}

export type RegistryStockSource = NonNullable<RegistryStock['source']>;

@Injectable({ providedIn: 'root' })
export class RegistryStockService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  /**
   * One shared registry stream for the whole app. `listAll()` is a fully paginated scan, and
   * this is subscribed from both the trade-plans page and the registry page — without
   * memoizing, each caller got its own scan on mount, on every poll tick and on every
   * realtime event.
   */
  watchAll(): Observable<RegistryStock[]> {
    this.allStream ??= this.auth.user$.pipe(
      switchMap((user) => {
        if (!user) return of([]);
        return merge(
          this.supabase.watchTable('registry_stocks', () => this.listAll()),
          this.refresh$.pipe(switchMap(() => from(this.listAll())))
        );
      }),
      shareReplay({ bufferSize: 1, refCount: false })
    );
    return this.allStream;
  }

  private allStream?: Observable<RegistryStock[]>;
  private refresh$ = new Subject<void>();

  reload(): void {
    this.refresh$.next();
  }

  async getBySymbol(symbol: string): Promise<RegistryStock | null> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) return null;
    const sym = symbol.trim().toUpperCase();
    const { data, error } = await this.supabase.client
      .from('registry_stocks')
      .select('*')
      .eq('user_id', uid)
      .eq('symbol', sym)
      .maybeSingle();
    if (error) throw error;
    return data ? rowToCamel<RegistryStock>(data) : null;
  }

  async listBySymbols(symbols: string[]): Promise<RegistryStock[]> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    if (!uid || !unique.length) return [];
    const out: RegistryStock[] = [];
    const chunkSize = 200;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const { data, error } = await this.supabase.client
        .from('registry_stocks')
        .select('*')
        .eq('user_id', uid)
        .in('symbol', chunk);
      if (error) throw error;
      out.push(...rowsToCamel<RegistryStock>(data ?? []));
    }
    return out;
  }

  async search(query: string, limit = 25): Promise<RegistryStock[]> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    const safe = query.trim().replace(/[%_\\,().]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!uid || !safe) return [];
    const pattern = `"%${safe}%"`;
    const { data, error } = await this.supabase.client
      .from('registry_stocks')
      .select(REGISTRY_SEARCH_COLUMNS)
      .eq('user_id', uid)
      .or(`symbol.ilike.${pattern},name.ilike.${pattern},isin.ilike.${pattern}`)
      .order('symbol', { ascending: true })
      .limit(Math.min(Math.max(limit, 1), 25));
    if (error) throw error;
    return rowsToCamel<RegistryStock>(data ?? []);
  }

  async getByIsin(isin: string): Promise<RegistryStock | null> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    const normalized = normalizeIsin(isin);
    if (!uid || !normalized) return null;
    const { data, error } = await this.supabase.client
      .from('registry_stocks')
      .select('*')
      .eq('user_id', uid)
      .eq('isin', normalized)
      .limit(1);
    if (error) throw error;
    const row = data?.[0];
    return row ? rowToCamel<RegistryStock>(row) : null;
  }

  async listAll(): Promise<RegistryStock[]> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];

    const pageSize = 1000;
    const all: RegistryStock[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await this.supabase.client
        .from('registry_stocks')
        .select('*')
        .eq('user_id', uid)
        .order('symbol', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data?.length) break;
      all.push(...rowsToCamel<RegistryStock>(data));
      if (data.length < pageSize) break;
    }
    return all;
  }

  async count(): Promise<number> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) return 0;
    const { count, error } = await this.supabase.client
      .from('registry_stocks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', uid);
    if (error) throw error;
    return count ?? 0;
  }

  async syncSymbols(
    symbols: Array<{ symbol: string; name?: string; isin?: string }>,
    source: RegistryStockSource = 'pnl_upload'
  ): Promise<number> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) return 0;

    const existing = await this.listAll();
    const byIsin = new Map<string, RegistryStock>();
    const bySymbol = new Map<string, RegistryStock>();
    for (const stock of existing) {
      bySymbol.set(stock.symbol, stock);
      const isin = normalizeIsin(stock.isin);
      if (isin && !byIsin.has(isin)) byIsin.set(isin, stock);
    }

    const now = Date.now();
    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();

    for (const entry of symbols) {
      const isin = normalizeIsin(entry.isin);
      const sym = entry.symbol.toUpperCase().trim();
      if (!sym && !isin) continue;

      if (isin && byIsin.has(isin)) {
        const current = byIsin.get(isin)!;
        if (!normalizeIsin(current.isin)) {
          await this.save({ ...current, isin, source: current.source ?? source });
        }
        continue;
      }

      if (!sym || seen.has(sym)) continue;
      seen.add(sym);

      const already = bySymbol.get(sym);
      if (already) {
        if (isin && !normalizeIsin(already.isin)) {
          await this.save({ ...already, isin, source: already.source ?? source });
          byIsin.set(isin, { ...already, isin });
        }
        continue;
      }

      const rowStock: RegistryStock = {
        symbol: sym,
        name: entry.name ?? sym,
        isin,
        exchange: 'NSE',
        source,
        currentPrice: 0,
        supports: [],
        resistances: [],
        updatedAt: now,
      };
      rows.push(
        objectToSnake({
          userId: uid,
          symbol: sym,
          name: entry.name ?? sym,
          isin,
          exchange: 'NSE',
          source,
          currentPrice: 0,
          supports: [],
          resistances: [],
          notes: '',
          updatedAt: now,
        })
      );
      bySymbol.set(sym, rowStock);
      if (isin) byIsin.set(isin, rowStock);
    }

    if (!rows.length) return 0;
    const uniqueRows = uniqueByKey(
      rows.filter((row) => String(row['symbol'] ?? '').trim()),
      (row) => String(row['symbol'] ?? '').toUpperCase()
    );
    const seenIsin = new Set<string>();
    const insertRows = uniqueRows.filter((row) => {
      const isin = normalizeIsin(String(row['isin'] ?? ''));
      if (!isin) return true;
      if (seenIsin.has(isin)) return false;
      seenIsin.add(isin);
      return true;
    });
    for (let i = 0; i < insertRows.length; i += UPSERT_BATCH_LIMIT) {
      const chunk = insertRows.slice(i, i + UPSERT_BATCH_LIMIT);
      const { error } = await this.supabase.client
        .from('registry_stocks')
        .upsert(chunk, { onConflict: 'user_id,symbol', ignoreDuplicates: true });
      if (error) throw error;
    }
    return rows.length;
  }

  /** Remove registry rows that duplicate the same ISIN (keeps NSE symbol when listed). */
  async dedupeByIsin(): Promise<number> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) return 0;

    const stocks = await this.listAll();
    const stockSymbols = new Set(stocks.map((stock) => stock.symbol));
    const canonicalByIsin = new Map<string, string>();

    for (const stock of stocks) {
      const isin = normalizeIsin(stock.isin);
      if (!isin) continue;
      const existing = canonicalByIsin.get(isin);
      if (!existing || stock.exchange === 'NSE') {
        canonicalByIsin.set(isin, stock.symbol);
      }
    }

    const symbolsToRemove = new Set<string>();
    for (const stock of stocks) {
      const isin = normalizeIsin(stock.isin);
      if (!isin) continue;
      const canonical = canonicalByIsin.get(isin);
      if (!canonical || canonical === stock.symbol || !stockSymbols.has(canonical)) continue;
      if (stockSymbols.has(stock.symbol) && stock.symbol !== canonical) {
        symbolsToRemove.add(stock.symbol);
      }
    }

    for (const symbol of symbolsToRemove) {
      await this.remove(symbol);
    }
    return symbolsToRemove.size;
  }

  /**
   * Copy CMP, market cap, P/E, and indicators from the worker `stocks` table
   * (populated by Groww ingest) into the user's registry rows.
   */
  async enrichFromMarketData(): Promise<{ updated: number; pending: number }> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to refresh market data');

    const registry = await this.listAll();
    if (!registry.length) return { updated: 0, pending: 0 };

    const bySymbol = new Map(registry.map((stock) => [stock.symbol, stock]));
    const symbols = [...bySymbol.keys()];
    const isins = [...new Set(registry.map((stock) => normalizeIsin(stock.isin)).filter(Boolean))];
    const marketBySymbol = new Map<string, Record<string, unknown>>();
    const marketByIsin = new Map<string, Record<string, unknown>>();
    const chunkSize = 200;

    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      const { data, error } = await this.supabase.client.from('stocks').select('*').in('symbol', chunk);
      if (error) throw error;
      for (const row of data ?? []) {
        const camel = rowToCamel<Record<string, unknown>>(row);
        marketBySymbol.set(String(camel['symbol'] ?? '').toUpperCase(), camel);
        const isin = normalizeIsin(String(camel['isin'] ?? ''));
        if (isin) marketByIsin.set(isin, camel);
      }
    }

    for (let i = 0; i < isins.length; i += chunkSize) {
      const chunk = isins.slice(i, i + chunkSize);
      const { data, error } = await this.supabase.client.from('stocks').select('*').in('isin', chunk);
      if (error) {
        if (isMissingColumnError(error, 'isin')) break;
        throw error;
      }
      for (const row of data ?? []) {
        const camel = rowToCamel<Record<string, unknown>>(row);
        const isin = normalizeIsin(String(camel['isin'] ?? ''));
        if (isin) marketByIsin.set(isin, camel);
      }
    }

    let updated = 0;

    for (const stock of registry) {
      const market = marketByIsin.get(normalizeIsin(stock.isin)) ?? marketBySymbol.get(stock.symbol);
      if (!market) continue;

      const ltp = Number(market['ltp'] ?? 0);
      const marketCap = Number(market['marketCap'] ?? 0);
      const pe = Number(market['pe'] ?? 0);
      const indicators = (market['indicators'] as Record<string, number> | undefined) ?? {};
      const supports = ((market['supportLevels'] as number[]) ?? []).filter((v) => v > 0).slice(0, 3);
      const resistances = ((market['resistanceLevels'] as number[]) ?? []).filter((v) => v > 0).slice(0, 3);

      const hasData =
        ltp > 0 ||
        marketCap > 0 ||
        pe > 0 ||
        indicators['rsi'] != null ||
        supports.length > 0 ||
        resistances.length > 0;
      if (!hasData) continue;

      await this.save({
        ...stock,
        name: String(market['name'] ?? stock.name),
        currentPrice: ltp > 0 ? ltp : stock.currentPrice,
        marketCap: marketCap > 0 ? marketCap : stock.marketCap,
        pe: pe > 0 ? pe : stock.pe,
        rsi: indicators['rsi'] ?? stock.rsi,
        macd: indicators['macd'] ?? stock.macd,
        macdHist: indicators['macdHist'] ?? stock.macdHist,
        macdSignal: indicators['macdSignal'] ?? stock.macdSignal,
        sma20: indicators['sma20'] ?? stock.sma20,
        sma50: indicators['sma50'] ?? stock.sma50,
        supports: supports.length ? supports : stock.supports,
        resistances: resistances.length ? resistances : stock.resistances,
      });
      updated++;
    }

    return { updated, pending: registry.length - updated };
  }

  async save(stock: Omit<RegistryStock, 'updatedAt'>): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to save stocks');
    const symbol = stock.symbol.trim().toUpperCase();
    if (!symbol) throw new Error('Symbol is required');

    const row = objectToSnake({
      userId: uid,
      symbol,
      name: stock.name.trim() || symbol,
      isin: normalizeIsin(stock.isin),
      exchange: stock.exchange ?? 'NSE',
      source: stock.source ?? 'manual',
      currentPrice: stock.currentPrice ?? 0,
      marketCap: stock.marketCap,
      pe: stock.pe,
      rsi: stock.rsi,
      macd: stock.macd,
      macdHist: stock.macdHist,
      macdSignal: stock.macdSignal,
      sma20: stock.sma20,
      sma50: stock.sma50,
      supports: (stock.supports ?? []).slice(0, 3).map(Number),
      resistances: (stock.resistances ?? []).slice(0, 3).map(Number),
      notes: stock.notes ?? '',
      bookValue: stock.bookValue,
      dividendYield: stock.dividendYield,
      roce: stock.roce,
      roe: stock.roe,
      faceValue: stock.faceValue,
      highLow: stock.highLow,
      salesGrowth3y: stock.salesGrowth3y,
      salesGrowth5y: stock.salesGrowth5y,
      salesGrowth10y: stock.salesGrowth10y,
      salesGrowthTtm: stock.salesGrowthTtm,
      profitGrowth3y: stock.profitGrowth3y,
      profitGrowth5y: stock.profitGrowth5y,
      profitGrowth10y: stock.profitGrowth10y,
      profitGrowthTtm: stock.profitGrowthTtm,
      stockCagr1y: stock.stockCagr1y,
      stockCagr3y: stock.stockCagr3y,
      stockCagr5y: stock.stockCagr5y,
      stockCagr10y: stock.stockCagr10y,
      promoterHolding: stock.promoterHolding,
      fiiHolding: stock.fiiHolding,
      diiHolding: stock.diiHolding,
      publicHolding: stock.publicHolding,
      governmentHolding: stock.governmentHolding,
      otherHolding: stock.otherHolding,
      quarterlyResults: stock.quarterlyResults ?? {},
      profitLoss: stock.profitLoss ?? {},
      balanceSheet: stock.balanceSheet ?? {},
      cashFlow: stock.cashFlow ?? {},
      shareholding: stock.shareholding ?? {},
      screenerUrl: stock.screenerUrl,
      screenerFetchedAt: stock.screenerFetchedAt,
      updatedAt: Date.now(),
    });
    const { error } = await this.supabase.client
      .from('registry_stocks')
      .upsert(row, { onConflict: 'user_id,symbol' });
    if (error) {
      throw new Error(error.message || 'Failed to save registry stock');
    }
  }

  async ensureListed(symbol: string, extras?: Partial<RegistryStock>): Promise<RegistryStock> {
    const isin = normalizeIsin(extras?.isin);
    const existingByIsin = isin ? await this.getByIsin(isin) : null;
    if (existingByIsin) return existingByIsin;
    const existing = await this.getBySymbol(symbol);
    if (existing) {
      if (isin && !normalizeIsin(existing.isin)) {
        const updated = { ...existing, isin };
        await this.save(updated);
        return updated;
      }
      return existing;
    }
    const sym = symbol.trim().toUpperCase();
    const stock: RegistryStock = {
      symbol: sym,
      name: extras?.name?.trim() || sym,
      isin,
      currentPrice: extras?.currentPrice ?? 0,
      exchange: extras?.exchange ?? 'NSE',
      source: extras?.source ?? 'manual',
      supports: extras?.supports ?? [],
      resistances: extras?.resistances ?? [],
      updatedAt: Date.now(),
    };
    await this.save(stock);
    return stock;
  }

  async remove(symbol: string): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to delete stocks');
    const { error } = await this.supabase.client
      .from('registry_stocks')
      .delete()
      .eq('user_id', uid)
      .eq('symbol', symbol.toUpperCase());
    if (error) throw error;
  }

  async deleteAll(): Promise<number> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return 0;
    const { count, error: countError } = await this.supabase.client
      .from('registry_stocks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', uid);
    if (countError) throw countError;
    const { error } = await this.supabase.client.from('registry_stocks').delete().eq('user_id', uid);
    if (error) throw error;
    return count ?? 0;
  }
}

import { Injectable, computed, inject, signal } from '@angular/core';
import { StockSummary } from '../models/trade.models';
import { Watchlist } from '../models/watchlist.models';
import { LazyTradeLoaderService } from './lazy-trade-loader.service';
import { WatchlistService } from './watchlist.service';

const SELECTED_ID_KEY = 'kairo.dashboard.customListId';
const DEFAULT_ID_KEY = 'kairo.dashboard.customListDefaultId';

@Injectable({ providedIn: 'root' })
export class CustomStockListService {
  private watchlists = inject(WatchlistService);
  private lazyTrades = inject(LazyTradeLoaderService);

  readonly lists = signal<Watchlist[]>([]);
  readonly listsLoading = signal(false);
  readonly defaultListId = signal<string | null>(this.readDefaultId());
  readonly selectedListId = signal<string | null>(this.readDefaultId() ?? this.readStoredId());
  readonly error = signal<string | null>(null);

  private loaded = false;
  private inFlight: Promise<Watchlist[]> | null = null;
  private readonly stockViewCache = new Map<string, StockSummary[]>();

  readonly selectedList = computed(() => {
    const id = this.selectedListId();
    if (!id) return null;
    return this.lists().find((list) => list.id === id) ?? null;
  });

  readonly defaultList = computed(() => {
    const id = this.defaultListId();
    if (!id) return null;
    return this.lists().find((list) => list.id === id) ?? null;
  });

  async ensureLoaded(): Promise<Watchlist[]> {
    if (this.loaded) return this.lists();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.reload();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async reload(): Promise<Watchlist[]> {
    this.listsLoading.set(true);
    this.error.set(null);
    try {
      const lists = await this.watchlists.listManual();
      this.lists.set(lists);
      this.loaded = true;
      this.stockViewCache.clear();
      this.ensureSelection(lists);
      return lists;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not load custom lists');
      return this.lists();
    } finally {
      this.listsLoading.set(false);
    }
  }

  select(id: string | null): void {
    this.selectedListId.set(id);
    this.storeId(id);
  }

  isDefault(id: string | null | undefined): boolean {
    return !!id && this.defaultListId() === id;
  }

  setDefault(id: string | null): void {
    this.defaultListId.set(id);
    this.storeDefaultId(id);
  }

  stocksForList(list: Watchlist, universe: StockSummary[]): StockSummary[] {
    const fingerprint = `${list.id}|${list.updatedAt}|${universe.length}|${this.universeFingerprint(universe)}`;
    const cached = this.stockViewCache.get(fingerprint);
    if (cached) return cached;

    const symbols = new Set(list.stockSymbols.map((symbol) => symbol.toUpperCase()));
    const rows = universe.filter((stock) => symbols.has(this.lazyTrades.stockSymbol(stock)));
    for (const key of [...this.stockViewCache.keys()]) {
      if (key.startsWith(`${list.id}|`) && key !== fingerprint) this.stockViewCache.delete(key);
    }
    this.stockViewCache.set(fingerprint, rows);
    return rows;
  }

  async create(name: string, symbols: string[], options?: { isDefault?: boolean }): Promise<string> {
    const id = await this.watchlists.create({
      name: name.trim(),
      type: 'manual',
      color: '#6366f1',
      sortOrder: Date.now(),
      stockSymbols: this.normalizeSymbols(symbols),
    });
    this.applyDefaultFlag(id, options?.isDefault === true);
    this.loaded = false;
    await this.reload();
    this.select(id);
    return id;
  }

  async update(id: string, name: string, symbols: string[], options?: { isDefault?: boolean }): Promise<void> {
    await this.watchlists.update(id, {
      name: name.trim(),
      stockSymbols: this.normalizeSymbols(symbols),
    });
    this.applyDefaultFlag(id, options?.isDefault === true);
    this.loaded = false;
    await this.reload();
    this.select(id);
  }

  async remove(id: string): Promise<void> {
    if (this.isDefault(id)) this.setDefault(null);
    await this.watchlists.remove(id);
    this.loaded = false;
    const lists = await this.reload();
    if (this.selectedListId() === id) {
      this.select(this.pickFallbackId(lists));
    }
  }

  async getById(id: string): Promise<Watchlist | null> {
    const lists = await this.ensureLoaded();
    return lists.find((list) => list.id === id) ?? null;
  }

  private ensureSelection(lists: Watchlist[]): void {
    const current = this.selectedListId();
    if (current && lists.some((list) => list.id === current)) return;
    this.select(this.pickFallbackId(lists));
  }

  private pickFallbackId(lists: Watchlist[]): string | null {
    const defaultId = this.defaultListId();
    if (defaultId && lists.some((list) => list.id === defaultId)) return defaultId;
    return lists[0]?.id ?? null;
  }

  private applyDefaultFlag(id: string, makeDefault: boolean): void {
    if (makeDefault) {
      this.setDefault(id);
      return;
    }
    if (this.isDefault(id)) this.setDefault(null);
  }

  private universeFingerprint(universe: StockSummary[]): string {
    let net = 0;
    let trades = 0;
    for (const stock of universe) {
      net += stock.netPnL;
      trades += stock.tradeCount;
    }
    return `${net.toFixed(2)}:${trades}`;
  }

  private normalizeSymbols(symbols: string[]): string[] {
    return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  }

  private readStoredId(): string | null {
    return this.readStorage(SELECTED_ID_KEY);
  }

  private storeId(id: string | null): void {
    this.writeStorage(SELECTED_ID_KEY, id);
  }

  private readDefaultId(): string | null {
    return this.readStorage(DEFAULT_ID_KEY);
  }

  private storeDefaultId(id: string | null): void {
    this.writeStorage(DEFAULT_ID_KEY, id);
  }

  private readStorage(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeStorage(key: string, id: string | null): void {
    try {
      if (id) localStorage.setItem(key, id);
      else localStorage.removeItem(key);
    } catch {
      /* ignore quota / private mode */
    }
  }
}

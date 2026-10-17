import { Injectable, Injector, inject, signal } from '@angular/core';
import { AnalysisOptions, Report } from '../models/trade.models';
import { AnalysisService } from './analysis.service';
import { FilteredStockService } from './filtered-stock.service';
import { LazyTradeLoaderService } from './lazy-trade-loader.service';
import { ReportStateService } from './report-state.service';

/** Stable home / Performance page id used by analytics and the refresh button. */
export const ANALYTICS_PAGE_ID = 'analytics';

interface TabCacheBucket {
  filterKey: string;
  values: Map<string, unknown>;
}

/**
 * In-memory UI cache scoped by page → tab → filter fingerprint.
 * Values are filled only when a tab is visited (getOrSet / markVisited).
 * Cleared on date/type changes, new uploads, or the page refresh button.
 *
 * Sibling services are resolved via Injector so ReportStateService can call
 * invalidate without a constructor-level circular dependency.
 */
@Injectable({ providedIn: 'root' })
export class UiPageCacheService {
  private readonly store = new Map<string, Map<string, TabCacheBucket>>();
  private readonly _revision = signal(0);
  private readonly _pageRevision = signal<Record<string, number>>({});
  private readonly _refreshing = signal<string | null>(null);
  private readonly injector = inject(Injector);

  /** Bumps whenever any page cache is cleared — components can depend on this. */
  readonly revision = this._revision.asReadonly();
  /** Page id currently being force-refreshed, if any. */
  readonly refreshing = this._refreshing.asReadonly();

  pageRevision(pageId: string): number {
    return this._pageRevision()[pageId] ?? 0;
  }

  /** Fingerprint of the active date / trade-type window (and optional report identity). */
  filterKey(
    opts: AnalysisOptions,
    report?: Pick<Report, 'summary' | 'dateRange' | 'totalTradeCount' | 'trades' | 'stockSummary'> | null
  ): string {
    const types = [...(opts.tradeTypes ?? ['all'])].map(String).sort().join(',');
    const reportPart = report
      ? [
          report.summary?.clientCode ?? '',
          report.summary?.realisedPnL ?? '',
          report.dateRange?.min ?? '',
          report.dateRange?.max ?? '',
          report.totalTradeCount ?? report.trades?.length ?? 0,
          report.stockSummary?.length ?? 0,
        ].join('|')
      : '';
    return [opts.startDate ?? '', opts.endDate ?? '', types, reportPart].join('::');
  }

  currentFilterKey(): string {
    const state = this.injector.get(ReportStateService);
    return this.filterKey(state.analysisOptions(), state.report());
  }

  /** True when this tab was already visited for the current filter window. */
  hasVisited(pageId: string, tabId: string, filterKey?: string): boolean {
    const key = filterKey ?? this.currentFilterKey();
    const bucket = this.store.get(pageId)?.get(tabId);
    return !!bucket && bucket.filterKey === key;
  }

  /** Record that the user opened this tab under the current filters (no payload yet). */
  markVisited(pageId: string, tabId: string, filterKey?: string): void {
    this.ensureBucket(pageId, tabId, filterKey ?? this.currentFilterKey());
  }

  get<T>(pageId: string, tabId: string, slot: string, filterKey?: string): T | undefined {
    const key = filterKey ?? this.currentFilterKey();
    const bucket = this.store.get(pageId)?.get(tabId);
    if (!bucket || bucket.filterKey !== key) return undefined;
    return bucket.values.get(slot) as T | undefined;
  }

  set<T>(
    pageId: string,
    tabId: string,
    slot: string,
    value: T,
    filterKey?: string
  ): void {
    const bucket = this.ensureBucket(pageId, tabId, filterKey ?? this.currentFilterKey());
    bucket.values.set(slot, value);
  }

  /**
   * Return a cached value for this page/tab/slot, or compute and store it on first visit.
   * Only runs `factory` when the slot is missing for the current filter key.
   */
  getOrSet<T>(
    pageId: string,
    tabId: string,
    slot: string,
    factory: () => T,
    filterKey?: string
  ): T {
    const key = filterKey ?? this.currentFilterKey();
    const hit = this.get<T>(pageId, tabId, slot, key);
    if (hit !== undefined) return hit;
    const value = factory();
    this.set(pageId, tabId, slot, value, key);
    return value;
  }

  /** Drop all cached tabs for one page (e.g. analytics). */
  invalidatePage(pageId: string): void {
    this.store.delete(pageId);
    this._pageRevision.update((map) => ({ ...map, [pageId]: (map[pageId] ?? 0) + 1 }));
    this._revision.update((v) => v + 1);
  }

  /** Drop every page cache (upload / logout). */
  invalidateAll(): void {
    this.store.clear();
    this._pageRevision.set({});
    this._revision.update((v) => v + 1);
  }

  /**
   * Clear this page’s UI cache, analysis memo, lazy trades, and filtered-stock query,
   * then reload the report from the backend.
   */
  async refreshPage(pageId: string): Promise<void> {
    if (this._refreshing()) return;
    this._refreshing.set(pageId);
    try {
      this.invalidatePage(pageId);
      this.injector.get(AnalysisService).clearCache();
      this.injector.get(LazyTradeLoaderService).clear();
      this.injector.get(FilteredStockService).invalidate();
      const state = this.injector.get(ReportStateService);
      state.clearFirebaseReportSessionCache();
      await state.ensureLoadedFromFirebase(true);
    } finally {
      this._refreshing.set(null);
    }
  }

  private ensureBucket(pageId: string, tabId: string, filterKey: string): TabCacheBucket {
    let pageMap = this.store.get(pageId);
    if (!pageMap) {
      pageMap = new Map();
      this.store.set(pageId, pageMap);
    }
    let bucket = pageMap.get(tabId);
    if (!bucket || bucket.filterKey !== filterKey) {
      bucket = { filterKey, values: new Map() };
      pageMap.set(tabId, bucket);
    }
    return bucket;
  }
}

import { Injectable, inject, effect, untracked } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs/operators';
import { ReportStateService } from './report-state.service';
import { TradeType } from '../models/trade.models';
import {
  FILTER_QUERY_KEYS,
  defaultTradeTypesForRoute,
  readGlobalFilters,
  serializeTradeTypes,
} from '../utils/filter-url.utils';
import { routeNeedsDefaultTypes, typesParamIsStaleIntradayDefault } from '../utils/trade-type-filter.utils';
import {
  defaultDateRangeForRoute,
  routeNeedsDefaultDateRange,
} from '../utils/date-range-preset.utils';

/**
 * Keeps filter state and the URL in sync.
 *
 * User filter intent is authoritative. Report refreshes must not re-drive URL→state
 * sync (that was resetting MTD/Last and watchlist bands every ~60s).
 */
@Injectable({ providedIn: 'root' })
export class FilterUrlService {
  private router = inject(Router);
  private state = inject(ReportStateService);
  private started = false;
  /** True while we are writing the URL so NavigationEnd does not echo back into state. */
  private writingUrl = false;
  private pendingPatch: Record<string, string | null> | null = null;
  private flushQueued = false;
  /** Only re-sync from URL when the loaded client changes (first report / account switch). */
  private lastSyncedClient: string | null = null;

  constructor() {
    effect(() => {
      const report = this.state.report();
      if (!this.started || !report) return;
      const clientCode = report.summary.clientCode;
      untracked(() => {
        if (this.lastSyncedClient === clientCode) return;
        this.lastSyncedClient = clientCode;
        this.syncFromUrl();
      });
    });
  }

  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => {
        if (!this.writingUrl) this.syncFromUrl();
      });
    this.syncFromUrl();
  }

  syncFromUrl(): void {
    if (this.writingUrl) return;

    const path = this.router.url.split('?')[0];
    const paramMap = this.router.routerState.snapshot.root.queryParamMap;
    const defaults = defaultTradeTypesForRoute(path);
    const report = this.state.report();

    const typesParam = paramMap.get(FILTER_QUERY_KEYS.types);
    const needsDefaultTypes =
      routeNeedsDefaultTypes(path, paramMap.has(FILTER_QUERY_KEYS.types)) ||
      typesParamIsStaleIntradayDefault(path, typesParam);
    const needsDefaultDateRange =
      !!report &&
      routeNeedsDefaultDateRange(
        path,
        paramMap.has(FILTER_QUERY_KEYS.from),
        paramMap.has(FILTER_QUERY_KEYS.to)
      );

    const bounds =
      report?.dateRange?.min && report.dateRange.max
        ? { min: report.dateRange.min, max: report.dateRange.max }
        : null;
    const dateDefaults =
      needsDefaultDateRange && bounds ? defaultDateRangeForRoute(path, bounds) : null;

    if (report && bounds) {
      const parsed = readGlobalFilters(paramMap, defaults);
      // Prefer URL → else keep the user's current in-memory range → else full report.
      const start =
        (dateDefaults?.start ?? parsed.startDate ?? this.state.startDate()) || bounds.min;
      const end =
        (dateDefaults?.end ?? parsed.endDate ?? this.state.endDate()) || bounds.max;
      this.applyParsedFilters(
        {
          ...parsed,
          tradeTypes: needsDefaultTypes ? defaults : parsed.tradeTypes,
          startDate: start,
          endDate: end,
        },
        bounds.min,
        bounds.max
      );
    }

    // Do not invent watchlist `bands=band` when missing — absence means leave local
    // tier mode alone (Cumulative used to clear the param and get overwritten here).
    if (needsDefaultTypes || dateDefaults) {
      const patch: Record<string, string | null> = {};
      if (needsDefaultTypes) {
        patch[FILTER_QUERY_KEYS.types] = serializeTradeTypes(defaults);
      }
      if (dateDefaults) {
        patch[FILTER_QUERY_KEYS.from] = dateDefaults.start;
        patch[FILTER_QUERY_KEYS.to] = dateDefaults.end;
      }
      this.replaceQuery(patch, true);
    }
  }

  updateTradeTypes(types: TradeType[]): void {
    const report = this.state.report();
    if (!report) return;
    this.state.applyFilters(this.state.startDate(), this.state.endDate(), types);
    this.replaceQuery({ [FILTER_QUERY_KEYS.types]: serializeTradeTypes(types) });
  }

  updateDateRange(
    start: string,
    end: string,
    types: TradeType[],
    chartPeriod?: 'daily' | 'weekly' | 'monthly',
    topStocks?: number
  ): void {
    const report = this.state.report();
    if (!report) return;
    this.state.applyFilters(start, end, types, chartPeriod, topStocks);
    this.replaceQuery({
      [FILTER_QUERY_KEYS.from]: start,
      [FILTER_QUERY_KEYS.to]: end,
      [FILTER_QUERY_KEYS.types]: serializeTradeTypes(types),
      [FILTER_QUERY_KEYS.chart]: chartPeriod && chartPeriod !== 'daily' ? chartPeriod : null,
      [FILTER_QUERY_KEYS.top]: topStocks && topStocks !== 10 ? String(topStocks) : null,
    });
  }

  resetFilters(): void {
    const report = this.state.report();
    if (!report?.dateRange?.min || !report.dateRange.max) return;
    const path = this.router.url.split('?')[0];
    const defaults = defaultTradeTypesForRoute(path);
    const bounds = { min: report.dateRange.min, max: report.dateRange.max };
    const dateDefaults = defaultDateRangeForRoute(path, bounds);
    const start = dateDefaults?.start ?? bounds.min;
    const end = dateDefaults?.end ?? bounds.max;
    this.state.applyFilters(start, end, defaults);
    this.replaceQuery({
      [FILTER_QUERY_KEYS.types]: serializeTradeTypes(defaults),
      [FILTER_QUERY_KEYS.from]: start,
      [FILTER_QUERY_KEYS.to]: end,
      [FILTER_QUERY_KEYS.chart]: null,
      [FILTER_QUERY_KEYS.top]: null,
    });
  }

  patchWatchlistQuery(patch: Record<string, string | null>): void {
    this.replaceQuery(patch);
  }

  private applyParsedFilters(
    parsed: ReturnType<typeof readGlobalFilters>,
    minDate: string,
    maxDate: string
  ): void {
    this.state.applyFilters(
      parsed.startDate ?? minDate,
      parsed.endDate ?? maxDate,
      parsed.tradeTypes,
      parsed.chartPeriod,
      parsed.topStocks,
      { syncUrl: false }
    );
  }

  /**
   * Merge concurrent URL patches into one navigate so date writes are not
   * clobbered by a overlapping bands/types patch reading a stale router.url.
   */
  private replaceQuery(patch: Record<string, string | null>, replaceUrl = false): void {
    this.pendingPatch = { ...(this.pendingPatch ?? {}), ...patch };
    this.writingUrl = true;
    void this.flushQueryQueue(replaceUrl);
  }

  private async flushQueryQueue(replaceUrl: boolean): Promise<void> {
    if (this.flushQueued) return;
    this.flushQueued = true;
    try {
      while (this.pendingPatch) {
        const patch = this.pendingPatch;
        this.pendingPatch = null;
        const tree = this.router.parseUrl(this.router.url);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === '') {
            delete tree.queryParams[key];
          } else {
            tree.queryParams[key] = value;
          }
        }
        await this.router.navigateByUrl(tree, { replaceUrl });
      }
    } finally {
      this.flushQueued = false;
      this.writingUrl = !!this.pendingPatch;
      if (this.pendingPatch) {
        void this.flushQueryQueue(replaceUrl);
      }
    }
  }
}

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
  DateRangePresetId,
  defaultDateRangeForRoute,
  detectDateRangePreset,
  periodUrlFromPreset,
  presetFromPeriodUrl,
  rangeForPreset,
  routeNeedsDefaultDateRange,
} from '../utils/date-range-preset.utils';

/**
 * Keeps filter state and the URL in sync.
 * User filter intent (`period`, dates, types) is authoritative — never invent Last/MTD.
 */
@Injectable({ providedIn: 'root' })
export class FilterUrlService {
  private router = inject(Router);
  private state = inject(ReportStateService);
  private started = false;
  private writingUrl = false;
  private pendingPatch: Record<string, string | null> | null = null;
  private flushQueued = false;
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

    const hasPeriod = paramMap.has(FILTER_QUERY_KEYS.period);
    const hasFrom = paramMap.has(FILTER_QUERY_KEYS.from);
    const hasTo = paramMap.has(FILTER_QUERY_KEYS.to);
    const needsDefaultDateRange =
      !!report && routeNeedsDefaultDateRange(path, hasFrom, hasTo) && !hasPeriod;

    const bounds =
      report?.dateRange?.min && report.dateRange.max
        ? { min: report.dateRange.min, max: report.dateRange.max }
        : null;

    // Seed All into the URL when the user has never chosen a period (watchlists/dashboard).
    const needsSeedAllPeriod =
      !!report &&
      !!bounds &&
      !hasPeriod &&
      !hasFrom &&
      !hasTo &&
      !needsDefaultDateRange;

    const analyticsDefaults =
      needsDefaultDateRange && bounds ? defaultDateRangeForRoute(path, bounds) : null;

    if (report && bounds) {
      const parsed = readGlobalFilters(paramMap, defaults);
      const urlPreset = presetFromPeriodUrl(parsed.period);
      let datePeriod: DateRangePresetId | 'custom' =
        urlPreset ?? (needsSeedAllPeriod ? 'inception' : this.state.datePeriod() || 'inception');
      let start = parsed.startDate ?? this.state.startDate() ?? bounds.min;
      let end = parsed.endDate ?? this.state.endDate() ?? bounds.max;

      if (urlPreset && urlPreset !== 'custom') {
        const range = rangeForPreset(urlPreset, bounds);
        start = range.start;
        end = range.end;
        datePeriod = urlPreset;
      } else if (analyticsDefaults) {
        start = analyticsDefaults.start;
        end = analyticsDefaults.end;
        datePeriod = 'year';
      } else if (needsSeedAllPeriod) {
        start = bounds.min;
        end = bounds.max;
        datePeriod = 'inception';
      } else if (!urlPreset && parsed.startDate && parsed.endDate) {
        // Legacy URLs without `period` — infer once, then write period so it sticks.
        datePeriod = detectDateRangePreset(parsed.startDate, parsed.endDate, bounds);
        start = parsed.startDate;
        end = parsed.endDate;
      }

      this.state.applyFilters(
        start,
        end,
        needsDefaultTypes ? defaults : parsed.tradeTypes,
        parsed.chartPeriod,
        parsed.topStocks,
        { syncUrl: false, datePeriod }
      );
    }

    const patch: Record<string, string | null> = {};
    if (needsDefaultTypes) {
      patch[FILTER_QUERY_KEYS.types] = serializeTradeTypes(defaults);
    }
    if (analyticsDefaults) {
      patch[FILTER_QUERY_KEYS.period] = periodUrlFromPreset('year');
      patch[FILTER_QUERY_KEYS.from] = analyticsDefaults.start;
      patch[FILTER_QUERY_KEYS.to] = analyticsDefaults.end;
    } else if (needsSeedAllPeriod && bounds) {
      patch[FILTER_QUERY_KEYS.period] = periodUrlFromPreset('inception');
      patch[FILTER_QUERY_KEYS.from] = bounds.min;
      patch[FILTER_QUERY_KEYS.to] = bounds.max;
    } else if (
      report &&
      bounds &&
      !hasPeriod &&
      hasFrom &&
      hasTo
    ) {
      // Backfill `period` onto legacy URLs so All/MTD/Last stop flipping.
      const inferred = detectDateRangePreset(
        paramMap.get(FILTER_QUERY_KEYS.from) || bounds.min,
        paramMap.get(FILTER_QUERY_KEYS.to) || bounds.max,
        bounds
      );
      patch[FILTER_QUERY_KEYS.period] = periodUrlFromPreset(inferred);
    }
    if (Object.keys(patch).length) {
      this.replaceQuery(patch, true);
    }
  }

  updateTradeTypes(types: TradeType[]): void {
    const report = this.state.report();
    if (!report) return;
    this.state.applyFilters(this.state.startDate(), this.state.endDate(), types, undefined, undefined, {
      datePeriod: this.state.datePeriod(),
    });
    this.replaceQuery({ [FILTER_QUERY_KEYS.types]: serializeTradeTypes(types) });
  }

  updateDateRange(
    start: string,
    end: string,
    types: TradeType[],
    chartPeriod?: 'daily' | 'weekly' | 'monthly',
    topStocks?: number,
    datePeriod?: DateRangePresetId | 'custom'
  ): void {
    const report = this.state.report();
    if (!report) return;
    const period = datePeriod ?? this.state.datePeriod();
    this.state.applyFilters(start, end, types, chartPeriod, topStocks, { datePeriod: period });
    this.replaceQuery({
      [FILTER_QUERY_KEYS.period]: periodUrlFromPreset(period),
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
    const period: DateRangePresetId = dateDefaults ? 'year' : 'inception';
    const range = dateDefaults ?? rangeForPreset('inception', bounds);
    this.state.applyFilters(range.start, range.end, defaults, undefined, undefined, {
      datePeriod: period,
    });
    this.replaceQuery({
      [FILTER_QUERY_KEYS.types]: serializeTradeTypes(defaults),
      [FILTER_QUERY_KEYS.period]: periodUrlFromPreset(period),
      [FILTER_QUERY_KEYS.from]: range.start,
      [FILTER_QUERY_KEYS.to]: range.end,
      [FILTER_QUERY_KEYS.chart]: null,
      [FILTER_QUERY_KEYS.top]: null,
    });
  }

  patchWatchlistQuery(patch: Record<string, string | null>): void {
    this.replaceQuery(patch);
  }

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

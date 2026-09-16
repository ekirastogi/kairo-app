import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ReportStateService } from './report-state.service';
import { TradeLedgerService } from './trade-ledger.service';
import { StockSummary } from '../models/trade.models';
import {
  filterProfilesToSummaries,
  isFullReportDateRange,
  mergeStockSummaries,
  profilesHaveTypeBreakdown,
} from '../utils/filter-stock-profiles.utils';

@Injectable({ providedIn: 'root' })
export class FilteredStockService {
  private state = inject(ReportStateService);
  private ledger = inject(TradeLedgerService);

  private dateFiltered = signal<StockSummary[]>([]);
  loading = signal(false);
  /** Set when the last filtered load failed, so pages can distinguish an outage from no data. */
  error = signal<string | null>(null);
  private loadSeq = 0;
  private lastQueryKey = '';

  /**
   * Filtered stock list.
   * Type filters use persisted per-type aggregates on stock profiles (no trade re-fetch).
   * Date narrowing falls back to a one-time trade query.
   */
  stocks = computed((): StockSummary[] => {
    const report = this.state.report();
    const opts = this.state.analysisOptions();
    if (!report) return [];

    // When individual trades are in memory, use the same filtered aggregates as dashboard/analytics.
    if (report.trades.length > 0) {
      return mergeStockSummaries(this.state.analysis()?.stocks ?? []);
    }

    const profiles = report.stockProfiles ?? [];
    const canUseProfiles =
      !!report.dateRange &&
      profiles.length > 0 &&
      profilesHaveTypeBreakdown(profiles) &&
      isFullReportDateRange(report.dateRange, opts);

    if (canUseProfiles) {
      return filterProfilesToSummaries(profiles, opts);
    }

    if (report.dateRange && !isFullReportDateRange(report.dateRange, opts)) {
      return mergeStockSummaries(this.dateFiltered());
    }

    return mergeStockSummaries(report.stockSummary ?? []);
  });

  constructor() {
    effect(() => {
      const report = this.state.report();
      const opts = this.state.analysisOptions();
      untracked(() => {
        if (!report?.dateRange) {
          this.dateFiltered.set([]);
          this.error.set(null);
          this.lastQueryKey = '';
          return;
        }

        const profiles = report.stockProfiles ?? [];
        const needsTradeQuery =
          !isFullReportDateRange(report.dateRange, opts) ||
          (profiles.length > 0 && !profilesHaveTypeBreakdown(profiles));

        if (!needsTradeQuery) {
          this.dateFiltered.set([]);
          this.loading.set(false);
          this.error.set(null);
          this.lastQueryKey = '';
          return;
        }

        const queryKey = [
          report.summary.clientCode,
          report.dateRange.min,
          report.dateRange.max,
          opts.startDate ?? '',
          opts.endDate ?? '',
          (opts.tradeTypes ?? []).join(','),
        ].join('|');

        // Skip identical reloads triggered by silent report object replacement.
        if (queryKey === this.lastQueryKey) return;
        this.lastQueryKey = queryKey;

        void this.reloadFromTrades(report.summary.clientCode, report.dateRange, opts);
      });
    });
  }

  private async reloadFromTrades(
    clientCode: string,
    dateRange: { min: string; max: string },
    opts: ReturnType<ReportStateService['analysisOptions']>
  ): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    try {
      const stocks = await this.ledger.getFilteredStockSummaries(clientCode, {
        startDate: opts.startDate || dateRange.min,
        endDate: opts.endDate || dateRange.max,
        tradeTypes: opts.tradeTypes,
      });
      if (seq === this.loadSeq) {
        this.dateFiltered.set(stocks);
        this.error.set(null);
      }
    } catch (e) {
      // Keep the last good list (and aggregate P&L). Only surface the error when
      // there is nothing left to show for this filter.
      if (seq === this.loadSeq) {
        console.warn('Filtered stock reload failed', e);
        const hasFallback =
          this.dateFiltered().length > 0 ||
          (this.state.analysis()?.stocks.length ?? 0) > 0 ||
          (this.state.report()?.stockSummary.length ?? 0) > 0;
        if (!hasFallback) {
          this.error.set(e instanceof Error ? e.message : 'Could not load trades for this filter');
        }
      }
    } finally {
      if (seq === this.loadSeq) {
        this.loading.set(false);
      }
    }
  }
}

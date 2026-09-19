import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { AnalysisOptions, Report, StockSummary, Trade } from '../models/trade.models';
import { TradeLedgerService } from './trade-ledger.service';
import { ReportStateService } from './report-state.service';
import { stockIdentityKey, tradeBelongsToStock } from '../utils/stock-identity.utils';
import { normalizeSymbol } from '../utils/upload-merge.utils';
import { sortTradesBySellDateDesc, storedTradeToTrade } from '../utils/trade.utils';
import { tradeMatchesTypeFilter } from '../utils/trade-type-filter.utils';
import { effectiveAnalysisDateRange } from '../utils/filter-stock-profiles.utils';
import { tradeDateKey } from '../utils/trade-date.utils';

@Injectable({ providedIn: 'root' })
export class LazyTradeLoaderService {
  private ledger = inject(TradeLedgerService);
  private reportState = inject(ReportStateService);
  private lists = signal<Map<string, Trade[]>>(new Map());
  loadingKey = signal<string | null>(null);

  constructor() {
    let prevFilterKey = '';
    effect(() => {
      const key = this.filterKey();
      untracked(() => {
        if (prevFilterKey && prevFilterKey !== key) {
          this.clear();
        }
        prevFilterKey = key;
      });
    });

    let prevTradesLoaded = false;
    effect(() => {
      const report = this.reportState.report();
      const tradesLoaded = !!(report?.tradesLoaded && (report?.trades?.length ?? 0) > 0);
      untracked(() => {
        if (tradesLoaded && !prevTradesLoaded) {
          this.clear();
        }
        prevTradesLoaded = tradesLoaded;
      });
    });
  }

  tradesForKey(key: string): Trade[] {
    return this.lists().get(key) ?? [];
  }

  isLoading(key: string): boolean {
    return this.loadingKey() === key;
  }

  stockSymbol(stock: StockSummary): string {
    return (stock.symbol || normalizeSymbol(stock.stockName)).toUpperCase();
  }

  cacheKeyForStock(stock: StockSummary): string {
    return `stock:${stockIdentityKey(stock)}:${this.filterKey()}`;
  }

  cacheKeyForStockInPeriod(
    stock: StockSummary,
    tab: PeriodScopeTab,
    periodKey: string
  ): string {
    return `stock:${stockIdentityKey(stock)}:${tab}:${periodKey}:${this.filterKey()}`;
  }

  cacheKeyForPeriod(tab: PeriodScopeTab, periodKey: string): string {
    return `period:${tab}:${periodKey}:${this.filterKey()}`;
  }

  filterTradesForStock(
    trades: Trade[],
    stock: StockSummary,
    report: Report | null,
    filters: AnalysisOptions
  ): Trade[] {
    return this.filterTrades(trades, stock, this.effectiveFilters(report, filters));
  }

  async loadForStock(
    clientCode: string,
    stock: StockSummary,
    report: Report | null,
    filters: AnalysisOptions
  ): Promise<Trade[]> {
    const key = this.cacheKeyForStock(stock);
    const cached = this.lists().get(key);
    if (cached) return cached;

    const effective = this.effectiveFilters(report, filters);

    if (report?.trades?.length) {
      const trades = this.filterTrades(report.trades, stock, effective);
      this.setCache(key, trades);
      return trades;
    }

    this.loadingKey.set(key);
    try {
      const rows = await this.ledger.getTradesForStock(
        clientCode,
        { symbol: stock.symbol || normalizeSymbol(stock.stockName), isin: stock.isin },
        effective
      );
      const trades = this.filterTrades(
        rows.map(storedTradeToTrade),
        stock,
        effective
      );
      this.setCache(key, trades);
      return trades;
    } finally {
      this.loadingKey.set(null);
    }
  }

  /**
   * Trades for one stock, clipped to a daily/weekly/monthly bucket.
   * Reuses the period cache when present so we never pull outside that window.
   */
  async loadForStockInPeriod(
    clientCode: string,
    stock: StockSummary,
    tab: PeriodScopeTab,
    periodKey: string,
    report: Report | null,
    filters: AnalysisOptions
  ): Promise<Trade[]> {
    const key = this.cacheKeyForStockInPeriod(stock, tab, periodKey);
    const cached = this.lists().get(key);
    if (cached) return cached;

    const periodTrades = await this.loadForPeriod(clientCode, periodKey, tab, report, filters);
    const trades = sortTradesBySellDateDesc(
      periodTrades.filter((trade) => this.tradeMatchesStock(trade, stock))
    );
    this.setCache(key, trades);
    return trades;
  }

  async loadForPeriod(
    clientCode: string,
    periodKey: string,
    tab: PeriodScopeTab,
    report: Report | null,
    filters: AnalysisOptions
  ): Promise<Trade[]> {
    const key = this.cacheKeyForPeriod(tab, periodKey);
    const cached = this.lists().get(key);
    if (cached) return cached;

    const effective = this.effectiveFilters(report, filters);
    const mergedFilters: AnalysisOptions = usesFullFilterRange(tab)
      ? { ...filters, startDate: effective.startDate, endDate: effective.endDate }
      : (() => {
          const periodRange = periodDateRange(periodKey, tab as 'daily' | 'weekly' | 'monthly');
          return {
            ...filters,
            startDate: intersectStart(periodRange.start, effective.startDate ?? ''),
            endDate: intersectEnd(periodRange.end, effective.endDate ?? ''),
          };
        })();

    const scopeFilter = usesFullFilterRange(tab)
      ? (trade: Trade) => matchesPeriodScope(trade, tab, periodKey)
      : null;

    if (report?.trades?.length) {
      let trades = this.filterTradesByOptions(report.trades, mergedFilters);
      if (scopeFilter) trades = trades.filter(scopeFilter);
      this.setCache(key, sortTradesBySellDateDesc(trades));
      return this.lists().get(key)!;
    }

    this.loadingKey.set(key);
    try {
      const rows = await this.ledger.getTradesForDateRange(
        clientCode,
        mergedFilters.startDate!,
        mergedFilters.endDate!,
        mergedFilters
      );
      let trades = rows.map(storedTradeToTrade);
      if (scopeFilter) trades = trades.filter(scopeFilter);
      this.setCache(key, sortTradesBySellDateDesc(trades));
      return this.lists().get(key)!;
    } finally {
      this.loadingKey.set(null);
    }
  }

  clear(): void {
    this.lists.set(new Map());
    this.loadingKey.set(null);
  }

  private filterKey(): string {
    const opts = this.reportState.analysisOptions();
    const { startDate, endDate } = effectiveAnalysisDateRange(
      this.reportState.report()?.dateRange,
      opts
    );
    const types = (opts.tradeTypes ?? ['all']).join(',');
    return `${startDate}|${endDate}|${types}`;
  }

  private effectiveFilters(report: Report | null, filters: AnalysisOptions): AnalysisOptions {
    const { startDate, endDate } = effectiveAnalysisDateRange(report?.dateRange, filters);
    return { ...filters, startDate, endDate };
  }

  private setCache(key: string, trades: Trade[]): void {
    this.lists.update((current) => {
      const next = new Map(current);
      next.set(key, trades);
      return next;
    });
  }

  private tradeMatchesStock(trade: Trade, stock: StockSummary): boolean {
    return tradeBelongsToStock(trade, stock);
  }

  private filterTrades(trades: Trade[], stock: StockSummary, filters: AnalysisOptions): Trade[] {
    return sortTradesBySellDateDesc(
      this.filterTradesByOptions(trades, filters).filter((trade) =>
        this.tradeMatchesStock(trade, stock)
      )
    );
  }

  private filterTradesByOptions(trades: Trade[], filters: AnalysisOptions): Trade[] {
    return trades.filter((trade) => {
      const sellDate = tradeDateKey(trade.sellDate);
      if (filters.startDate && sellDate < filters.startDate) return false;
      if (filters.endDate && sellDate > filters.endDate) return false;
      if (!tradeMatchesTypeFilter(trade, filters.tradeTypes)) return false;
      return true;
    });
  }
}

function intersectStart(periodStart: string, filterStart: string): string {
  if (!filterStart) return periodStart;
  return filterStart > periodStart ? filterStart : periodStart;
}

function intersectEnd(periodEnd: string, filterEnd: string): string {
  if (!filterEnd) return periodEnd;
  return filterEnd < periodEnd ? filterEnd : periodEnd;
}

export type PeriodScopeTab =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'weekday'
  | 'dayOfMonth'
  | 'monthOfYear';

function tradeWeekday(trade: Trade): number {
  return new Date(`${trade.sellDate}T12:00:00`).getDay();
}

function tradeDayOfMonth(trade: Trade): number {
  return Number(trade.sellDate.slice(8, 10));
}

function tradeMonthOfYear(trade: Trade): string {
  return trade.sellDate.slice(5, 7);
}

function matchesPeriodScope(trade: Trade, tab: PeriodScopeTab, periodKey: string): boolean {
  if (tab === 'weekday') return tradeWeekday(trade) === Number(periodKey);
  if (tab === 'dayOfMonth') return tradeDayOfMonth(trade) === Number(periodKey);
  if (tab === 'monthOfYear') return tradeMonthOfYear(trade) === periodKey.padStart(2, '0');
  return true;
}

function usesFullFilterRange(tab: PeriodScopeTab): boolean {
  return tab === 'weekday' || tab === 'dayOfMonth' || tab === 'monthOfYear';
}

export function periodDateRange(
  periodKey: string,
  tab: 'daily' | 'weekly' | 'monthly'
): { start: string; end: string } {
  if (tab === 'daily') {
    return { start: periodKey, end: periodKey };
  }
  if (tab === 'monthly') {
    const [year, month] = periodKey.split('-').map(Number);
    const start = `${periodKey}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${periodKey}-${String(lastDay).padStart(2, '0')}`;
    return { start, end };
  }

  const match = periodKey.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return { start: periodKey, end: periodKey };
  const year = Number(match[1]);
  const week = Number(match[2]);
  const start = isoWeekStart(year, week);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: formatIsoDate(start), end: formatIsoDate(end) };
}

function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - day + 1 + (week - 1) * 7);
  return monday;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

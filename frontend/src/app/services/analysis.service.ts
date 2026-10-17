import { Injectable } from '@angular/core';
import {
  AnalysisOptions,
  AnalysisResult,
  PeriodBucket,
  Report,
  StockSummary,
  Trade,
  TradeType,
} from '../models/trade.models';
import {
  buildSummaryFromDaily,
  filterDailyAnalytics,
  rollupDailyToPeriodBuckets,
} from '../utils/analytics-aggregation.utils';
import { buildTradeTypeFilter, tradeMatchesTypeFilter } from '../utils/trade-type-filter.utils';
import { mergeStockSummaries } from '../utils/filter-stock-profiles.utils';
import { normalizeIsin, stockIdentityKey } from '../utils/stock-identity.utils';
import { normalizeSymbol } from '../utils/upload-merge.utils';

@Injectable({ providedIn: 'root' })
export class AnalysisService {
  /** Memo of full AnalysisResult by report + filter fingerprint (cleared on upload / refresh). */
  private resultCache = new Map<string, AnalysisResult>();
  private static readonly MAX_CACHED_RESULTS = 8;

  analyze(report: Report, opts: AnalysisOptions = {}): AnalysisResult {
    const cacheKey = this.resultCacheKey(report, opts);
    const hit = this.resultCache.get(cacheKey);
    if (hit) return hit;

    const allTrades = report.trades ?? [];
    const stockSummary = report.stockSummary ?? [];
    const charges = report.charges ?? { items: [], total: 0 };
    const reportTotalSell =
      allTrades.length > 0
        ? allTrades.reduce((s, t) => s + t.sellValue, 0)
        : stockSummary.reduce((s, stock) => s + stock.sellValue, 0);
    const chargeRatio = reportTotalSell > 0 && charges.total > 0
      ? charges.total / reportTotalSell
      : 0;

    const hasTrades = allTrades.length > 0;
    const dailyRows = filterDailyAnalytics(report.dailyAnalytics ?? [], opts);
    const hasDaily = dailyRows.length > 0;

    const trades = hasTrades ? this.filterTrades(allTrades, opts) : [];
    const stocks =
      hasTrades
        ? this.aggregateByStock(trades, chargeRatio)
        : this.filterStockSummary(stockSummary, opts);

    const summaryFromDaily = hasDaily ? buildSummaryFromDaily(dailyRows) : null;
    const summary = hasTrades
      ? this.buildSummary(trades, chargeRatio)
      : summaryFromDaily
        ? { ...summaryFromDaily, chargeRatio }
        : this.buildSummaryFromStocks(stocks, chargeRatio);

    /**
     * Period buckets are built on first access and cached, rather than all three up front.
     * Each pass walks every trade, copies it into a bucket and sorts the bucket, so eagerly
     * computing daily + weekly + monthly tripled the work and the peak memory on every filter
     * change — while the UI only ever displays one granularity at a time.
     */
    type Granularity = 'daily' | 'weekly' | 'monthly';
    const periodCache = new Map<Granularity, PeriodBucket[]>();
    const periodBuckets = (period: Granularity): PeriodBucket[] => {
      const cached = periodCache.get(period);
      if (cached) return cached;
      const built = hasTrades
        ? this.aggregateByPeriod(trades, chargeRatio, period)
        : hasDaily
          ? rollupDailyToPeriodBuckets(dailyRows, period)
          : [];
      periodCache.set(period, built);
      return built;
    };

    const result: AnalysisResult = {
      summary,
      get daily() {
        return periodBuckets('daily');
      },
      get weekly() {
        return periodBuckets('weekly');
      },
      get monthly() {
        return periodBuckets('monthly');
      },
      stocks,
      charges,
      filteredTrades: trades,
      filters: {
        startDate: opts.startDate ?? '',
        endDate: opts.endDate ?? '',
        tradeTypes: opts.tradeTypes ?? [],
      },
    };
    this.rememberResult(cacheKey, result);
    return result;
  }

  /** Drop memoized analysis (page refresh / new upload). */
  clearCache(): void {
    this.resultCache.clear();
  }

  private rememberResult(key: string, result: AnalysisResult): void {
    this.resultCache.set(key, result);
    if (this.resultCache.size <= AnalysisService.MAX_CACHED_RESULTS) return;
    const oldest = this.resultCache.keys().next().value;
    if (oldest !== undefined) this.resultCache.delete(oldest);
  }

  private resultCacheKey(report: Report, opts: AnalysisOptions): string {
    const types = [...(opts.tradeTypes ?? [])].map(String).sort().join(',');
    return [
      report.summary?.clientCode ?? '',
      report.summary?.realisedPnL ?? '',
      report.dateRange?.min ?? '',
      report.dateRange?.max ?? '',
      report.totalTradeCount ?? report.trades?.length ?? 0,
      report.stockSummary?.length ?? 0,
      report.dailyAnalytics?.length ?? 0,
      report.tradesLoaded ? 1 : 0,
      opts.startDate ?? '',
      opts.endDate ?? '',
      types,
    ].join('|');
  }

  private filterTrades(trades: Trade[], opts: AnalysisOptions): Trade[] {
    return trades.filter((t) => {
      if (opts.startDate && t.sellDate < opts.startDate) return false;
      if (opts.endDate && t.sellDate > opts.endDate) return false;
      if (!tradeMatchesTypeFilter(t, opts.tradeTypes)) return false;
      return true;
    });
  }

  private buildSummaryFromStocks(stocks: StockSummary[], chargeRatio: number) {
    let winningTrades = 0;
    let losingTrades = 0;
    let totalBuyValue = 0;
    let totalSellValue = 0;
    let realisedPnL = 0;
    let tradeCount = 0;

    for (const stock of stocks) {
      totalBuyValue += stock.buyValue;
      totalSellValue += stock.sellValue;
      realisedPnL += stock.realisedPnL;
      tradeCount += stock.tradeCount;
      if (stock.realisedPnL > 0) winningTrades += stock.tradeCount;
      else if (stock.realisedPnL < 0) losingTrades += stock.tradeCount;
    }

    const allocatedCharges = stocks.reduce((sum, stock) => sum + stock.allocatedCharges, 0);
    return {
      tradeCount,
      totalBuyValue,
      totalSellValue,
      realisedPnL,
      winningTrades,
      losingTrades,
      winRate: tradeCount ? (winningTrades / tradeCount) * 100 : 0,
      allocatedCharges,
      netPnL: realisedPnL - allocatedCharges,
      chargeRatio,
    };
  }

  private filterStockSummary(stocks: StockSummary[], _opts: AnalysisOptions): StockSummary[] {
    return mergeStockSummaries(stocks);
  }

  private buildSummary(trades: Trade[], chargeRatio: number) {
    let winningTrades = 0;
    let losingTrades = 0;
    let totalBuyValue = 0;
    let totalSellValue = 0;
    let realisedPnL = 0;

    for (const t of trades) {
      totalBuyValue += t.buyValue;
      totalSellValue += t.sellValue;
      realisedPnL += t.realisedPnL;
      if (t.realisedPnL > 0) winningTrades++;
      else if (t.realisedPnL < 0) losingTrades++;
    }

    const tradeCount = trades.length;
    const allocatedCharges = trades.reduce((sum, t) => sum + this.tradeCharge(t, chargeRatio), 0);
    return {
      tradeCount,
      totalBuyValue,
      totalSellValue,
      realisedPnL,
      winningTrades,
      losingTrades,
      winRate: tradeCount ? (winningTrades / tradeCount) * 100 : 0,
      allocatedCharges,
      netPnL: realisedPnL - allocatedCharges,
      chargeRatio,
    };
  }

  private tradeCharge(trade: Trade, chargeRatio: number): number {
    return trade.allocatedCharges ?? trade.sellValue * chargeRatio;
  }

  private aggregateByPeriod(
    trades: Trade[],
    chargeRatio: number,
    period: 'daily' | 'weekly' | 'monthly'
  ): PeriodBucket[] {
    const buckets = new Map<string, PeriodBucket>();

    for (const t of trades) {
      const { key, label } = this.periodKey(t.sellDate, period);
      let b = buckets.get(key);
      if (!b) {
        b = {
          period: key,
          label,
          tradeCount: 0,
          totalBuyValue: 0,
          totalSellValue: 0,
          realisedPnL: 0,
          winningTrades: 0,
          losingTrades: 0,
          winRate: 0,
          allocatedCharges: 0,
          netPnL: 0,
          trades: [],
        };
        buckets.set(key, b);
      }
      b.tradeCount++;
      b.totalBuyValue += t.buyValue;
      b.totalSellValue += t.sellValue;
      b.realisedPnL += t.realisedPnL;
      if (t.realisedPnL > 0) b.winningTrades++;
      else if (t.realisedPnL < 0) b.losingTrades++;
      b.allocatedCharges += this.tradeCharge(t, chargeRatio);
      b.trades.push(t);
    }

    return [...buckets.values()]
      .map((b) => {
        b.winRate = b.tradeCount ? (b.winningTrades / b.tradeCount) * 100 : 0;
        b.netPnL = b.realisedPnL - b.allocatedCharges;
        b.trades.sort((a, b2) => b2.realisedPnL - a.realisedPnL);
        if (period === 'weekly') {
          b.label = this.weeklyRangeLabel(b.trades);
        }
        return b;
      })
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  private weeklyRangeLabel(trades: Trade[]): string {
    if (!trades.length) return '';
    const dates = trades.map((t) => t.sellDate).sort();
    return this.formatDateRange(dates[0], dates[dates.length - 1]);
  }

  private formatDateRange(from: string, to: string): string {
    const fmt = (iso: string, withYear: boolean) =>
      new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        ...(withYear ? { year: 'numeric' } : {}),
      });

    if (from === to) return fmt(from, true);

    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    return `${fmt(from, !sameYear)} – ${fmt(to, true)}`;
  }

  private periodKey(dateStr: string, period: string): { key: string; label: string } {
    const d = new Date(dateStr + 'T00:00:00');
    if (period === 'weekly') {
      const { year, week } = this.getISOWeek(d);
      return {
        key: `${year}-W${String(week).padStart(2, '0')}`,
        label: '',
      };
    }
    if (period === 'monthly') {
      const key = dateStr.slice(0, 7);
      return {
        key,
        label: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
      };
    }
    return {
      key: dateStr,
      label: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    };
  }

  private getISOWeek(d: Date): { year: number; week: number } {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return { year: date.getUTCFullYear(), week };
  }

  /** Public so callers can build the same per-stock rows for a narrower slice, e.g. one day. */
  aggregateByStock(trades: Trade[], chargeRatio: number): StockSummary[] {
    const map = new Map<string, StockSummary>();

    for (const t of trades) {
      const key = stockIdentityKey(t);
      let s = map.get(key);
      if (!s) {
        s = {
          stockName: t.stockName,
          isin: normalizeIsin(t.isin),
          symbol: normalizeSymbol(t.stockName),
          quantity: 0,
          avgBuyPrice: 0,
          buyValue: 0,
          avgSellPrice: 0,
          sellValue: 0,
          realisedPnL: 0,
          realisedPnLPct: 0,
          tradeCount: 0,
          allocatedCharges: 0,
          netPnL: 0,
        };
        map.set(key, s);
      }
      s.tradeCount++;
      s.quantity += t.quantity;
      s.buyValue += t.buyValue;
      s.sellValue += t.sellValue;
      s.realisedPnL += t.realisedPnL;
      s.allocatedCharges += this.tradeCharge(t, chargeRatio);
    }

    return mergeStockSummaries([...map.values()]
      .map((s) => {
        if (s.quantity > 0) {
          s.avgBuyPrice = s.buyValue / s.quantity;
          s.avgSellPrice = s.sellValue / s.quantity;
        }
        if (s.buyValue > 0) s.realisedPnLPct = s.realisedPnL / s.buyValue;
        s.netPnL = s.realisedPnL - s.allocatedCharges;
        return s;
      })
      .sort((a, b) => b.realisedPnL - a.realisedPnL));
  }
}

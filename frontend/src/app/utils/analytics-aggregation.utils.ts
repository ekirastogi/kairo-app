import {
  AnalysisOptions,
  DailyAnalyticsRow,
  PeriodBucket,
  StoredTrade,
  TradeType,
} from '../models/trade.models';
import { CalendarBucket } from './analytics-insights.utils';
import { buildTradeTypeFilter } from './trade-type-filter.utils';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function buildDailyAnalyticsFromTrades(trades: StoredTrade[]): DailyAnalyticsRow[] {
  const buckets = new Map<string, DailyAnalyticsRow>();

  for (const trade of trades) {
    const key = `${trade.sellDate}::${trade.tradeType}`;
    let row = buckets.get(key);
    if (!row) {
      row = {
        sellDate: trade.sellDate,
        tradeType: trade.tradeType,
        tradeCount: 0,
        totalBuyValue: 0,
        totalSellValue: 0,
        realisedPnL: 0,
        allocatedCharges: 0,
        netPnL: 0,
        winningTrades: 0,
        losingTrades: 0,
      };
      buckets.set(key, row);
    }
    row.tradeCount++;
    row.totalBuyValue += trade.buyValue;
    row.totalSellValue += trade.sellValue;
    row.realisedPnL += trade.realisedPnL;
    row.allocatedCharges += trade.allocatedCharges;
    row.netPnL += trade.netPnL;
    if (trade.realisedPnL > 0) row.winningTrades++;
    else if (trade.realisedPnL < 0) row.losingTrades++;
  }

  return [...buckets.values()].sort((a, b) => a.sellDate.localeCompare(b.sellDate));
}

export function filterDailyAnalytics(
  rows: DailyAnalyticsRow[],
  opts: AnalysisOptions
): DailyAnalyticsRow[] {
  const typeFilter = buildTradeTypeFilter(opts.tradeTypes);
  return rows.filter((row) => {
    if (opts.startDate && row.sellDate < opts.startDate) return false;
    if (opts.endDate && row.sellDate > opts.endDate) return false;
    if (typeFilter && !typeFilter.has(row.tradeType)) return false;
    return true;
  });
}

export function buildSummaryFromDaily(rows: DailyAnalyticsRow[]) {
  let winningTrades = 0;
  let losingTrades = 0;
  let totalBuyValue = 0;
  let totalSellValue = 0;
  let realisedPnL = 0;
  let allocatedCharges = 0;
  let tradeCount = 0;

  for (const row of rows) {
    totalBuyValue += row.totalBuyValue;
    totalSellValue += row.totalSellValue;
    realisedPnL += row.realisedPnL;
    allocatedCharges += row.allocatedCharges;
    tradeCount += row.tradeCount;
    winningTrades += row.winningTrades;
    losingTrades += row.losingTrades;
  }

  const netPnL = realisedPnL - allocatedCharges;
  return {
    tradeCount,
    totalBuyValue,
    totalSellValue,
    realisedPnL,
    winningTrades,
    losingTrades,
    winRate: tradeCount ? (winningTrades / tradeCount) * 100 : 0,
    allocatedCharges,
    netPnL,
  };
}

export function getISOWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

function formatDateRange(from: string, to: string): string {
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

function periodKeyForDate(
  dateStr: string,
  period: 'daily' | 'weekly' | 'monthly'
): { key: string; label: string } {
  const d = new Date(dateStr + 'T00:00:00');
  if (period === 'weekly') {
    const { year, week } = getISOWeek(d);
    return { key: `${year}-W${String(week).padStart(2, '0')}`, label: '' };
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

export function rollupDailyToPeriodBuckets(
  rows: DailyAnalyticsRow[],
  period: 'daily' | 'weekly' | 'monthly'
): PeriodBucket[] {
  const buckets = new Map<string, PeriodBucket & { dates: string[] }>();

  for (const row of rows) {
    const { key, label } = periodKeyForDate(row.sellDate, period);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
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
        dates: [],
      };
      buckets.set(key, bucket);
    }
    bucket.tradeCount += row.tradeCount;
    bucket.totalBuyValue += row.totalBuyValue;
    bucket.totalSellValue += row.totalSellValue;
    bucket.realisedPnL += row.realisedPnL;
    bucket.winningTrades += row.winningTrades;
    bucket.losingTrades += row.losingTrades;
    bucket.allocatedCharges += row.allocatedCharges;
    bucket.dates.push(row.sellDate);
  }

  return [...buckets.values()]
    .map((bucket) => {
      bucket.winRate = bucket.tradeCount ? (bucket.winningTrades / bucket.tradeCount) * 100 : 0;
      bucket.netPnL = bucket.realisedPnL - bucket.allocatedCharges;
      if (period === 'weekly') {
        const dates = [...new Set(bucket.dates)].sort();
        bucket.label = formatDateRange(dates[0], dates[dates.length - 1]);
      }
      const { dates: _dates, ...rest } = bucket;
      return rest;
    })
    .sort((a, b) => a.period.localeCompare(b.period));
}

export function aggregateWeekdayFromDaily(rows: DailyAnalyticsRow[]): CalendarBucket[] {
  const buckets = new Map<number, CalendarBucket>();
  for (let i = 0; i < 7; i++) {
    buckets.set(i, {
      key: String(i),
      label: WEEKDAY_LABELS[i],
      tradeCount: 0,
      netPnL: 0,
      realisedPnL: 0,
      allocatedCharges: 0,
      winningTrades: 0,
      losingTrades: 0,
    });
  }

  for (const row of rows) {
    const day = new Date(`${row.sellDate}T12:00:00`).getDay();
    const bucket = buckets.get(day)!;
    bucket.tradeCount += row.tradeCount;
    bucket.realisedPnL += row.realisedPnL;
    bucket.allocatedCharges += row.allocatedCharges;
    bucket.netPnL += row.netPnL;
    bucket.winningTrades += row.winningTrades;
    bucket.losingTrades += row.losingTrades;
  }

  return [...buckets.values()];
}

export function aggregateDayOfMonthFromDaily(rows: DailyAnalyticsRow[]): CalendarBucket[] {
  const buckets = new Map<number, CalendarBucket>();
  for (let day = 1; day <= 31; day++) {
    buckets.set(day, {
      key: String(day),
      label: String(day),
      tradeCount: 0,
      netPnL: 0,
      realisedPnL: 0,
      allocatedCharges: 0,
      winningTrades: 0,
      losingTrades: 0,
    });
  }

  for (const row of rows) {
    const day = Number(row.sellDate.slice(8, 10));
    if (!day || day < 1 || day > 31) continue;
    const bucket = buckets.get(day)!;
    bucket.tradeCount += row.tradeCount;
    bucket.realisedPnL += row.realisedPnL;
    bucket.allocatedCharges += row.allocatedCharges;
    bucket.netPnL += row.netPnL;
    bucket.winningTrades += row.winningTrades;
    bucket.losingTrades += row.losingTrades;
  }

  return [...buckets.values()];
}

import { PeriodBucket, StockSummary, Trade } from '../models/trade.models';

export interface CalendarBucket {
  key: string;
  label: string;
  tradeCount: number;
  netPnL: number;
  realisedPnL: number;
  allocatedCharges: number;
  winningTrades: number;
  losingTrades: number;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function tradeNetPnL(trade: Trade, chargeRatio: number): number {
  const charges = trade.allocatedCharges ?? trade.sellValue * chargeRatio;
  return trade.netPnL ?? trade.realisedPnL - charges;
}

function tradeCharges(trade: Trade, chargeRatio: number): number {
  return trade.allocatedCharges ?? trade.sellValue * chargeRatio;
}

export function aggregateByWeekday(trades: Trade[], chargeRatio: number): CalendarBucket[] {
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

  for (const trade of trades) {
    const day = new Date(`${trade.sellDate}T12:00:00`).getDay();
    const bucket = buckets.get(day)!;
    bucket.tradeCount++;
    bucket.realisedPnL += trade.realisedPnL;
    bucket.allocatedCharges += tradeCharges(trade, chargeRatio);
    bucket.netPnL += tradeNetPnL(trade, chargeRatio);
    if (trade.realisedPnL > 0) bucket.winningTrades++;
    else if (trade.realisedPnL < 0) bucket.losingTrades++;
  }

  return [...buckets.values()];
}

export function aggregateByDayOfMonth(trades: Trade[], chargeRatio: number): CalendarBucket[] {
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

  for (const trade of trades) {
    const day = Number(trade.sellDate.slice(8, 10));
    if (!day || day < 1 || day > 31) continue;
    const bucket = buckets.get(day)!;
    bucket.tradeCount++;
    bucket.realisedPnL += trade.realisedPnL;
    bucket.allocatedCharges += tradeCharges(trade, chargeRatio);
    bucket.netPnL += tradeNetPnL(trade, chargeRatio);
    if (trade.realisedPnL > 0) bucket.winningTrades++;
    else if (trade.realisedPnL < 0) bucket.losingTrades++;
  }

  return [...buckets.values()];
}

export function pickExtremeBucket(
  buckets: CalendarBucket[],
  pick: 'best' | 'worst',
  minTrades = 1
): CalendarBucket | null {
  const eligible = buckets.filter((b) => b.tradeCount >= minTrades);
  if (!eligible.length) return null;
  return eligible.reduce((acc, bucket) => {
    if (pick === 'best') return bucket.netPnL > acc.netPnL ? bucket : acc;
    return bucket.netPnL < acc.netPnL ? bucket : acc;
  });
}

export function pickExtremePeriod(
  buckets: PeriodBucket[],
  pick: 'best' | 'worst'
): PeriodBucket | null {
  if (!buckets.length) return null;
  return buckets.reduce((acc, bucket) => {
    if (pick === 'best') return bucket.netPnL > acc.netPnL ? bucket : acc;
    return bucket.netPnL < acc.netPnL ? bucket : acc;
  });
}

export function avgNetPerTrade(bucket: CalendarBucket): number {
  return bucket.tradeCount ? bucket.netPnL / bucket.tradeCount : 0;
}

export function sortedStocks(stocks: StockSummary[], key: 'netPnL' | 'realisedPnL' | 'tradeCount' | 'winRate'): StockSummary[] {
  const rows = [...stocks];
  rows.sort((a, b) => {
    switch (key) {
      case 'realisedPnL':
        return b.realisedPnL - a.realisedPnL;
      case 'tradeCount':
        return b.tradeCount - a.tradeCount;
      case 'winRate':
        return (b.winRate ?? 0) - (a.winRate ?? 0);
      default:
        return b.netPnL - a.netPnL;
    }
  });
  return rows;
}

export function heatClass(value: number, maxAbs: number): string {
  if (!maxAbs || value === 0) return 'heat-neutral';
  const intensity = Math.min(Math.abs(value) / maxAbs, 1);
  if (value > 0) {
    if (intensity > 0.66) return 'heat-pos-strong';
    if (intensity > 0.33) return 'heat-pos-mid';
    return 'heat-pos-soft';
  }
  if (intensity > 0.66) return 'heat-neg-strong';
  if (intensity > 0.33) return 'heat-neg-mid';
  return 'heat-neg-soft';
}

export interface PeriodStreak {
  kind: 'win' | 'loss';
  length: number;
  netPnL: number;
  startLabel: string;
  endLabel: string;
}

export interface PeriodAnalysisStats {
  periodCount: number;
  greenCount: number;
  redCount: number;
  flatCount: number;
  /** Share of periods with net P&L > 0. */
  greenRate: number;
  totalNetPnL: number;
  totalCharges: number;
  totalTrades: number;
  avgNetPerPeriod: number;
  avgNetPerTrade: number;
  avgWinRate: number;
  /** Gross green-period P&L / abs(gross red-period P&L). */
  profitFactor: number | null;
  bestStreak: PeriodStreak | null;
  worstStreak: PeriodStreak | null;
  currentStreak: PeriodStreak | null;
}

function streakFromRun(
  kind: 'win' | 'loss',
  run: PeriodBucket[]
): PeriodStreak | null {
  if (!run.length) return null;
  return {
    kind,
    length: run.length,
    netPnL: run.reduce((sum, row) => sum + row.netPnL, 0),
    startLabel: run[0].label,
    endLabel: run[run.length - 1].label,
  };
}

/**
 * Consistency / streak stats for daily, weekly, or monthly period buckets.
 * Expects buckets in chronological order.
 */
export function analysePeriods(buckets: PeriodBucket[]): PeriodAnalysisStats | null {
  if (!buckets.length) return null;

  let greenCount = 0;
  let redCount = 0;
  let flatCount = 0;
  let totalNetPnL = 0;
  let totalCharges = 0;
  let totalTrades = 0;
  let winRateWeighted = 0;
  let grossGreen = 0;
  let grossRed = 0;

  let bestStreak: PeriodStreak | null = null;
  let worstStreak: PeriodStreak | null = null;
  let run: PeriodBucket[] = [];
  let runKind: 'win' | 'loss' | null = null;

  const flushRun = () => {
    const streak = runKind ? streakFromRun(runKind, run) : null;
    if (!streak) return;
    if (streak.kind === 'win') {
      if (!bestStreak || streak.length > bestStreak.length ||
          (streak.length === bestStreak.length && streak.netPnL > bestStreak.netPnL)) {
        bestStreak = streak;
      }
    } else if (!worstStreak || streak.length > worstStreak.length ||
        (streak.length === worstStreak.length && streak.netPnL < worstStreak.netPnL)) {
      worstStreak = streak;
    }
  };

  for (const row of buckets) {
    totalNetPnL += row.netPnL;
    totalCharges += row.allocatedCharges;
    totalTrades += row.tradeCount;
    winRateWeighted += row.winRate * row.tradeCount;

    if (row.netPnL > 0) {
      greenCount++;
      grossGreen += row.netPnL;
    } else if (row.netPnL < 0) {
      redCount++;
      grossRed += Math.abs(row.netPnL);
    } else {
      flatCount++;
    }

    const kind: 'win' | 'loss' | null =
      row.netPnL > 0 ? 'win' : row.netPnL < 0 ? 'loss' : null;
    if (!kind) {
      flushRun();
      run = [];
      runKind = null;
      continue;
    }
    if (runKind === kind) {
      run.push(row);
    } else {
      flushRun();
      runKind = kind;
      run = [row];
    }
  }
  flushRun();

  const currentStreak = runKind ? streakFromRun(runKind, run) : null;

  return {
    periodCount: buckets.length,
    greenCount,
    redCount,
    flatCount,
    greenRate: buckets.length ? (greenCount / buckets.length) * 100 : 0,
    totalNetPnL,
    totalCharges,
    totalTrades,
    avgNetPerPeriod: totalNetPnL / buckets.length,
    avgNetPerTrade: totalTrades ? totalNetPnL / totalTrades : 0,
    avgWinRate: totalTrades ? winRateWeighted / totalTrades : 0,
    profitFactor: grossRed > 0 ? grossGreen / grossRed : grossGreen > 0 ? null : 0,
    bestStreak,
    worstStreak,
    currentStreak,
  };
}


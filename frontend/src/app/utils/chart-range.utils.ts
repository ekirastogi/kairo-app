import { ChartOptions, Plugin } from 'chart.js';
import { CHART_COLORS } from './chart-theme';

export interface PeriodValue {
  period: string;
  label: string;
  value: number;
}

export interface ChartDateRange {
  startPeriod: string;
  endPeriod: string;
}

export interface ChartRangeStats {
  startLabel: string;
  endLabel: string;
  startValue: number;
  endValue: number;
  delta: number;
  pct: number | null;
}

export function orderedChartRange(a: string, b: string): ChartDateRange {
  return a <= b
    ? { startPeriod: a, endPeriod: b }
    : { startPeriod: b, endPeriod: a };
}

export function slicePeriodRange<T extends { period: string }>(
  rows: T[],
  range: ChartDateRange | null
): T[] {
  if (!range) return rows;
  return rows.filter(
    (row) => row.period >= range.startPeriod && row.period <= range.endPeriod
  );
}

export function cumulativePeriodValues(
  buckets: { period: string; label: string; netPnL: number }[]
): PeriodValue[] {
  let cumulative = 0;
  return buckets.map((bucket) => {
    cumulative += bucket.netPnL;
    return { period: bucket.period, label: bucket.label, value: cumulative };
  });
}

export function chartRangeStats(
  series: PeriodValue[],
  range: ChartDateRange
): ChartRangeStats | null {
  const start = series.find((row) => row.period === range.startPeriod);
  const end = series.find((row) => row.period === range.endPeriod);
  if (!start || !end) return null;
  const delta = end.value - start.value;
  const pct = start.value === 0 ? null : (delta / Math.abs(start.value)) * 100;
  return {
    startLabel: start.label,
    endLabel: end.label,
    startValue: start.value,
    endValue: end.value,
    delta,
    pct,
  };
}

const MS_PER_DAY = 86_400_000;

/** Inclusive calendar days covered by two chart period keys, or null if they are not dates. */
export function inclusivePeriodDays(startPeriod: string, endPeriod: string): number | null {
  const start = periodToUtcMs(startPeriod, 'start');
  const end = periodToUtcMs(endPeriod, 'end');
  if (start == null || end == null || end < start) return null;
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

export function formatRangeWithDays(
  startLabel: string,
  endLabel: string,
  startPeriod: string,
  endPeriod: string
): string {
  const days = inclusivePeriodDays(startPeriod, endPeriod);
  const span = days == null ? '' : ` (${days} day${days === 1 ? '' : 's'})`;
  return `${startLabel} → ${endLabel}${span}`;
}

function periodToUtcMs(period: string, edge: 'start' | 'end'): number | null {
  const day = period.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const month = period.match(/^(\d{4})-(\d{2})$/);
  if (month) {
    const year = Number(month[1]);
    const monthIndex = Number(month[2]) - 1;
    return edge === 'start' ? Date.UTC(year, monthIndex, 1) : Date.UTC(year, monthIndex + 1, 0);
  }
  const week = period.match(/^(\d{4})-W(\d{2})$/i);
  if (!week) return null;
  const monday = isoWeekUtcMonday(Number(week[1]), Number(week[2]));
  return edge === 'start' ? monday : monday + 6 * MS_PER_DAY;
}

function isoWeekUtcMonday(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay() || 7;
  return jan4 - (jan4Dow - 1) * MS_PER_DAY + (week - 1) * 7 * MS_PER_DAY;
}

export function withRangeAnchor(options: ChartOptions, index: number | null): ChartOptions {
  return {
    ...options,
    plugins: {
      ...options.plugins,
      rangeAnchorLine: { index },
    } as ChartOptions['plugins'],
  };
}

/** Vertical marker for the first click. Enable with options.plugins.rangeAnchorLine.index. */
export const rangeAnchorPlugin: Plugin = {
  id: 'rangeAnchorLine',
  afterDraw(chart) {
    const index = (
      chart.options.plugins as { rangeAnchorLine?: { index?: number | null } } | undefined
    )?.rangeAnchorLine?.index;
    if (index == null || index < 0) return;
    const meta = chart.getDatasetMeta(0);
    const point = meta.data[index];
    if (!point) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = CHART_COLORS.secondary;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(point.x, chartArea.top);
    ctx.lineTo(point.x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

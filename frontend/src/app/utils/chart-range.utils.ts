import { Plugin } from 'chart.js';
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

/** Vertical marker for the first click while waiting for an end point. */
export function rangeAnchorPlugin(index: number | null): Plugin {
  return {
    id: 'rangeAnchorLine',
    afterDraw(chart) {
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
}

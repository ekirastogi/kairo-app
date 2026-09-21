import { ChartConfiguration, ChartOptions, Plugin } from 'chart.js';
import { formatCompactCurrency, formatCurrency } from './format.utils';

export const CHART_COLORS = {
  primary: '#00d09c',
  primaryDark: '#00b88a',
  primaryLight: 'rgba(0, 208, 156, 0.12)',
  secondary: '#6366f1',
  secondaryLight: 'rgba(99, 102, 241, 0.12)',
  success: '#10b981',
  successSoft: 'rgba(16, 185, 129, 0.85)',
  danger: '#ef4444',
  dangerSoft: 'rgba(239, 68, 68, 0.85)',
  neutral: '#94a3b8',
  ink: '#0f172a',
  muted: '#64748b',
  grid: 'rgba(148, 163, 184, 0.2)',
  border: 'rgba(148, 163, 184, 0.35)',
  palette: [
    '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4',
    '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b',
  ],
};

const FONT = { family: 'Inter, system-ui, -apple-system, sans-serif' };

export function isMobileChart(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 768;
}

export function abbreviateLabel(label: string, max = 12): string {
  if (label.length <= max) return label;
  return label.slice(0, max - 1) + '…';
}

export function pnlColor(value: number, alpha = 0.88): string {
  return value >= 0
    ? `rgba(16, 185, 129, ${alpha})`
    : `rgba(239, 68, 68, ${alpha})`;
}

function currencyTooltipLabel(label: string, value: number): string {
  return `${label}: ${formatCurrency(value)}`;
}

function parsedAxisValue(ctx: { parsed?: unknown }, axis: 'x' | 'y'): number {
  const parsed = ctx.parsed;
  if (parsed == null) return NaN;
  if (typeof parsed === 'number') return parsed;
  if (typeof parsed === 'object' && axis in parsed) {
    return Number((parsed as Record<string, unknown>)[axis]);
  }
  return NaN;
}

function percentTooltipLabel(label: string, value: number): string {
  if (!Number.isFinite(value)) return label;
  return `${label}: ${value.toFixed(1)}%`;
}

function baseLayout(): ChartOptions['layout'] {
  return { padding: { top: 4, right: 8, bottom: 0, left: 4 } };
}

function baseTooltip() {
  return {
    backgroundColor: CHART_COLORS.ink,
    titleColor: '#f8fafc',
    bodyColor: '#e2e8f0',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    titleFont: { ...FONT, size: 12, weight: 'bold' as const },
    bodyFont: { ...FONT, size: 12 },
    padding: 12,
    cornerRadius: 10,
    displayColors: true,
    boxWidth: 8,
    boxHeight: 8,
    boxPadding: 6,
  };
}

export function baseLegendPublic(show: boolean): ChartOptions['plugins'] {
  return baseLegend(show);
}

function baseLegend(show: boolean): ChartOptions['plugins'] {
  const mobile = isMobileChart();
  return {
    legend: {
      display: show,
      position: 'top' as const,
      align: 'end' as const,
      labels: {
        boxWidth: mobile ? 8 : 10,
        boxHeight: mobile ? 8 : 10,
        padding: mobile ? 8 : 14,
        font: { ...FONT, size: mobile ? 10 : 11 },
        color: CHART_COLORS.muted,
        usePointStyle: true,
        pointStyle: 'circle' as const,
      },
    },
  };
}

function baseScales(options?: { currency?: boolean; percent?: boolean; horizontal?: boolean }): ChartOptions['scales'] {
  const mobile = isMobileChart();
  const currency = options?.currency !== false;
  const percent = options?.percent ?? false;
  const horizontal = options?.horizontal ?? false;

  const valueTicks = {
    font: { ...FONT, size: mobile ? 9 : 11 },
    color: CHART_COLORS.muted,
    padding: 6,
    maxTicksLimit: mobile ? 4 : 6,
    callback: (v: string | number) =>
      percent ? `${Number(v)}%` : currency ? formatCurrency(Number(v)) : String(v),
  };

  const categoryTicks = {
    maxRotation: mobile ? 35 : 0,
    minRotation: 0,
    autoSkip: true,
    maxTicksLimit: mobile ? 5 : 14,
    font: { ...FONT, size: mobile ? 9 : 11 },
    color: CHART_COLORS.muted,
    padding: 4,
  };

  if (horizontal) {
    return {
      x: {
        grid: { color: CHART_COLORS.grid },
        border: { display: false },
        ticks: valueTicks,
        grace: '5%',
      },
      y: {
        grid: { display: false },
        border: { display: false },
        ticks: categoryTicks,
      },
    };
  }

  return {
    x: {
      grid: { display: false },
      border: { display: false },
      ticks: categoryTicks,
    },
    y: {
      grid: { color: CHART_COLORS.grid },
      border: { display: false },
      ticks: valueTicks,
      grace: '8%',
    },
  };
}

function baseAnimation(): ChartOptions['animation'] {
  return { duration: isMobileChart() ? 350 : 550, easing: 'easeOutQuart' };
}

const BAR_DATASET_DEFAULTS = {
  borderRadius: 6,
  borderSkipped: false,
  maxBarThickness: 52,
  barPercentage: 0.72,
  categoryPercentage: 0.82,
};

export function barChartOptions(title: string, horizontal = false): ChartOptions {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    animation: baseAnimation(),
    layout: baseLayout(),
    plugins: {
      ...baseLegend(false),
      title: { display: false },
      tooltip: {
        ...baseTooltip(),
        callbacks: {
          label: (ctx) => currencyTooltipLabel(
            ctx.dataset.label ?? '',
            parsedAxisValue(ctx, horizontal ? 'x' : 'y')
          ),
        },
      },
    },
    scales: baseScales({ horizontal }),
  };
}

export function sparklineChartOptions(): ChartOptions {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400, easing: 'easeOutQuart' },
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4, right: 6, bottom: 4, left: 4 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...baseTooltip(),
        callbacks: {
          title: (items) => items[0]?.label ?? '',
          label: (ctx) => currencyTooltipLabel(ctx.dataset.label ?? '', parsedAxisValue(ctx, 'y')),
        },
      },
    },
    scales: {
      x: { display: false },
      y: { display: false },
    },
    elements: {
      point: { radius: 0, hoverRadius: 4, hitRadius: 16 },
      line: { tension: 0.4, borderWidth: 2 },
    },
  };
}

export function inlineBarChartOptions(): ChartOptions {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250, easing: 'easeOutQuart' },
    layout: { padding: { top: 0, right: 2, bottom: 0, left: 0 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...baseTooltip(),
        callbacks: {
          label: (ctx) => currencyTooltipLabel(ctx.dataset.label ?? '', parsedAxisValue(ctx, 'y')),
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: {
          font: { size: 9 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 5,
          color: CHART_COLORS.muted,
          padding: 0,
        },
      },
      y: {
        display: false,
        grid: { display: false },
        border: { display: false },
      },
    },
  };
}

export function groupedBarChartOptions(title: string): ChartOptions {
  return {
    ...barChartOptions(title),
    plugins: {
      ...barChartOptions(title).plugins,
      ...baseLegend(true),
    },
  };
}

export function scatterChartOptions(xLabel: string, yLabel: string, xCurrency = false, yCurrency = false, yPercent = false): ChartOptions {
  const mobile = isMobileChart();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: baseAnimation(),
    layout: baseLayout(),
    plugins: {
      ...baseLegend(false),
      title: { display: false },
      tooltip: {
        ...baseTooltip(),
        callbacks: {
          label: (ctx) => {
            const raw = ctx.raw as { x?: number; y?: number } | undefined;
            const x = Number(raw?.x);
            const y = Number(raw?.y);
            const xStr = xCurrency ? formatCurrency(x) : String(Number.isFinite(x) ? x : '—');
            const yStr = yCurrency
              ? formatCurrency(y)
              : yPercent
                ? Number.isFinite(y) ? `${y.toFixed(1)}%` : '—'
                : String(Number.isFinite(y) ? y : '—');
            return `${xLabel}: ${xStr}  ·  ${yLabel}: ${yStr}`;
          },
          title: (items) => (items[0]?.dataset?.label ?? ''),
        },
      },
    },
    scales: {
      x: {
        grid: { color: CHART_COLORS.grid },
        border: { display: false },
        title: {
          display: !mobile,
          text: xLabel,
          font: { ...FONT, size: 11 },
          color: CHART_COLORS.muted,
          padding: { top: 4 },
        },
        ticks: {
          font: { ...FONT, size: mobile ? 9 : 11 },
          color: CHART_COLORS.muted,
          maxTicksLimit: mobile ? 5 : 8,
          callback: (v) => xCurrency ? formatCurrency(Number(v)) : String(v),
        },
      },
      y: {
        grid: { color: CHART_COLORS.grid },
        border: { display: false },
        title: {
          display: !mobile,
          text: yLabel,
          font: { ...FONT, size: 11 },
          color: CHART_COLORS.muted,
          padding: { bottom: 4 },
        },
        ticks: {
          font: { ...FONT, size: mobile ? 9 : 11 },
          color: CHART_COLORS.muted,
          maxTicksLimit: 5,
          callback: (v) => yCurrency ? formatCurrency(Number(v)) : yPercent ? `${Number(v)}%` : String(v),
        },
        grace: '10%',
      },
    },
    elements: {
      point: { radius: mobile ? 4 : 5, hoverRadius: 7, hitRadius: 10 },
    },
  };
}

export function comboChartOptions(title: string): ChartOptions {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    animation: baseAnimation(),
    layout: baseLayout(),
    plugins: {
      ...baseLegend(true),
      title: { display: false },
      tooltip: {
        ...baseTooltip(),
        callbacks: {
          label: (ctx) => currencyTooltipLabel(ctx.dataset.label ?? '', parsedAxisValue(ctx, 'y')),
        },
      },
    },
    scales: baseScales(),
  };
}

export function lineChartOptions(title: string, percent = false): ChartOptions {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    animation: baseAnimation(),
    layout: baseLayout(),
    plugins: {
      ...baseLegend(false),
      title: { display: false },
      tooltip: {
        ...baseTooltip(),
        callbacks: {
          label: (ctx) => percent
            ? percentTooltipLabel(ctx.dataset.label ?? '', parsedAxisValue(ctx, 'y'))
            : currencyTooltipLabel(ctx.dataset.label ?? '', parsedAxisValue(ctx, 'y')),
        },
      },
    },
    scales: baseScales({ percent }),
    elements: {
      point: { radius: isMobileChart() ? 2 : 3, hoverRadius: 5, hitRadius: 12 },
      line: { tension: 0.35, borderWidth: 2.5 },
    },
  };
}

export function countBarChartOptions(title: string): ChartOptions {
  return {
    ...barChartOptions(title),
    plugins: {
      ...barChartOptions(title).plugins,
      tooltip: {
        ...baseTooltip(),
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${parsedAxisValue(ctx, 'y') || 0} trades`,
        },
      },
    },
    scales: baseScales({ currency: false }),
  };
}

export function doughnutChartOptions(title: string): ChartOptions<'doughnut'> {
  const mobile = isMobileChart();
  return {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '62%',
    animation: { duration: mobile ? 350 : 550, easing: 'easeOutQuart' },
    layout: { padding: { top: 4, right: 8, bottom: 0, left: 4 } },
    plugins: {
      ...baseLegend(true),
      title: { display: false },
      tooltip: {
        ...baseTooltip(),
        callbacks: {
          label: (ctx) => {
            const total = (ctx.dataset.data as number[]).reduce((a, b) => a + b, 0);
            const pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : '0';
            return `${ctx.label}: ${ctx.parsed.toLocaleString()} (${pct}%)`;
          },
        },
      },
    },
  };
}

export function pieChartOptions(title: string): ChartOptions<'pie'> {
  const mobile = isMobileChart();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: mobile ? 350 : 550, easing: 'easeOutQuart' },
    layout: { padding: { top: 4, right: 8, bottom: 0, left: 4 } },
    plugins: {
      title: { display: false },
      legend: {
        display: true,
        position: mobile ? 'bottom' : 'right',
        align: 'center',
        labels: {
          boxWidth: 10,
          boxHeight: 10,
          padding: mobile ? 10 : 14,
          font: { ...FONT, size: mobile ? 10 : 11 },
          color: CHART_COLORS.muted,
          usePointStyle: true,
        },
      },
      tooltip: {
        ...baseTooltip(),
        callbacks: {
          label: (ctx) => {
            const total = (ctx.dataset.data as number[]).reduce((a, b) => a + b, 0);
            const pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : '0';
            return `${ctx.label}: ${formatCurrency(Number(ctx.parsed))} (${pct}%)`;
          },
        },
      },
    },
  };
}

export function withDecimation(config: ChartConfiguration): ChartConfiguration {
  if (config.type !== 'line' && config.type !== 'bar') {
    return config;
  }
  return {
    ...config,
    data: config.data
      ? {
          ...config.data,
          datasets: config.data.datasets?.map((ds) => ({ ...ds })),
        }
      : config.data,
    options: {
      ...config.options,
      plugins: {
        ...config.options?.plugins,
        decimation: {
          enabled: true,
          algorithm: 'lttb',
          samples: 60,
        },
      },
    },
  };
}

export function buildPnLBarDataset(label: string, values: number[]) {
  return {
    label,
    data: values,
    backgroundColor: values.map((v) => pnlColor(v)),
    hoverBackgroundColor: values.map((v) => pnlColor(v, 1)),
    ...BAR_DATASET_DEFAULTS,
  };
}

/**
 * Draw compact currency labels at the end of each bar (right for gains, left for losses
 * on horizontal charts; above/below on vertical).
 * Dataset may set `labelEveryPoint: false` (default true) or `labelIndices: number[]`
 * to limit which bars get a marker.
 */
export const currencyBarLabelPlugin: Plugin<'bar'> = {
  id: 'currencyBarLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const mobile = isMobileChart();
    const horizontal = chart.options.indexAxis === 'y';

    ctx.save();
    ctx.font = `700 ${mobile ? 10 : 12}px Inter, system-ui, sans-serif`;

    chart.data.datasets.forEach((dataset, datasetIndex) => {
      if (dataset.type && dataset.type !== 'bar') return;
      const meta = chart.getDatasetMeta(datasetIndex);
      if (meta.hidden) return;

      const extras = dataset as {
        labelEveryPoint?: boolean;
        labelIndices?: number[];
      };
      const labelIndices = extras.labelIndices
        ? new Set(extras.labelIndices)
        : null;
      const labelEvery = extras.labelEveryPoint !== false && !labelIndices;

      meta.data.forEach((element, i) => {
        if (labelIndices && !labelIndices.has(i)) return;
        if (!labelEvery && !labelIndices) return;

        const raw = Number(Array.isArray(dataset.data) ? dataset.data[i] : NaN);
        if (!Number.isFinite(raw) || raw === 0) return;

        // Skip unchanged running extremes unless explicitly listed.
        if (!labelIndices && extras.labelEveryPoint === false) {
          const prev = Number(Array.isArray(dataset.data) ? dataset.data[i - 1] : NaN);
          if (i > 0 && Number.isFinite(prev) && prev === raw) return;
        }

        const bar = element as unknown as { x: number; y: number; base?: number };
        const signed = formatCurrency(raw);
        const compact = `${raw >= 0 ? '+' : '−'}${formatCompactCurrency(raw)}`;
        const text = mobile || Math.abs(raw) >= 1000 ? compact : signed;
        const color = raw >= 0 ? CHART_COLORS.success : CHART_COLORS.danger;

        ctx.fillStyle = color;
        if (horizontal) {
          const pointsRight = bar.x >= (bar.base ?? bar.x);
          ctx.textAlign = pointsRight ? 'left' : 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, bar.x + (pointsRight ? 6 : -6), bar.y);
        } else {
          const pointsUp = bar.y <= (bar.base ?? bar.y);
          ctx.textAlign = 'center';
          ctx.textBaseline = pointsUp ? 'bottom' : 'top';
          ctx.fillText(text, bar.x, bar.y + (pointsUp ? -6 : 6));
        }
      });
    });

    ctx.restore();
  },
};

/** Horizontal diverging P&amp;L bar options with room for end labels. */
export function divergingPnLBarOptions(): ChartOptions {
  const base = barChartOptions('', true);
  return {
    ...base,
    indexAxis: 'y',
    layout: {
      padding: { top: 8, right: 56, bottom: 4, left: 56 },
    },
    plugins: {
      ...base.plugins,
      legend: { display: false },
    },
  };
}

/**
 * Line dataset whose fill and stroke flip colour at zero, so a drawdown reads red and a
 * profit reads green within the same series.
 */
export function buildZeroSplitLineDataset(label: string, values: number[]) {
  return {
    label,
    data: values,
    borderColor: CHART_COLORS.success,
    fill: {
      target: { value: 0 },
      above: 'rgba(16,185,129,0.14)',
      below: 'rgba(239,68,68,0.14)',
    },
    segment: {
      borderColor: (ctx: { p0: { parsed: { y: number } }; p1: { parsed: { y: number } } }) =>
        ctx.p0.parsed.y < 0 || ctx.p1.parsed.y < 0 ? CHART_COLORS.danger : CHART_COLORS.success,
    },
    tension: 0.35,
    borderWidth: 2.5,
    pointBackgroundColor: '#fff',
    pointBorderColor: (ctx: { parsed?: { y: number } }) =>
      (ctx.parsed?.y ?? 0) < 0 ? CHART_COLORS.danger : CHART_COLORS.success,
    pointBorderWidth: 2,
    pointRadius: isMobileChart() ? 2 : 3,
    pointHoverRadius: 5,
  };
}

export function buildLineDataset(
  label: string,
  values: number[],
  color: string,
  fillColor?: string
) {
  return {
    label,
    data: values,
    borderColor: color,
    backgroundColor: fillColor ?? 'transparent',
    fill: !!fillColor,
    tension: 0.35,
    borderWidth: 2.5,
    pointBackgroundColor: '#fff',
    pointBorderColor: color,
    pointBorderWidth: 2,
    pointRadius: isMobileChart() ? 2 : 3,
    pointHoverRadius: 5,
  };
}

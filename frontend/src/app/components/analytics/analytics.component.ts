import {
  Component,
  inject,
  computed,
  signal,
  HostListener,
  OnInit,
} from '@angular/core';
import { CommonModule, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ChartConfiguration } from 'chart.js';
import { ReportStateService } from '../../services/report-state.service';
import { FilteredStockService } from '../../services/filtered-stock.service';
import { LazyTradeLoaderService } from '../../services/lazy-trade-loader.service';
import { AnalysisService } from '../../services/analysis.service';
import { TRADE_TYPE_LABELS, TradeType } from '../../models/trade.models';
import { formatCompactCurrency, formatCurrency, formatDate, pnlClass } from '../../utils/format.utils';
import { holdingsTotals } from '../../utils/holdings.utils';
import { stockIdentityKey } from '../../utils/stock-identity.utils';
import { isFullReportDateRange } from '../../utils/filter-stock-profiles.utils';
import {
  CHART_COLORS,
  abbreviateLabel,
  barChartOptions,
  comboChartOptions,
  groupedBarChartOptions,
  lineChartOptions,
  countBarChartOptions,
  doughnutChartOptions,
  scatterChartOptions,
  baseLegendPublic,
  withDecimation,
  isMobileChart,
  buildPnLBarDataset,
  buildLineDataset,
  buildZeroSplitLineDataset,
} from '../../utils/chart-theme';
import { FilterPanelComponent } from '../shared/filter-panel/filter-panel.component';
import { TradeTypeFilterComponent } from '../shared/trade-type-filter/trade-type-filter.component';
import { DateRangeFilterComponent } from '../shared/date-range-filter/date-range-filter.component';
import { ChartCardComponent } from '../shared/chart-card/chart-card.component';
import { ReportHistoryComponent } from '../shared/report-history/report-history.component';
import { HeatmapComponent } from '../heatmap/heatmap.component';
import { ExpandableStocksTableComponent } from '../shared/expandable-stocks-table/expandable-stocks-table.component';
import { StockScenarioPanelComponent } from '../shared/stock-scenario-panel/stock-scenario-panel.component';
import { TierSummaryBarComponent } from '../shared/tier-summary-bar/tier-summary-bar.component';
import { HoldingsTableComponent } from '../shared/holdings-table/holdings-table.component';
import {
  StockFilterRule,
  filterStocksByRules,
} from '../../utils/stock-scenario.utils';
import {
  CalendarBucket,
  aggregateByWeekday,
  aggregateByDayOfMonth,
  avgNetPerTrade,
  heatClass,
  pickExtremeBucket,
  pickExtremePeriod,
} from '../../utils/analytics-insights.utils';
import {
  currentMonthMarketDays,
  type MarketDayInfo,
} from '../../utils/market-calendar.utils';
import {
  aggregateDayOfMonthFromDaily,
  aggregateWeekdayFromDaily,
  filterDailyAnalytics,
} from '../../utils/analytics-aggregation.utils';
import { ErrorBannerComponent } from '../shared/error-banner/error-banner.component';

/** Calendar heatmap scope: every date, or only the days the market actually traded. */
type CalendarSessionFilter = 'all' | 'open';

/** Stocks tab: show every stock, or only those in profit / loss on net P&L. */
type StockPnLFilter = 'all' | 'profitable' | 'losing';

type AnalyticsTab =
  | 'overview'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'stocks'
  | 'heatmap'
  | 'holdings'
  | 'costs';

@Component({
  selector: 'app-analytics',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NgTemplateOutlet,
    RouterLink,
    FilterPanelComponent,
    TradeTypeFilterComponent,
    DateRangeFilterComponent,
    ChartCardComponent,
    ReportHistoryComponent,
    ExpandableStocksTableComponent,
    StockScenarioPanelComponent,
    TierSummaryBarComponent,
    HoldingsTableComponent,
    HeatmapComponent,
    ErrorBannerComponent,
  ],
  templateUrl: './analytics.component.html',
  styles: `
    .analytics-hero {
      @apply relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-5 text-white shadow-lg sm:p-6;
    }
    .analytics-kpi {
      @apply rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 backdrop-blur-sm;
    }
    .analytics-kpi-label {
      @apply text-[10px] font-semibold uppercase tracking-wider text-slate-400;
    }
    .analytics-kpi-value {
      @apply mt-1 text-lg font-bold tabular-nums sm:text-xl;
    }
    .insight-card {
      @apply rounded-xl border border-slate-200 bg-white p-4 shadow-sm;
    }
    .insight-card-best {
      @apply border-emerald-200 bg-emerald-50/40;
    }
    .insight-card-worst {
      @apply border-red-200 bg-red-50/40;
    }
    .heat-cell {
      @apply flex min-h-[2.75rem] flex-col items-center justify-center overflow-hidden rounded-lg border border-slate-200/80 px-0.5 py-1 text-center transition;
    }
    /* Grayscale rather than a colour override, so it wins regardless of the heat class applied. */
    .heat-session-muted {
      @apply border-dashed border-slate-300 opacity-40 grayscale;
    }
    .overview-calendar-cell {
      @apply min-h-[3.35rem] gap-0.5 px-0.5 py-1.5 sm:min-h-[5rem] sm:px-2 sm:py-2.5;
    }
    .overview-weekday-cell {
      @apply min-h-[3.75rem] gap-0.5 px-0.5 py-1.5 sm:min-h-[6rem] sm:px-3 sm:py-3.5;
    }
    .heat-pnl {
      @apply max-w-full truncate text-[10px] font-semibold tabular-nums leading-none tracking-tight lg:text-[11px] lg:leading-tight;
    }
    .heat-day {
      @apply text-[10px] font-bold leading-none text-current sm:text-sm;
    }
    .heat-neutral { @apply bg-slate-50 text-slate-400; }
    .heat-pos-soft { @apply bg-emerald-50 text-emerald-700; }
    .heat-pos-mid { @apply bg-emerald-100 text-emerald-800; }
    .heat-pos-strong { @apply bg-emerald-200 text-emerald-900; }
    .heat-neg-soft { @apply bg-red-50 text-red-700; }
    .heat-neg-mid { @apply bg-red-100 text-red-800; }
    .heat-neg-strong { @apply bg-red-200 text-red-900; }
    .stock-table th {
      @apply px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500;
    }
    .stock-table td {
      @apply px-3 py-2.5 text-sm tabular-nums;
    }
    .stock-table tbody tr {
      @apply border-t border-slate-100 transition hover:bg-slate-50/80;
    }
  `,
})
export class AnalyticsComponent implements OnInit {
  readonly state = inject(ReportStateService);
  readonly filteredStocks = inject(FilteredStockService);
  readonly lazyTrades = inject(LazyTradeLoaderService);
  private analysisSvc = inject(AnalysisService);
  readonly hiddenTradeTypes: TradeType[] = ['mtf'];
  readonly formatCurrency = formatCurrency;
  readonly formatCompactCurrency = formatCompactCurrency;
  readonly formatDate = formatDate;
  readonly pnlClass = pnlClass;
  readonly tradeTypeLabels = TRADE_TYPE_LABELS;
  readonly tabs: { id: AnalyticsTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'stocks', label: 'Stocks' },
    { id: 'daily', label: 'Daily' },
    { id: 'weekly', label: 'Weekly' },
    { id: 'monthly', label: 'Monthly' },
    { id: 'heatmap', label: 'Heatmap' },
    { id: 'holdings', label: 'Holdings' },
    { id: 'costs', label: 'Costs' },
  ];
  readonly heatClass = heatClass;
  readonly avgNetPerTrade = avgNetPerTrade;
  /** Closed days are shown as disabled cells rather than as their own filter. */
  readonly calendarSessionFilters: { id: CalendarSessionFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'open', label: 'Open' },
  ];
  readonly stockPnLFilters: { id: StockPnLFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'profitable', label: 'Profitable' },
    { id: 'losing', label: 'Losing' },
  ];

  private chartVersion = signal(0);
  winRateShowDots = signal(false);
  activeTab = signal<AnalyticsTab>('overview');

  analysis = computed(() => this.state.analysis());
  chargeRatio = computed(() => this.analysis()?.summary.chargeRatio ?? 0);

  async ngOnInit(): Promise<void> {
    // Aggregate-first: profiles + daily analytics. Trades load on day/stock expand.
    await this.state.ensureLoadedFromFirebase();
  }

  setTab(tab: AnalyticsTab): void {
    this.activeTab.set(tab);
    this.chartVersion.update((v) => v + 1);
  }

  selectedDate = signal<string | null>(null);

  /** Click a date to open its per-stock breakdown; clicking the open one closes it. */
  toggleDate(period: string): void {
    const next = this.selectedDate() === period ? null : period;
    this.selectedDate.set(next);
    if (next) {
      void this.loadSelectedDayTrades(next);
    }
  }

  private async loadSelectedDayTrades(period: string): Promise<void> {
    const report = this.state.report();
    const clientCode = report?.summary.clientCode;
    if (!clientCode || !report) return;
    await this.lazyTrades.loadForPeriod(
      clientCode,
      period,
      'daily',
      report,
      this.state.analysisOptions()
    );
  }

  selectedDay = computed(
    () => this.analysis()?.daily.find((d) => d.period === this.selectedDate()) ?? null
  );

  isSelectedDayLoading = computed(() => {
    const date = this.selectedDate();
    if (!date) return false;
    return this.lazyTrades.isLoading(this.lazyTrades.cacheKeyForPeriod('daily', date));
  });

  /** Same per-stock rows the dashboard shows, narrowed to the selected day's trades. */
  selectedDateStocks = computed(() => {
    const date = this.selectedDate();
    if (!date) return [];

    const dayTrades = this.selectedDay()?.trades ?? [];
    if (dayTrades.length) {
      return this.analysisSvc.aggregateByStock(dayTrades, this.chargeRatio());
    }

    const trades = this.lazyTrades.tradesForKey(
      this.lazyTrades.cacheKeyForPeriod('daily', date)
    );
    if (!trades.length) return [];
    return this.analysisSvc.aggregateByStock(trades, this.chargeRatio());
  });

  /** Stock summaries for charts — filtered query with fallback to analysis stocks. */
  visibleStocks = computed(() => {
    const filtered = this.filteredStocks.stocks();
    if (filtered.length) return filtered;
    return this.analysis()?.stocks ?? [];
  });

  stockPnLFilter = signal<StockPnLFilter>('all');
  stockFilterRules = signal<StockFilterRule[]>([]);
  scenarioPanelOpen = signal(false);
  stockSearchQuery = signal('');

  setStockPnLFilter(id: StockPnLFilter): void {
    this.stockPnLFilter.set(id);
  }

  /** Stocks tab table rows — All / Profitable / Losing on net P&L, then scenario + search. */
  stocksTabRows = computed(() => {
    let stocks = this.visibleStocks();
    const filter = this.stockPnLFilter();
    if (filter === 'profitable') stocks = stocks.filter((stock) => stock.netPnL > 0);
    else if (filter === 'losing') stocks = stocks.filter((stock) => stock.netPnL < 0);
    stocks = filterStocksByRules(stocks, this.stockFilterRules());
    const q = this.stockSearchQuery().trim().toLowerCase();
    if (q) {
      stocks = stocks.filter((stock) => {
        const haystack = [stock.stockName, stock.isin, stock.symbol]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    return stocks;
  });

  stocksTabSummary = computed(() => {
    const stocks = this.stocksTabRows();
    if (!stocks.length) return null;
    const tradeCount = stocks.reduce((sum, s) => sum + s.tradeCount, 0);
    const winningTrades = stocks.reduce(
      (sum, s) => sum + Math.round(s.tradeCount * ((s.winRate ?? 0) / 100)),
      0
    );
    return {
      stockCount: stocks.length,
      tradeCount,
      realisedPnL: stocks.reduce((sum, s) => sum + s.realisedPnL, 0),
      allocatedCharges: stocks.reduce((sum, s) => sum + s.allocatedCharges, 0),
      netPnL: stocks.reduce((sum, s) => sum + s.netPnL, 0),
      winRate: tradeCount ? (winningTrades / tradeCount) * 100 : 0,
      chargesLink: true,
    };
  });

  hasStockSearch(): boolean {
    return this.stockSearchQuery().trim().length > 0;
  }

  clearStockSearch(): void {
    this.stockSearchQuery.set('');
  }

  holdings = computed(() => this.state.report()?.unrealisedHoldings ?? []);
  holdingsSummary = computed(() => {
    const holdings = this.holdings();
    if (!holdings.length) return null;
    return holdingsTotals(holdings);
  });

  holdingsChartConfig = computed(() => {
    this.chartVersion();
    const holdings = [...this.holdings()].sort(
      (a, b) => Math.abs(b.unrealisedPnL) - Math.abs(a.unrealisedPnL)
    );
    if (!holdings.length) return null;
    const mobile = isMobileChart();
    return {
      type: 'bar' as const,
      data: {
        labels: holdings.map((h) => abbreviateLabel(h.stockName, mobile ? 14 : 22)),
        datasets: [buildPnLBarDataset('Unrealised P&L', holdings.map((h) => h.unrealisedPnL))],
      },
      options: barChartOptions('', true),
    };
  });

  weekdayBuckets = computed(() => {
    const trades = this.analysis()?.filteredTrades ?? [];
    if (trades.length) return aggregateByWeekday(trades, this.chargeRatio());
    const daily = filterDailyAnalytics(
      this.state.report()?.dailyAnalytics ?? [],
      this.state.analysisOptions()
    );
    return aggregateWeekdayFromDaily(daily);
  });

  dayOfMonthBuckets = computed(() => {
    const trades = this.analysis()?.filteredTrades ?? [];
    if (trades.length) return aggregateByDayOfMonth(trades, this.chargeRatio());
    const daily = filterDailyAnalytics(
      this.state.report()?.dailyAnalytics ?? [],
      this.state.analysisOptions()
    );
    return aggregateDayOfMonthFromDaily(daily);
  });

  bestWeekday = computed(() => pickExtremeBucket(this.weekdayBuckets(), 'best', 2));
  worstWeekday = computed(() => pickExtremeBucket(this.weekdayBuckets(), 'worst', 2));
  bestDayOfMonth = computed(() => pickExtremeBucket(this.dayOfMonthBuckets(), 'best', 2));
  worstDayOfMonth = computed(() => pickExtremeBucket(this.dayOfMonthBuckets(), 'worst', 2));
  bestWeek = computed(() => pickExtremePeriod(this.analysis()?.weekly ?? [], 'best'));
  worstWeek = computed(() => pickExtremePeriod(this.analysis()?.weekly ?? [], 'worst'));
  bestMonth = computed(() => pickExtremePeriod(this.analysis()?.monthly ?? [], 'best'));
  worstMonth = computed(() => pickExtremePeriod(this.analysis()?.monthly ?? [], 'worst'));

  weekdayMaxAbs = computed(() =>
    Math.max(...this.weekdayBuckets().map((b) => Math.abs(b.netPnL)), 1)
  );

  dayOfMonthMaxAbs = computed(() =>
    Math.max(
      ...this.dayOfMonthBuckets().filter((b) => b.tradeCount).map((b) => Math.abs(b.netPnL)),
      1
    )
  );

  /**
   * Day-of-month buckets split into profitable vs losing dates for heatmap counts. Dates the
   * session filter greys out are left out, so the counts always describe the cells on screen.
   */
  calendarDayOutcomes = computed(() => {
    const traded = this.dayOfMonthBuckets().filter(
      (bucket) => bucket.tradeCount && !this.isCalendarSessionMuted(bucket.key)
    );
    const byDay = (a: { key: string }, b: { key: string }) => Number(a.key) - Number(b.key);
    return {
      success: traded.filter((bucket) => bucket.netPnL > 0).sort(byDay),
      failed: traded.filter((bucket) => bucket.netPnL < 0).sort(byDay),
    };
  });

  calendarSessionFilter = signal<CalendarSessionFilter>('all');

  currentMonthSessions = computed(() => {
    const map = new Map<number, MarketDayInfo>();
    for (const day of currentMonthMarketDays()) {
      map.set(day.day, day);
    }
    return map;
  });

  calendarSessionCaption = computed(() => {
    const days = [...this.currentMonthSessions().values()];
    if (!days.length) return '';
    const open = days.filter((day) => day.session === 'open').length;
    const closed = days.length - open;
    const label = new Date(`${days[0].iso}T12:00:00`).toLocaleDateString('en-IN', {
      month: 'short',
      year: 'numeric',
    });
    return `${label} · ${open} open · ${closed} closed`;
  });

  setCalendarSessionFilter(id: CalendarSessionFilter): void {
    this.calendarSessionFilter.set(id);
  }

  /** True for dates the market was shut, once the user has narrowed the grid to open days. */
  isCalendarSessionMuted(dayKey: string): boolean {
    if (this.calendarSessionFilter() === 'all') return false;
    const info = this.currentMonthSessions().get(Number(dayKey));
    return info ? info.session !== 'open' : true;
  }

  calendarCellTitle(bucket: CalendarBucket): string {
    const pnl = bucket.tradeCount
      ? `${bucket.label}: ${formatCurrency(bucket.netPnL)}`
      : `${bucket.label}: no trades`;
    const session = this.currentMonthSessions().get(Number(bucket.key));
    if (!session) return pnl;
    const status = session.session === 'open' ? 'Open' : 'Closed';
    return `${pnl} · ${status} this month (${session.reason})`;
  }

  sortedDaily = computed(() =>
    [...(this.analysis()?.daily ?? [])].sort((a, b) => a.period.localeCompare(b.period))
  );

  /** Newest first, so the most recent trading day is at the top of the list. */
  tradingDays = computed(() => [...this.sortedDaily()].reverse());

  topDailyWins = computed(() =>
    [...(this.analysis()?.daily ?? [])].sort((a, b) => b.netPnL - a.netPnL).slice(0, 5)
  );

  topDailyLosses = computed(() =>
    [...(this.analysis()?.daily ?? [])].sort((a, b) => a.netPnL - b.netPnL).slice(0, 5)
  );

  bestWorstTrades = computed(() => {
    const trades = this.analysis()?.filteredTrades ?? [];
    if (!trades.length) return { best: null, worst: null } as const;
    const best = trades.reduce((max, trade) => (trade.realisedPnL > max.realisedPnL ? trade : max), trades[0]);
    const worst = trades.reduce((min, trade) => (trade.realisedPnL < min.realisedPnL ? trade : min), trades[0]);
    return { best, worst } as const;
  });

  avgPnLPerOutcome = computed(() => {
    const trades = this.analysis()?.filteredTrades ?? [];
    if (trades.length) {
      const wins = trades.filter((t) => t.realisedPnL > 0);
      const losses = trades.filter((t) => t.realisedPnL < 0);
      const avgWinPerTrade = wins.length
        ? wins.reduce((sum, trade) => sum + trade.realisedPnL, 0) / wins.length
        : 0;
      const avgLossPerTrade = losses.length
        ? losses.reduce((sum, trade) => sum + trade.realisedPnL, 0) / losses.length
        : 0;
      return {
        avgWinPerTrade,
        avgLossPerTrade,
        winTrades: wins.length,
        lossTrades: losses.length,
      };
    }

    // Aggregate path: stock_profiles carry gross profit/loss for the full statement window.
    const report = this.state.report();
    const profiles = report?.stockProfiles ?? [];
    const opts = this.state.analysisOptions();
    const types = opts.tradeTypes ?? [];
    const typeFiltered = types.length > 0 && !types.includes('all');
    if (
      profiles.length &&
      report?.dateRange &&
      isFullReportDateRange(report.dateRange, opts) &&
      !typeFiltered
    ) {
      let grossProfit = 0;
      let grossLoss = 0;
      let winTrades = 0;
      let lossTrades = 0;
      for (const profile of profiles) {
        grossProfit += profile.grossProfit;
        grossLoss += profile.grossLoss;
        winTrades += profile.winningTrades;
        lossTrades += profile.losingTrades;
      }
      return {
        avgWinPerTrade: winTrades ? grossProfit / winTrades : 0,
        avgLossPerTrade: lossTrades ? grossLoss / lossTrades : 0,
        winTrades,
        lossTrades,
      };
    }

    return {
      avgWinPerTrade: 0,
      avgLossPerTrade: 0,
      winTrades: 0,
      lossTrades: 0,
    };
  });

  stockDayWinLossSummary = computed(() => {
    const trades = this.analysis()?.filteredTrades ?? [];
    const buckets = new Map<string, { date: string; stock: string; netPnL: number }>();
    for (const trade of trades) {
      const stockKey = stockIdentityKey(trade);
      const key = `${trade.sellDate}::${stockKey}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.netPnL += trade.realisedPnL;
      } else {
        buckets.set(key, { date: trade.sellDate, stock: trade.stockName, netPnL: trade.realisedPnL });
      }
    }

    let winningStockDays = 0;
    let losingStockDays = 0;
    let flatStockDays = 0;
    const byDateMap = new Map<string, { winning: number; losing: number; flat: number }>();

    for (const bucket of buckets.values()) {
      const dateEntry = byDateMap.get(bucket.date) ?? { winning: 0, losing: 0, flat: 0 };
      if (bucket.netPnL > 0) {
        winningStockDays++;
        dateEntry.winning++;
      } else if (bucket.netPnL < 0) {
        losingStockDays++;
        dateEntry.losing++;
      } else {
        flatStockDays++;
        dateEntry.flat++;
      }
      byDateMap.set(bucket.date, dateEntry);
    }

    const byDate = [...byDateMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, values]) => ({ date, ...values }));

    const stockDays = [...buckets.values()];
    const best = stockDays.length
      ? stockDays.reduce((max, stockDay) => (stockDay.netPnL > max.netPnL ? stockDay : max), stockDays[0])
      : null;
    const worst = stockDays.length
      ? stockDays.reduce((min, stockDay) => (stockDay.netPnL < min.netPnL ? stockDay : min), stockDays[0])
      : null;

    return {
      totalStockDays: buckets.size,
      winningStockDays,
      losingStockDays,
      flatStockDays,
      winRate: buckets.size ? (winningStockDays / buckets.size) * 100 : 0,
      byDate,
      best,
      worst,
    };
  });

  chartPeriodLabel = computed(() => {
    const p = this.state.chartPeriod();
    return p.charAt(0).toUpperCase() + p.slice(1);
  });

  dailyChartConfig = computed(() => {
    this.chartVersion();
    return this.buildPeriodChart();
  });

  dailyNetPnLChartConfig = computed(() => {
    this.chartVersion();
    const daily = [...(this.analysis()?.daily ?? [])].sort((a, b) => a.period.localeCompare(b.period));
    if (!daily.length) return null;
    const mobile = isMobileChart();

    let cumulative = 0;
    const cumData = daily.map((d) => { cumulative += d.netPnL; return cumulative; });
    const overallPositive = cumulative >= 0;
    const cumColor = overallPositive ? CHART_COLORS.success : CHART_COLORS.danger;
    const cumFill = overallPositive ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)';

    return withDecimation({
      type: 'line',
      data: {
        labels: daily.map((d) => abbreviateLabel(d.label, mobile ? 6 : 10)),
        datasets: [
          {
            label: 'Daily Net P&L',
            data: daily.map((d) => d.netPnL),
            borderColor: CHART_COLORS.secondary,
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.3,
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 4,
            order: 1,
          },
          {
            label: 'Cumulative',
            data: cumData,
            borderColor: cumColor,
            backgroundColor: cumFill,
            fill: true,
            tension: 0.4,
            borderWidth: 2.5,
            pointRadius: 0,
            pointHoverRadius: 4,
            order: 2,
          },
        ],
      },
      options: {
        ...lineChartOptions(''),
        plugins: {
          ...lineChartOptions('').plugins,
          ...baseLegendPublic(true),
        },
      },
    });
  });

  monthlyChartConfig = computed(() => {
    this.chartVersion();
    const monthly = this.analysis()?.monthly ?? [];
    if (!monthly.length) return null;
    const mobile = isMobileChart();
    return withDecimation({
      type: 'bar',
      data: {
        labels: monthly.map((d) => abbreviateLabel(d.label, mobile ? 8 : 14)),
        datasets: [buildPnLBarDataset('Net P&L', monthly.map((d) => d.netPnL))],
      },
      options: barChartOptions(''),
    });
  });

  weeklyChartConfig = computed(() => {
    this.chartVersion();
    const weekly = this.analysis()?.weekly ?? [];
    if (!weekly.length) return null;
    const mobile = isMobileChart();
    return withDecimation({
      type: 'bar',
      data: {
        labels: weekly.map((d) => abbreviateLabel(d.label, mobile ? 8 : 14)),
        datasets: [buildPnLBarDataset('Net P&L', weekly.map((d) => d.netPnL))],
      },
      options: barChartOptions(''),
    });
  });

  weekdayChartConfig = computed(() => {
    this.chartVersion();
    const buckets = this.weekdayBuckets().filter((b) => b.tradeCount > 0);
    if (!buckets.length) return null;
    return withDecimation({
      type: 'bar',
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [buildPnLBarDataset('Net P&L', buckets.map((b) => b.netPnL))],
      },
      options: barChartOptions(''),
    });
  });

  dayOfMonthChartConfig = computed(() => {
    this.chartVersion();
    const buckets = this.dayOfMonthBuckets().filter((b) => b.tradeCount > 0);
    if (!buckets.length) return null;
    const mobile = isMobileChart();
    return withDecimation({
      type: 'bar',
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [buildPnLBarDataset('Net P&L', buckets.map((b) => b.netPnL))],
      },
      options: {
        ...barChartOptions(''),
        scales: {
          ...barChartOptions('').scales,
          x: {
            ...barChartOptions('').scales?.['x'],
            ticks: { maxTicksLimit: mobile ? 10 : 16 },
          },
        },
      },
    });
  });

  cumulativeChartConfig = computed(() => {
    this.chartVersion();
    const periodData = this.state.chartPeriodData();
    if (!periodData.length) return null;
    let cumulative = 0;
    const cumData = periodData.map((d) => {
      cumulative += d.netPnL;
      return cumulative;
    });
    const mobile = isMobileChart();
    return withDecimation({
      type: 'line',
      data: {
        labels: periodData.map((d) => abbreviateLabel(d.label, mobile ? 8 : 14)),
        datasets: [buildZeroSplitLineDataset('Cumulative Net P&L', cumData)],
      },
      options: lineChartOptions(''),
    });
  });

  tradeVolumeChartConfig = computed(() => {
    this.chartVersion();
    const periodData = this.state.chartPeriodData();
    if (!periodData.length) return null;
    const mobile = isMobileChart();
    return withDecimation({
      type: 'bar',
      data: {
        labels: periodData.map((d) => abbreviateLabel(d.label, mobile ? 8 : 14)),
        datasets: [{
          label: 'Trades',
          data: periodData.map((d) => d.tradeCount),
          backgroundColor: CHART_COLORS.secondary,
          hoverBackgroundColor: '#4f46e5',
          borderRadius: 6,
          maxBarThickness: 48,
        }],
      },
      options: countBarChartOptions(''),
    });
  });

  winRateTrendChartConfig = computed(() => {
    this.chartVersion();
    const periodData = this.state.chartPeriodData().filter((d) => d.tradeCount > 0);
    if (!periodData.length) return null;
    const mobile = isMobileChart();
    const showDots = this.winRateShowDots();
    const labels = periodData.map((d) => abbreviateLabel(d.label, mobile ? 8 : 14));
    const netPnLValues = periodData.map((d) => d.netPnL);
    return withDecimation({
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            ...buildPnLBarDataset('Net P&L', netPnLValues),
            type: 'bar',
            yAxisID: 'yPnL',
            order: 2,
          },
          {
            ...buildLineDataset('Win Rate', periodData.map((d) => d.winRate), CHART_COLORS.primary),
            type: 'line',
            yAxisID: 'yWin',
            pointRadius: showDots ? (mobile ? 3 : 4) : 0,
            pointHoverRadius: 5,
            borderWidth: 2,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index' as const, intersect: false },
        animation: { duration: mobile ? 350 : 550, easing: 'easeOutQuart' },
        layout: { padding: { top: 4, right: 8, bottom: 0, left: 4 } },
        plugins: {
          ...baseLegendPublic(true),
          title: { display: false },
          tooltip: {
            backgroundColor: CHART_COLORS.ink,
            titleColor: '#f8fafc',
            bodyColor: '#e2e8f0',
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 1,
            titleFont: { size: 12, weight: 'bold' as const },
            bodyFont: { size: 12 },
            padding: 12,
            cornerRadius: 10,
            callbacks: {
              label: (ctx) => {
                const value = Number(ctx.parsed?.y);
                if (ctx.dataset.yAxisID === 'yWin') {
                  return Number.isFinite(value) ? `Win Rate: ${value.toFixed(1)}%` : 'Win Rate';
                }
                return `Net P&L: ${formatCurrency(value)}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              maxRotation: mobile ? 35 : 0,
              autoSkip: true,
              maxTicksLimit: mobile ? 5 : 14,
              font: { size: mobile ? 9 : 11 },
              color: CHART_COLORS.muted,
            },
          },
          yPnL: {
            position: 'left' as const,
            grid: { color: CHART_COLORS.grid },
            border: { display: false },
            ticks: {
              font: { size: mobile ? 9 : 11 },
              color: CHART_COLORS.muted,
              maxTicksLimit: 5,
              callback: (v) => formatCurrency(Number(v)),
            },
            grace: '8%',
          },
          yWin: {
            position: 'right' as const,
            grid: { display: false },
            border: { display: false },
            min: 0,
            max: 100,
            ticks: {
              font: { size: mobile ? 9 : 11 },
              color: CHART_COLORS.primary,
              maxTicksLimit: 5,
              callback: (v) => `${v}%`,
            },
          },
        },
      },
    });
  });

  pnlVsChargesChartConfig = computed(() => {
    this.chartVersion();
    const periodData = this.state.chartPeriodData();
    if (!periodData.length) return null;
    const mobile = isMobileChart();
    return withDecimation({
      type: 'bar',
      data: {
        labels: periodData.map((d) => abbreviateLabel(d.label, mobile ? 8 : 12)),
        datasets: [
          {
            label: 'Realised P&L',
            data: periodData.map((d) => d.realisedPnL),
            backgroundColor: CHART_COLORS.successSoft,
            borderRadius: 6,
            maxBarThickness: 40,
          },
          {
            label: 'Charges',
            data: periodData.map((d) => d.allocatedCharges),
            backgroundColor: CHART_COLORS.dangerSoft,
            borderRadius: 6,
            maxBarThickness: 40,
          },
        ],
      },
      options: groupedBarChartOptions(''),
    });
  });

  bottomStocksChartConfig = computed(() => {
    this.chartVersion();
    const stocks = [...this.visibleStocks()].sort((a, b) => a.netPnL - b.netPnL);
    const n = Math.min(this.state.topStocksCount(), stocks.length);
    const bottom = stocks.slice(0, n);
    if (!bottom.length) return null;
    const mobile = isMobileChart();
    return {
      type: 'bar' as const,
      data: {
        labels: bottom.map((s) => abbreviateLabel(s.stockName, mobile ? 16 : 24)),
        datasets: [buildPnLBarDataset('Net P&L', bottom.map((s) => s.netPnL))],
      },
      options: barChartOptions('', true),
    };
  });

  chargesChartConfig = computed(() => {
    this.chartVersion();
    const items = (this.analysis()?.charges.items ?? []).filter(
      (i) => i.label !== 'Total' && i.amount > 0
    );
    if (!items.length) return null;
    return {
      type: 'doughnut' as const,
      data: {
        labels: items.map((i) => abbreviateLabel(i.label, isMobileChart() ? 18 : 28)),
        datasets: [{
          data: items.map((i) => i.amount),
          backgroundColor: CHART_COLORS.palette,
          borderWidth: 2,
          borderColor: '#fff',
          hoverOffset: 6,
        }],
      },
      options: doughnutChartOptions(''),
    };
  });

  tradeTypeChartConfig = computed(() => {
    this.chartVersion();
    const trades = this.analysis()?.filteredTrades ?? [];
    const map = new Map<TradeType, number>();

    if (trades.length) {
      for (const t of trades) {
        map.set(t.tradeType, (map.get(t.tradeType) ?? 0) + 1);
      }
    } else {
      const rows = filterDailyAnalytics(
        this.state.report()?.dailyAnalytics ?? [],
        this.state.analysisOptions()
      );
      for (const row of rows) {
        map.set(row.tradeType, (map.get(row.tradeType) ?? 0) + row.tradeCount);
      }
    }

    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
    if (!entries.length) return null;
    return {
      type: 'doughnut' as const,
      data: {
        labels: entries.map(([t]) => this.tradeTypeLabels[t] || t),
        datasets: [{
          data: entries.map(([, c]) => c),
          backgroundColor: CHART_COLORS.palette,
          borderWidth: 2,
          borderColor: '#fff',
          hoverOffset: 6,
        }],
      },
      options: doughnutChartOptions(''),
    };
  });

  // ── Insights ─────────────────────────────────────────────────────────

  tradesVsPnLChartConfig = computed(() => {
    this.chartVersion();
    const stocks = this.visibleStocks();
    if (stocks.length < 2) return null;
    return {
      type: 'scatter' as const,
      data: {
        datasets: stocks.map((s) => ({
          label: abbreviateLabel(s.stockName, 20),
          data: [{ x: s.tradeCount, y: s.netPnL }],
          backgroundColor: s.netPnL >= 0 ? 'rgba(16,185,129,0.70)' : 'rgba(239,68,68,0.70)',
          borderColor: s.netPnL >= 0 ? CHART_COLORS.success : CHART_COLORS.danger,
          borderWidth: 1,
        })),
      },
      options: scatterChartOptions('Trades', 'Net P&L', false, true),
    };
  });

  holdingVsPnLChartConfig = computed(() => {
    this.chartVersion();
    const trades = this.analysis()?.filteredTrades ?? [];
    if (trades.length < 2) return null;
    const delivery = trades.filter((t) => t.holdingDays > 0);
    if (!delivery.length) return null;
    return {
      type: 'scatter' as const,
      data: {
        datasets: [{
          label: 'Trade',
          data: delivery.map((t) => ({ x: t.holdingDays, y: t.realisedPnL })),
          backgroundColor: delivery.map((t) => t.realisedPnL >= 0 ? 'rgba(16,185,129,0.60)' : 'rgba(239,68,68,0.60)'),
          borderWidth: 0,
        }],
      },
      options: scatterChartOptions('Holding Days', 'P&L', false, true),
    };
  });

  pnlDistributionChartConfig = computed(() => {
    this.chartVersion();
    const trades = this.analysis()?.filteredTrades ?? [];
    if (!trades.length) return null;
    const buckets = [
      { label: '<−5k', min: -Infinity, max: -5000 },
      { label: '−5k–−1k', min: -5000, max: -1000 },
      { label: '−1k–0', min: -1000, max: 0 },
      { label: '0–1k', min: 0, max: 1000 },
      { label: '1k–5k', min: 1000, max: 5000 },
      { label: '>5k', min: 5000, max: Infinity },
    ];
    const counts = buckets.map((b) =>
      trades.filter((t) => t.realisedPnL > b.min && t.realisedPnL <= b.max).length
    );
    return {
      type: 'bar' as const,
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [{
          label: 'Trades',
          data: counts,
          backgroundColor: buckets.map((_, i) => i < 3 ? 'rgba(239,68,68,0.80)' : 'rgba(16,185,129,0.80)'),
          borderRadius: 6,
          maxBarThickness: 48,
        }],
      },
      options: countBarChartOptions(''),
    };
  });

  winLossByDateChartConfig = computed(() => {
    this.chartVersion();
    const days = [...(this.analysis()?.daily ?? [])].sort((a, b) => a.period.localeCompare(b.period));
    if (!days.length) return null;
    const mobile = isMobileChart();
    return {
      type: 'bar' as const,
      data: {
        labels: days.map((d) => abbreviateLabel(d.label, mobile ? 8 : 14)),
        datasets: [
          {
            label: 'Winning Trades',
            data: days.map((d) => d.winningTrades),
            backgroundColor: 'rgba(16,185,129,0.82)',
            borderRadius: 4,
            maxBarThickness: 24,
          },
          {
            label: 'Losing Trades',
            data: days.map((d) => d.losingTrades),
            backgroundColor: 'rgba(239,68,68,0.82)',
            borderRadius: 4,
            maxBarThickness: 24,
          },
        ],
      },
      options: groupedBarChartOptions(''),
    };
  });

  winLossByStockDayDateChartConfig = computed(() => {
    this.chartVersion();
    const byDate = this.stockDayWinLossSummary().byDate;
    if (!byDate.length) return null;
    const mobile = isMobileChart();
    return {
      type: 'bar' as const,
      data: {
        labels: byDate.map((d) => abbreviateLabel(d.date, mobile ? 8 : 12)),
        datasets: [
          {
            label: 'Winning Stock-Days',
            data: byDate.map((d) => d.winning),
            backgroundColor: 'rgba(59,130,246,0.82)',
            borderRadius: 4,
            maxBarThickness: 24,
          },
          {
            label: 'Losing Stock-Days',
            data: byDate.map((d) => d.losing),
            backgroundColor: 'rgba(249,115,22,0.82)',
            borderRadius: 4,
            maxBarThickness: 24,
          },
        ],
      },
      options: groupedBarChartOptions(''),
    };
  });

  @HostListener('window:resize')
  onResize(): void {
    this.chartVersion.update((v) => v + 1);
  }

  onFiltersChanged(): void {
    this.chartVersion.update((v) => v + 1);
  }

  private buildPeriodChart(): ChartConfiguration | null {
    const periodData = this.state.chartPeriodData();
    if (!periodData.length) return null;
    const mobile = isMobileChart();
    return withDecimation({
      type: 'bar',
      data: {
        labels: periodData.map((d) => abbreviateLabel(d.label, mobile ? 8 : 14)),
        datasets: [
          {
            ...buildPnLBarDataset('Realised P&L', periodData.map((d) => d.realisedPnL)),
            order: 2,
          },
          {
            ...buildLineDataset(
              'Net P&L',
              periodData.map((d) => d.netPnL),
              CHART_COLORS.secondary
            ),
            type: 'line',
            order: 1,
          },
        ],
      },
      options: comboChartOptions(''),
    });
  }
}

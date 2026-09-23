import { Component, signal, computed, inject, effect, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ReportStateService } from '../../services/report-state.service';
import { LazyTradeLoaderService } from '../../services/lazy-trade-loader.service';
import { FilteredStockService } from '../../services/filtered-stock.service';
import { PageShellService } from '../../services/page-shell.service';
import { ClientAccountService, ClientAccount } from '../../services/client-account.service';
import { CustomStockListService } from '../../services/custom-stock-list.service';
import { FilterUrlService } from '../../services/filter-url.service';
import {
  PeriodBucket,
  StockSummary,
  Trade,
  TRADE_TYPE_LABELS,
  TradeType,
} from '../../models/trade.models';
import {
  formatCurrency,
  formatDate,
  formatPct,
  pnlClass,
} from '../../utils/format.utils';
import { groupTradesByStock, StockTradeGroup } from '../../utils/trade.utils';
import { summariseTradesByDay, TradeDaySummary } from '../../utils/trade-day-summary.utils';
import {
  tradeAllocatedCharge as allocatedChargeForTrade,
  tradeNetPnL as netPnLForTrade,
} from '../../utils/trade-charges.utils';
import { TradeTypeFilterComponent } from '../shared/trade-type-filter/trade-type-filter.component';
import { DateRangeFilterComponent } from '../shared/date-range-filter/date-range-filter.component';
import { HoldingsTableComponent } from '../shared/holdings-table/holdings-table.component';
import { ExpandableStocksTableComponent } from '../shared/expandable-stocks-table/expandable-stocks-table.component';
import { StockScenarioPanelComponent } from '../shared/stock-scenario-panel/stock-scenario-panel.component';
import { TierSummaryBarComponent } from '../shared/tier-summary-bar/tier-summary-bar.component';
import {
  StockFilterRule,
  filterStocksByRules,
} from '../../utils/stock-scenario.utils';
import { holdingsTotals, PnLBook } from '../../utils/holdings.utils';
import { normalizeSymbol } from '../../utils/upload-merge.utils';
import { stockIdentityKey } from '../../utils/stock-identity.utils';
import { FILTER_QUERY_KEYS, readWatchlistFilters } from '../../utils/filter-url.utils';

type PeriodColumnKey = 'period' | 'tradeCount' | 'totalBuyValue' | 'totalSellValue' | 'realisedPnL' | 'allocatedCharges' | 'netPnL' | 'winRate';

const DEFAULT_VISIBLE_PERIOD_COLUMNS: PeriodColumnKey[] = [
  'period', 'tradeCount', 'realisedPnL', 'allocatedCharges', 'netPnL', 'winRate',
];
type SortDir = 'asc' | 'desc';
type TabId = 'daily' | 'weekly' | 'monthly' | 'stocks' | 'holdings' | 'custom';
type StockColumnKey =
  | 'stockName'
  | 'tradeCount'
  | 'quantity'
  | 'buyValue'
  | 'sellValue'
  | 'realisedPnL'
  | 'realisedPnLPct'
  | 'allocatedCharges'
  | 'netPnL';

const DEFAULT_VISIBLE_STOCK_COLUMNS: StockColumnKey[] = [
  'stockName',
  'tradeCount',
  'quantity',
  'realisedPnL',
  'allocatedCharges',
  'netPnL',
];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    TradeTypeFilterComponent,
    DateRangeFilterComponent,
    HoldingsTableComponent,
    ExpandableStocksTableComponent,
    StockScenarioPanelComponent,
    TierSummaryBarComponent,
  ],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent implements OnInit {
  readonly state = inject(ReportStateService);
  readonly filteredStocks = inject(FilteredStockService);
  private pageShell = inject(PageShellService);
  private clientSvc = inject(ClientAccountService);
  readonly lazyTrades = inject(LazyTradeLoaderService);
  readonly customLists = inject(CustomStockListService);
  private route = inject(ActivatedRoute);
  private filterUrl = inject(FilterUrlService);
  readonly clients = signal<ClientAccount[]>([]);
  readonly tradeTypeLabels = TRADE_TYPE_LABELS;
  readonly formatCurrency = formatCurrency;
  readonly formatPct = formatPct;
  readonly formatDate = formatDate;
  readonly pnlClass = pnlClass;
  readonly groupTradesByStock = groupTradesByStock;

  private readonly _syncPageHeader = effect((onCleanup) => {
    const report = this.state.report();
    if (report) {
      this.pageShell.setHeader('Dashboard', report.summary.period);
    }
    onCleanup(() => this.pageShell.clearOverride());
  }, { allowSignalWrites: true });

  async ngOnInit(): Promise<void> {
    // Aggregate-first: stock_profiles + analytics_daily power the page.
    // Individual trades load on accordion expand via LazyTradeLoaderService.
    await this.state.ensureLoadedFromFirebase();
    this.clients.set(await this.clientSvc.listClients());
    const params = this.route.snapshot.queryParamMap;
    const wl = readWatchlistFilters(params);
    if (wl.book) this.book.set(wl.book);
    if (params.get('tab') === 'holdings') {
      this.book.set('holdings');
      this.activeTab.set('stocks');
    } else if (params.get('tab') === 'custom') {
      this.activeTab.set('custom');
      this.resetSortForTab('custom');
      const listId = params.get('list');
      if (listId) this.customLists.select(listId);
      void this.customLists.ensureLoaded();
    }
  }

  readonly bookTabs: { id: PnLBook; label: string }[] = [
    { id: 'realised', label: 'Realised' },
    { id: 'holdings', label: 'Unrealised' },
  ];

  book = signal<PnLBook>('realised');
  activeTab = signal<TabId>('stocks');
  sortColumn = signal('realisedPnL');
  sortDirection = signal<SortDir>('desc');
  expandedPeriod = signal<string | null>(null);
  expandedStock = signal<string | null>(null);
  expandedPerStock = signal<string | null>(null);
  expandedDayKey = signal<string | null>(null);
  stockColumnsPanelOpen = signal(false);
  stockScenarioPanelOpen = signal(false);
  periodColumnsPanelOpen = signal(false);
  stockFilterRules = signal<StockFilterRule[]>([]);
  stockSearchQuery = signal('');
  visibleStockColumns = signal<Set<StockColumnKey>>(new Set(DEFAULT_VISIBLE_STOCK_COLUMNS));
  visiblePeriodColumns = signal<Set<PeriodColumnKey>>(new Set(DEFAULT_VISIBLE_PERIOD_COLUMNS));

  readonly periodColumns: { key: PeriodColumnKey; label: string }[] = [
    { key: 'period', label: 'Period' },
    { key: 'tradeCount', label: 'Trades' },
    { key: 'totalBuyValue', label: 'Buy Value' },
    { key: 'totalSellValue', label: 'Sell Value' },
    { key: 'realisedPnL', label: 'P&L' },
    { key: 'allocatedCharges', label: 'Charges' },
    { key: 'netPnL', label: 'Net P&L' },
    { key: 'winRate', label: 'Win Rate' },
  ];

  readonly stockColumns: { key: StockColumnKey; label: string; required?: boolean }[] = [
    { key: 'stockName', label: 'Stock', required: true },
    { key: 'tradeCount', label: 'Trades' },
    { key: 'quantity', label: 'Qty' },
    { key: 'buyValue', label: 'Buy Value' },
    { key: 'sellValue', label: 'Sell Value' },
    { key: 'realisedPnL', label: 'P&L' },
    { key: 'realisedPnLPct', label: 'P&L %' },
    { key: 'allocatedCharges', label: 'Charges' },
    { key: 'netPnL', label: 'Net P&L' },
  ];

  readonly stockSortOptions: { key: StockColumnKey; label: string }[] = [
    { key: 'netPnL', label: 'Net P&L' },
    { key: 'realisedPnL', label: 'P&L' },
    { key: 'stockName', label: 'Stock name' },
    { key: 'tradeCount', label: 'Trades' },
    { key: 'quantity', label: 'Qty' },
    { key: 'allocatedCharges', label: 'Charges' },
  ];

  visibleStockColumnList = computed(() =>
    this.stockColumns.filter((col) => this.visibleStockColumns().has(col.key))
  );

  stockEmptyMessage = computed(() => {
    if (this.filteredStocks.loading()) {
      return 'Loading stocks for this date range…';
    }
    if (this.activeTab() === 'custom' && !this.customLists.lists().length && !this.customLists.listsLoading()) {
      return 'No custom lists yet. Create one to pick a subset of stocks.';
    }
    if (this.activeTab() === 'custom' && !this.customLists.selectedList()) {
      return 'Select or create a list to see stocks.';
    }
    if (this.hasStockSearch()) {
      return `No stocks match "${this.stockSearchQuery()}"`;
    }
    if (this.activeTab() === 'custom') {
      return 'None of the stocks in this list appear in the current filters.';
    }
    if (!this.stockFilterRules().some((rule) => rule.value.trim() !== '')) {
      return 'No stock data';
    }
    return 'No stocks match your scenario';
  });

  visibleTradeDetailColumns = computed(() =>
    this.visibleStockColumnList().filter((col) => col.key !== 'stockName')
  );

  chargeRatio = computed(() => this.analysis()?.summary.chargeRatio ?? 0);

  visiblePeriodColumnList = computed(() =>
    this.periodColumns.filter((col) => this.visiblePeriodColumns().has(col.key))
  );

  analysis = computed(() => this.state.analysis());

  holdings = computed(() => this.state.report()?.unrealisedHoldings ?? []);
  holdingsSummary = computed(() => {
    const holdings = this.holdings();
    if (!holdings.length) return null;
    return holdingsTotals(holdings);
  });

  stockDayWinRateSummary = computed(() => {
    const trades = this.analysis()?.filteredTrades ?? [];
    const stockDayNetPnL = new Map<string, number>();

    for (const trade of trades) {
      const stockKey = stockIdentityKey(trade);
      const key = `${trade.sellDate}::${stockKey}`;
      stockDayNetPnL.set(key, (stockDayNetPnL.get(key) ?? 0) + trade.realisedPnL);
    }

    let winning = 0;
    let losing = 0;
    let flat = 0;
    for (const netPnL of stockDayNetPnL.values()) {
      if (netPnL > 0) winning++;
      else if (netPnL < 0) losing++;
      else flat++;
    }

    const total = stockDayNetPnL.size;
    return {
      total,
      winning,
      losing,
      flat,
      rate: total ? (winning / total) * 100 : 0,
    };
  });

  activePeriodData = computed(() => {
    const data = this.analysis();
    if (!data) return [];
    switch (this.activeTab()) {
      case 'daily': return data.daily;
      case 'weekly': return data.weekly;
      case 'monthly': return data.monthly;
      default: return [];
    }
  });

  sortedPeriodData = computed(() =>
    this.sortRows(this.activePeriodData(), (row, col) => {
      if (col === 'period') return row.period;
      return row[col as keyof PeriodBucket] as number;
    })
  );

  sortedStockData = computed(() => {
    let stocks = this.filteredStocks.stocks();
    if (this.activeTab() === 'custom') {
      const list = this.customLists.selectedList();
      stocks = list ? this.customLists.stocksForList(list, stocks) : [];
    } else {
      stocks = filterStocksByRules(stocks, this.stockFilterRules());
    }
    const searched = stocks.filter((stock) => this.matchesStockSearch(stock, this.stockSearchQuery()));
    return this.sortRows(searched, (row, col) => {
      if (col === 'stockName') return row.stockName.toLowerCase();
      return row[col as keyof StockSummary] as number;
    });
  });

  hasStockSearch = computed(() => this.stockSearchQuery().trim().length > 0);

  stockScenarioStats = computed(() => {
    const universe = this.filteredStocks.stocks();
    if (this.activeTab() === 'custom') {
      const list = this.customLists.selectedList();
      const listed = list ? this.customLists.stocksForList(list, universe) : [];
      const shown = listed.filter((stock) => this.matchesStockSearch(stock, this.stockSearchQuery())).length;
      return { total: listed.length, shown };
    }
    const afterRules = filterStocksByRules(universe, this.stockFilterRules());
    const shown = afterRules.filter((stock) => this.matchesStockSearch(stock, this.stockSearchQuery())).length;
    return { total: universe.length, shown };
  });

  stockTableTotals = computed(() => {
    const stocks = this.sortedStockData();
    if (!stocks.length) return null;

    const sum = (pick: (s: StockSummary) => number) =>
      stocks.reduce((acc, stock) => acc + pick(stock), 0);

    const buyValue = sum((s) => s.buyValue);
    const realisedPnL = sum((s) => s.realisedPnL);

    return {
      stockCount: stocks.length,
      tradeCount: sum((s) => s.tradeCount),
      quantity: sum((s) => s.quantity),
      buyValue,
      sellValue: sum((s) => s.sellValue),
      realisedPnL,
      realisedPnLPct: buyValue > 0 ? realisedPnL / buyValue : 0,
      allocatedCharges: sum((s) => s.allocatedCharges),
      netPnL: sum((s) => s.netPnL),
    };
  });

  viewSummaryLabel = computed(() => {
    if (this.book() === 'holdings') return 'Unrealised';
    switch (this.activeTab()) {
      case 'daily':
        return 'Daily';
      case 'weekly':
        return 'Weekly';
      case 'monthly':
        return 'Monthly';
      case 'custom':
        return this.customLists.selectedList()?.name ?? 'Custom';
      default:
        return 'Overall';
    }
  });

  viewSummary = computed(() => {
    if (this.book() === 'holdings') {
      const open = this.holdingsSummary();
      return {
        pnlLabel: 'Unrealised',
        countLabel: 'Stocks',
        volumeLabel: 'Qty',
        realisedPnL: open?.unrealisedPnL ?? 0,
        allocatedCharges: 0,
        netPnL: open?.unrealisedPnL ?? 0,
        stockCount: open?.stockCount ?? 0,
        tradeCount: open?.quantity ?? 0,
        winRate: null as number | null,
        showCharges: false,
      };
    }

    const tab = this.activeTab();
    if (tab === 'daily' || tab === 'weekly' || tab === 'monthly') {
      const rows = this.activePeriodData();
      const tradeCount = rows.reduce((sum, row) => sum + row.tradeCount, 0);
      const winningTrades = rows.reduce((sum, row) => sum + row.winningTrades, 0);
      return {
        pnlLabel: 'P&L',
        countLabel: 'Periods',
        volumeLabel: 'Trades',
        realisedPnL: rows.reduce((sum, row) => sum + row.realisedPnL, 0),
        allocatedCharges: rows.reduce((sum, row) => sum + row.allocatedCharges, 0),
        netPnL: rows.reduce((sum, row) => sum + row.netPnL, 0),
        stockCount: rows.length,
        tradeCount,
        winRate: tradeCount ? (winningTrades / tradeCount) * 100 : 0,
        showCharges: true,
      };
    }

    const totals = this.stockTableTotals();
    const summary = this.analysis()?.summary;
    return {
      pnlLabel: 'P&L',
      countLabel: 'Stocks',
      volumeLabel: 'Trades',
      realisedPnL: totals?.realisedPnL ?? summary?.realisedPnL ?? 0,
      allocatedCharges: totals?.allocatedCharges ?? summary?.allocatedCharges ?? 0,
      netPnL: totals?.netPnL ?? summary?.netPnL ?? 0,
      stockCount: totals?.stockCount ?? this.filteredStocks.stocks().length,
      tradeCount: totals?.tradeCount ?? summary?.tradeCount ?? 0,
      winRate: summary?.winRate ?? null,
      showCharges: true,
    };
  });

  async loadClient(clientCode: string): Promise<void> {
    await this.state.loadFromClient(clientCode);
    this.clients.set(await this.clientSvc.listClients());
  }

  setBook(book: PnLBook): void {
    this.book.set(book);
    this.expandedPeriod.set(null);
    this.expandedStock.set(null);
    this.expandedPerStock.set(null);
    this.expandedDayKey.set(null);
    this.lazyTrades.clear();
    this.filterUrl.patchWatchlistQuery({
      [FILTER_QUERY_KEYS.book]: book === 'realised' ? null : book,
    });
  }

  setTab(tab: TabId): void {
    if (tab === 'holdings') {
      this.setBook('holdings');
      return;
    }
    this.activeTab.set(tab);
    this.expandedPeriod.set(null);
    this.expandedStock.set(null);
    this.expandedPerStock.set(null);
    this.expandedDayKey.set(null);
    this.lazyTrades.clear();
    this.resetSortForTab(tab);
    if (tab === 'custom') {
      void this.customLists.ensureLoaded();
      this.filterUrl.patchWatchlistQuery({ tab: 'custom' });
    } else {
      this.filterUrl.patchWatchlistQuery({ tab: null });
    }
  }

  isStockTableTab(): boolean {
    const tab = this.activeTab();
    return tab === 'stocks' || tab === 'custom';
  }

  selectCustomList(id: string): void {
    this.customLists.select(id || null);
    this.expandedPerStock.set(null);
    this.expandedDayKey.set(null);
  }

  async deleteSelectedCustomList(): Promise<void> {
    const list = this.customLists.selectedList();
    if (!list) return;
    if (!confirm(`Delete “${list.name}”? This cannot be undone.`)) return;
    await this.customLists.remove(list.id);
    this.expandedPerStock.set(null);
  }

  togglePeriodExpand(period: string): void {
    if (this.expandedPeriod() === period) {
      this.expandedPeriod.set(null);
      this.expandedStock.set(null);
      this.expandedDayKey.set(null);
      return;
    }
    this.expandedPeriod.set(period);
    this.expandedStock.set(null);
    this.expandedDayKey.set(null);
    void this.ensurePeriodTradesLoaded(period);
  }

  toggleStockExpand(accKey: string, event: Event): void {
    event.stopPropagation();
    const expanding = this.expandedStock() !== accKey;
    this.expandedStock.set(expanding ? accKey : null);
    this.expandedDayKey.set(null);
  }

  stockAccordionKey(period: string, stockKey: string): string {
    return `${period}::${stockKey}`;
  }

  isPeriodExpanded(period: string): boolean {
    return this.expandedPeriod() === period;
  }

  isStockExpanded(period: string, stockKey: string): boolean {
    return this.expandedStock() === this.stockAccordionKey(period, stockKey);
  }

  stockRowKey(stock: StockSummary): string {
    return stockIdentityKey(stock);
  }

  stockSymbol(stock: StockSummary): string {
    return this.lazyTrades.stockSymbol(stock);
  }

  stockSymbolFromName(stockName: string): string {
    return normalizeSymbol(stockName);
  }

  togglePerStockExpand(stock: StockSummary): void {
    const key = this.stockRowKey(stock);
    const expanding = this.expandedPerStock() !== key;
    this.expandedPerStock.set(expanding ? key : null);
    this.expandedDayKey.set(null);
    if (expanding) void this.ensureStockTradesLoaded(stock);
  }

  daySummariesForTrades(trades: Trade[]): TradeDaySummary[] {
    return summariseTradesByDay(
      trades,
      (trade) => this.tradeAllocatedCharge(trade),
      (trade) => this.tradeNetPnL(trade)
    );
  }

  perStockDayKey(stock: StockSummary, date: string): string {
    return `per-stock::${this.stockRowKey(stock)}|${date}`;
  }

  periodStockDayKey(period: string, stockKey: string, date: string): string {
    return `${period}::${stockKey}|${date}`;
  }

  isDayExpanded(dayKey: string): boolean {
    return this.expandedDayKey() === dayKey;
  }

  toggleDayExpand(dayKey: string, event?: Event): void {
    event?.stopPropagation();
    this.expandedDayKey.set(this.expandedDayKey() === dayKey ? null : dayKey);
  }

  isPerStockExpanded(stock: StockSummary): boolean {
    return this.expandedPerStock() === this.stockRowKey(stock);
  }

  /**
   * Trades and day summaries for the one expanded stock row.
   *
   * The drilldown template used to call `daySummariesForTrades(tradesForStock(stock))` five
   * times in the same block, and each call re-filtered and re-sorted the whole filtered trade
   * list. Under zone.js that ran on every keystroke and focus change. Only one row can be
   * expanded at a time, so the work is derived once here instead.
   */
  expandedStockTrades = computed<Trade[]>(() => {
    const key = this.expandedPerStock();
    if (!key) return [];
    const stock = this.sortedStockData().find((row) => this.stockRowKey(row) === key);
    return stock ? this.tradesForStock(stock) : [];
  });

  expandedStockDays = computed<TradeDaySummary[]>(() =>
    this.daySummariesForTrades(this.expandedStockTrades())
  );

  tradesForStock(stock: StockSummary): Trade[] {
    const cached = this.lazyTrades.tradesForKey(this.lazyTrades.cacheKeyForStock(stock));
    if (cached.length) return cached;

    const report = this.state.report();
    const filtered = this.analysis()?.filteredTrades;
    if (filtered?.length) {
      return this.lazyTrades.filterTradesForStock(
        filtered,
        stock,
        report,
        this.state.analysisOptions()
      );
    }
    return [];
  }

  isStockTradesLoading(stock: StockSummary): boolean {
    return this.lazyTrades.isLoading(this.lazyTrades.cacheKeyForStock(stock));
  }

  periodTrades(period: string): Trade[] {
    const tab = this.activeTab();
    if (tab !== 'daily' && tab !== 'weekly' && tab !== 'monthly') return [];
    return this.lazyTrades.tradesForKey(this.lazyTrades.cacheKeyForPeriod(tab, period));
  }

  periodStockGroups(period: string) {
    // Only the expanded period is ever rendered, so serve it from the memoized computed
    // instead of regrouping trades on every change-detection pass.
    if (period === this.expandedPeriod()) return this.expandedPeriodGroups();
    return this.buildPeriodStockGroups(period);
  }

  /** Stock groups for the one expanded period row. See `expandedStockDrilldown`. */
  expandedPeriodGroups = computed(() => {
    const period = this.expandedPeriod();
    return period ? this.buildPeriodStockGroups(period) : [];
  });

  private buildPeriodStockGroups(period: string) {
    const loaded = this.periodTrades(period);
    if (loaded.length) return this.groupTradesByStock(loaded);
    const row = this.activePeriodData().find((item) => item.period === period);
    return row ? this.groupTradesByStock(row.trades) : [];
  }

  isPeriodTradesLoading(period: string): boolean {
    const tab = this.activeTab();
    if (tab !== 'daily' && tab !== 'weekly' && tab !== 'monthly') return false;
    return this.lazyTrades.isLoading(this.lazyTrades.cacheKeyForPeriod(tab, period));
  }

  periodTradeCount(period: string): number {
    const loaded = this.periodTrades(period);
    if (loaded.length) return loaded.length;
    return this.activePeriodData().find((item) => item.period === period)?.tradeCount ?? 0;
  }

  tradeDetailColumnLabel(key: StockColumnKey): string {
    if (key === 'tradeCount') return 'Type';
    return this.stockColumns.find((col) => col.key === key)?.label ?? key;
  }

  tradeAllocatedCharge(trade: Trade): number {
    return allocatedChargeForTrade(trade, this.chargeRatio());
  }

  tradeNetPnL(trade: Trade): number {
    return netPnLForTrade(trade, this.chargeRatio());
  }

  groupNetPnL(group: StockTradeGroup): number {
    return group.trades.reduce((sum, trade) => sum + this.tradeNetPnL(trade), 0);
  }

  tradeRealisedPnLPct(trade: Trade): number {
    return trade.buyValue > 0 ? trade.realisedPnL / trade.buyValue : 0;
  }

  tradeDetailCellClass(key: StockColumnKey, trade: Trade): string {
    const base = 'text-right tabular-nums';
    switch (key) {
      case 'realisedPnL':
      case 'realisedPnLPct':
        return `${base} ${this.pnlClass(trade.realisedPnL)}`;
      case 'allocatedCharges':
        return `${base} text-red-600`;
      case 'netPnL':
        return `${base} font-semibold ${this.pnlClass(this.tradeNetPnL(trade))}`;
      default:
        return base;
    }
  }

  toggleSort(column: string, event?: Event): void {
    event?.stopPropagation();
    if (this.sortColumn() === column) {
      this.sortDirection.set(this.sortDirection() === 'asc' ? 'desc' : 'asc');
      return;
    }
    this.sortColumn.set(column);
    this.sortDirection.set(this.defaultSortDirection(column));
  }

  sortIndicator(column: string): string {
    if (this.sortColumn() !== column) return '';
    return this.sortDirection() === 'asc' ? '↑' : '↓';
  }

  isSortedColumn(column: string): boolean {
    return this.sortColumn() === column;
  }

  toggleStockColumnsPanel(): void {
    this.stockColumnsPanelOpen.update((open) => !open);
    if (this.stockColumnsPanelOpen()) this.periodColumnsPanelOpen.set(false);
  }

  togglePeriodColumnsPanel(): void {
    this.periodColumnsPanelOpen.update((open) => !open);
  }

  isPeriodColumnVisible(key: string): boolean {
    return this.visiblePeriodColumns().has(key as PeriodColumnKey);
  }

  togglePeriodColumn(key: string): void {
    if (key === 'period') return;
    const k = key as PeriodColumnKey;
    this.visiblePeriodColumns.update((current) => {
      const next = new Set(current);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  periodCellClass(key: string, row: PeriodBucket): string {
    if (key === 'period') return 'col-name';
    const base = 'text-right tabular-nums';
    switch (key) {
      case 'realisedPnL':
        return `${base} ${this.pnlClass(row.realisedPnL)}`;
      case 'allocatedCharges':
        return `${base} text-red-600`;
      case 'netPnL':
        return `${base} font-semibold ${this.pnlClass(row.netPnL)}`;
      default:
        return base;
    }
  }

  setStockSortColumn(column: StockColumnKey): void {
    this.sortColumn.set(column);
    this.sortDirection.set(this.defaultSortDirection(column));
  }

  toggleStockSortDirection(): void {
    this.sortDirection.set(this.sortDirection() === 'asc' ? 'desc' : 'asc');
  }

  isStockColumnVisible(key: StockColumnKey): boolean {
    return this.visibleStockColumns().has(key);
  }

  isStockColumnRequired(key: StockColumnKey): boolean {
    return this.stockColumns.find((col) => col.key === key)?.required ?? false;
  }

  toggleStockColumn(key: StockColumnKey): void {
    if (this.isStockColumnRequired(key)) return;
    this.visibleStockColumns.update((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        if (next.size <= 1) return current;
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  stockColumnResponsiveClass(key: StockColumnKey): string {
    if (key === 'stockName' || key === 'netPnL') return '';
    if (key === 'tradeCount' || key === 'realisedPnL') return 'hidden sm:table-cell';
    return 'hidden lg:table-cell';
  }

  periodColumnResponsiveClass(key: PeriodColumnKey): string {
    if (key === 'period' || key === 'netPnL') return '';
    if (key === 'tradeCount' || key === 'realisedPnL' || key === 'winRate') return 'hidden sm:table-cell';
    return 'hidden md:table-cell';
  }

  stockColumnCellClass(key: StockColumnKey, stock: StockSummary): string {
    const base = 'text-right tabular-nums';
    switch (key) {
      case 'realisedPnL':
      case 'realisedPnLPct':
        return `${base} ${this.pnlClass(stock.realisedPnL)}`;
      case 'allocatedCharges':
        return `${base} text-red-600`;
      case 'netPnL':
        return `${base} font-semibold ${this.pnlClass(stock.netPnL)}`;
      default:
        return base;
    }
  }

  stockTotalsCellClass(key: StockColumnKey, totals: NonNullable<ReturnType<typeof this.stockTableTotals>>): string {
    const base = 'text-right tabular-nums font-semibold';
    switch (key) {
      case 'realisedPnL':
      case 'realisedPnLPct':
        return `${base} ${this.pnlClass(totals.realisedPnL)}`;
      case 'allocatedCharges':
        return `${base} text-red-600`;
      case 'netPnL':
        return `${base} ${this.pnlClass(totals.netPnL)}`;
      default:
        return base;
    }
  }

  tradeTypeLabel(type: TradeType): string {
    return this.tradeTypeLabels[type] || type;
  }

  private clientCode(): string | null {
    return this.state.activeClientCode() ?? this.state.report()?.summary.clientCode ?? null;
  }

  private matchesStockSearch(stock: StockSummary, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const haystack = [stock.stockName, stock.isin, stock.symbol]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  }

  clearStockSearch(): void {
    this.stockSearchQuery.set('');
  }

  private async ensureStockTradesLoaded(stock: StockSummary): Promise<void> {
    const clientCode = this.clientCode();
    if (!clientCode) return;
    await this.lazyTrades.loadForStock(
      clientCode,
      stock,
      this.state.report(),
      this.state.analysisOptions()
    );
  }

  private async ensurePeriodTradesLoaded(period: string): Promise<void> {
    const clientCode = this.clientCode();
    const tab = this.activeTab();
    if (!clientCode || (tab !== 'daily' && tab !== 'weekly' && tab !== 'monthly')) return;
    await this.lazyTrades.loadForPeriod(
      clientCode,
      period,
      tab,
      this.state.report(),
      this.state.analysisOptions()
    );
  }

  private resetSortForTab(tab: TabId): void {
    const defaults: Record<TabId, { column: string; direction: SortDir }> = {
      daily: { column: 'period', direction: 'desc' },
      weekly: { column: 'period', direction: 'desc' },
      monthly: { column: 'period', direction: 'desc' },
      stocks: { column: 'realisedPnL', direction: 'desc' },
      holdings: { column: 'unrealisedPnL', direction: 'desc' },
      custom: { column: 'realisedPnL', direction: 'desc' },
    };
    const { column, direction } = defaults[tab];
    this.sortColumn.set(column);
    this.sortDirection.set(direction);
    if (tab === 'stocks') {
      this.stockFilterRules.set([]);
    }
  }

  private defaultSortDirection(column: string): SortDir {
    if (column === 'stockName' || column === 'label') return 'asc';
    return 'desc';
  }

  private sortRows<T>(
    rows: T[],
    getValue: (row: T, column: string) => string | number
  ): T[] {
    const column = this.sortColumn();
    if (!column || !rows.length) return rows;
    const direction = this.sortDirection();
    return [...rows].sort((a, b) => {
      const av = getValue(a, column);
      const bv = getValue(b, column);
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
      return direction === 'asc' ? cmp : -cmp;
    });
  }
}

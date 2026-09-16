import { Component, computed, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, Subscription } from 'rxjs';
import { StockFirestoreService } from '../../services/stock-firestore.service';
import { AuthService } from '../../services/auth.service';
import { ReportStateService } from '../../services/report-state.service';
import { LazyTradeLoaderService } from '../../services/lazy-trade-loader.service';
import { FilteredStockService } from '../../services/filtered-stock.service';
import { FilterUrlService } from '../../services/filter-url.service';
import { Watchlist } from '../../models/watchlist.models';
import { StockSummary, TRADE_TYPE_LABELS, Trade, TradeType } from '../../models/trade.models';
import { StockSnapshot } from '../../models/market.models';
import { formatCurrency, formatDate, pnlClass } from '../../utils/format.utils';
import {
  getPnlWatchlistTier,
  PNL_WATCHLIST_TIERS,
  PnlTierMode,
  stockSummariesForPnlTier,
  tierDisplayName,
  tierShortLabel,
} from '../../utils/pnl-watchlist.utils';
import { holdingsToStockSummaries, PnLBook } from '../../utils/holdings.utils';
import { normalizeSymbol } from '../../utils/upload-merge.utils';
import { stockIdentityKey } from '../../utils/stock-identity.utils';
import { TableSortState } from '../../utils/table-sort.utils';
import { TradeTypeFilterComponent } from '../shared/trade-type-filter/trade-type-filter.component';
import { DateRangeFilterComponent } from '../shared/date-range-filter/date-range-filter.component';
import { summariseTradesByDay, TradeDaySummary } from '../../utils/trade-day-summary.utils';
import {
  tradeAllocatedCharge as allocatedChargeForTrade,
  tradeNetPnL as netPnLForTrade,
} from '../../utils/trade-charges.utils';
import { FILTER_QUERY_KEYS, readWatchlistFilters } from '../../utils/filter-url.utils';
import { ErrorBannerComponent } from '../shared/error-banner/error-banner.component';

const ALL_SUBTAB_ID = '__all__';

type WatchlistTab = 'losing' | 'profitable';

interface TierSummary {
  stockCount: number;
  tradeCount: number;
  buyValue: number;
  sellValue: number;
  realisedPnL: number;
  allocatedCharges: number;
  netPnL: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
}

interface AutoTierTab {
  watchlist: Watchlist;
  shortLabel: string;
  fullLabel: string;
  count: number;
}

@Component({
  selector: 'app-watchlists',
  standalone: true,
  imports: [CommonModule, RouterLink, TradeTypeFilterComponent, DateRangeFilterComponent, ErrorBannerComponent],
  templateUrl: './watchlists.component.html',
})
export class WatchlistsComponent implements OnInit, OnDestroy {
  private stockSvc = inject(StockFirestoreService);
  private router = inject(Router);
  private filterUrl = inject(FilterUrlService);
  private navSub?: Subscription;
  readonly auth = inject(AuthService);
  readonly state = inject(ReportStateService);
  readonly lazyTrades = inject(LazyTradeLoaderService);
  readonly filteredStocks = inject(FilteredStockService);

  stocks = toSignal(this.stockSvc.watchMarketCatalog(), { initialValue: [] as StockSnapshot[] });

  async ngOnInit(): Promise<void> {
    this.syncWatchlistFromUrl();
    this.navSub = this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => this.syncWatchlistFromUrl());
    await this.state.ensureLoadedFromFirebase();
    await this.state.ensureTradesLoaded();
  }

  ngOnDestroy(): void {
    this.navSub?.unsubscribe();
  }

  private syncWatchlistFromUrl(): void {
    const wl = readWatchlistFilters(this.router.routerState.snapshot.root.queryParamMap);
    if (wl.side) this.activeTab.set(wl.side);
    if (wl.bands) this.tierMode.set(wl.bands);
    if (wl.book) this.book.set(wl.book);
    this.selectedAutoTierId.set(wl.tier ?? null);
  }

  readonly formatDate = formatDate;

  readonly mainTabs: { id: WatchlistTab; label: string }[] = [
    { id: 'losing', label: 'Losses' },
    { id: 'profitable', label: 'Profits' },
  ];

  readonly bookTabs: { id: PnLBook; label: string }[] = [
    { id: 'realised', label: 'Realised' },
    { id: 'holdings', label: 'Unrealised' },
  ];

  readonly allSubtabId = ALL_SUBTAB_ID;

  activeTab = signal<WatchlistTab>('losing');
  book = signal<PnLBook>('realised');
  tierMode = signal<PnlTierMode>('band');
  selectedAutoTierId = signal<string | null>(null);
  expandedStockKey = signal<string | null>(null);
  expandedDayKey = signal<string | null>(null);
  mobileFiltersOpen = signal(false);

  readonly hiddenTradeTypes: TradeType[] = ['mtf'];
  readonly formatCurrency = formatCurrency;
  readonly pnlClass = pnlClass;
  readonly tableSort = new TableSortState('netPnL');

  bookStocks = computed((): StockSummary[] => {
    if (this.book() === 'holdings') {
      return holdingsToStockSummaries(this.state.report()?.unrealisedHoldings ?? []);
    }
    return this.filteredStocks.stocks();
  });

  readonly tierStockColumns = [
    { key: 'stockName', label: 'Stock', align: 'left' as const, mobile: true },
    { key: 'realisedPnL', label: 'P&L', align: 'right' as const, mobile: false },
    { key: 'allocatedCharges', label: 'Charges', align: 'right' as const, mobile: false },
    { key: 'netPnL', label: 'Net P&L', align: 'right' as const, mobile: true },
  ];

  autoTierTabs = computed((): AutoTierTab[] => {
    const summaries = this.bookStocks();
    const mode = this.tierMode();

    return PNL_WATCHLIST_TIERS.map((tier) => {
      const stocks = stockSummariesForPnlTier(summaries, tier, mode);
      const watchlist: Watchlist = {
        id: tier.id,
        name: tier.name,
        type: 'pnl_derived',
        color: tier.color,
        sortOrder: tier.sortOrder,
        stockSymbols: stocks.map((stock) => this.stockSymbol(stock)),
        createdAt: 0,
        updatedAt: 0,
      };

      return {
        watchlist,
        shortLabel: tierShortLabel(tier, mode),
        fullLabel: tierDisplayName(tier, mode),
        count: stocks.length,
      };
    });
  });

  filterSummary = computed(() => {
    const tradeTypes = this.state.selectedTradeTypes();
    const trade = tradeTypes.includes('all')
      ? 'All trades'
      : tradeTypes.map((type) => TRADE_TYPE_LABELS[type] || type).join(', ');
    const band = this.tierMode() === 'band' ? 'Exclusive' : 'Cumulative';
    const report = this.state.report();
    const dates =
      this.book() === 'holdings'
        ? 'Open positions'
        : report &&
            (this.state.startDate() !== report.dateRange.min || this.state.endDate() !== report.dateRange.max)
          ? `${this.formatDate(this.state.startDate())} – ${this.formatDate(this.state.endDate())}`
          : 'Inception';
    const book = this.book() === 'holdings' ? 'Unrealised' : 'Realised';
    return `${book} · ${dates} · ${trade} · ${band}`;
  });

  lossTierTabs = computed(() =>
    this.autoTierTabs().filter((tab) => getPnlWatchlistTier(tab.watchlist.id)?.side === 'loss')
  );

  profitTierTabs = computed(() =>
    this.autoTierTabs().filter((tab) => getPnlWatchlistTier(tab.watchlist.id)?.side === 'profit')
  );

  visibleAutoTierTabs = computed((): AutoTierTab[] => {
    const tiers =
      this.activeTab() === 'profitable' ? this.profitTierTabs() : this.lossTierTabs();
    const summaries = this.bookStocks();
    const allCount = summaries.filter((stock) =>
      this.activeTab() === 'profitable' ? stock.netPnL > 0 : stock.netPnL < 0
    ).length;

    const allTab: AutoTierTab = {
      watchlist: {
        id: ALL_SUBTAB_ID,
        name: 'All',
        type: 'pnl_derived',
        color: this.activeTab() === 'profitable' ? '#22c55e' : '#ef4444',
        sortOrder: -1,
        stockSymbols: [],
        createdAt: 0,
        updatedAt: 0,
      },
      shortLabel: 'All',
      fullLabel:
        this.activeTab() === 'profitable' ? 'All profitable stocks' : 'All loss-making stocks',
      count: allCount,
    };

    return [allTab, ...tiers];
  });

  activeAutoWatchlist = computed(() => {
    const tabs = this.visibleAutoTierTabs();
    const selected = this.selectedAutoTierId() ?? ALL_SUBTAB_ID;
    return tabs.find((tab) => tab.watchlist.id === selected)?.watchlist ?? tabs[0]?.watchlist ?? null;
  });

  activeAutoTierMeta = computed(() => {
    const watchlist = this.activeAutoWatchlist();
    if (!watchlist) return null;
    return this.visibleAutoTierTabs().find((tab) => tab.watchlist.id === watchlist.id) ?? null;
  });

  activeViewLabel = computed(() => this.activeAutoTierMeta()?.fullLabel ?? '');

  tierStocks = computed(() => {
    const stockSummaries = this.bookStocks();
    const watchlist = this.activeAutoWatchlist();
    if (!watchlist) return [] as StockSummary[];

    if (watchlist.id === ALL_SUBTAB_ID) {
      const stocks = stockSummaries
        .filter((stock) =>
          this.activeTab() === 'profitable' ? stock.netPnL > 0 : stock.netPnL < 0
        )
        .sort((a, b) => b.netPnL - a.netPnL);
      return this.tableSort.sort(stocks, (stock, col) => this.tierStockSortValue(stock, col));
    }

    const tier = getPnlWatchlistTier(watchlist.id);
    const stocks = tier
      ? stockSummariesForPnlTier(stockSummaries, tier, this.tierMode())
      : [];

    return this.tableSort.sort(stocks, (stock, col) => this.tierStockSortValue(stock, col));
  });

  tierSummary = computed((): TierSummary | null => {
    const stocks = this.tierStocks();
    if (!stocks.length) return null;

    const tradeCount = stocks.reduce((sum, stock) => sum + stock.tradeCount, 0);
    const winningTrades = stocks.reduce(
      (sum, stock) => sum + Math.round(stock.tradeCount * ((stock.winRate ?? 0) / 100)),
      0
    );
    const losingTrades = Math.max(0, tradeCount - winningTrades);

    return {
      stockCount: stocks.length,
      tradeCount,
      buyValue: stocks.reduce((sum, stock) => sum + stock.buyValue, 0),
      sellValue: stocks.reduce((sum, stock) => sum + stock.sellValue, 0),
      realisedPnL: stocks.reduce((sum, stock) => sum + stock.realisedPnL, 0),
      allocatedCharges: stocks.reduce((sum, stock) => sum + stock.allocatedCharges, 0),
      netPnL: stocks.reduce((sum, stock) => sum + stock.netPnL, 0),
      winningTrades,
      losingTrades,
      winRate: tradeCount ? (winningTrades / tradeCount) * 100 : 0,
    };
  });

  setTab(tab: WatchlistTab): void {
    this.activeTab.set(tab);
    this.selectedAutoTierId.set(null);
    this.expandedStockKey.set(null);
    this.expandedDayKey.set(null);
    this.lazyTrades.clear();
    this.filterUrl.patchWatchlistQuery({
      [FILTER_QUERY_KEYS.side]: tab,
      [FILTER_QUERY_KEYS.tier]: null,
    });
  }

  setBook(book: PnLBook): void {
    this.book.set(book);
    this.selectedAutoTierId.set(null);
    this.expandedStockKey.set(null);
    this.expandedDayKey.set(null);
    this.lazyTrades.clear();
    this.filterUrl.patchWatchlistQuery({
      [FILTER_QUERY_KEYS.book]: book === 'realised' ? null : book,
      [FILTER_QUERY_KEYS.tier]: null,
    });
  }

  setTierMode(mode: PnlTierMode): void {
    this.tierMode.set(mode);
    this.selectedAutoTierId.set(null);
    this.expandedStockKey.set(null);
    this.expandedDayKey.set(null);
    this.lazyTrades.clear();
    this.filterUrl.patchWatchlistQuery({
      [FILTER_QUERY_KEYS.bands]: mode,
      [FILTER_QUERY_KEYS.tier]: null,
    });
  }

  toggleMobileFilters(): void {
    this.mobileFiltersOpen.update((open) => !open);
  }

  selectAutoTier(id: string): void {
    this.selectedAutoTierId.set(id);
    this.expandedStockKey.set(null);
    this.expandedDayKey.set(null);
    this.lazyTrades.clear();
    this.filterUrl.patchWatchlistQuery({
      [FILTER_QUERY_KEYS.tier]: id === ALL_SUBTAB_ID ? null : id,
    });
  }

  stockRowKey(stock: StockSummary): string {
    return stockIdentityKey(stock);
  }

  isStockExpanded(stock: StockSummary): boolean {
    return this.expandedStockKey() === this.stockRowKey(stock);
  }

  toggleStockExpand(stock: StockSummary, event?: Event): void {
    event?.stopPropagation();
    if (this.book() === 'holdings') return;
    const key = this.stockRowKey(stock);
    const expanding = this.expandedStockKey() !== key;
    this.expandedStockKey.set(expanding ? key : null);
    this.expandedDayKey.set(null);
    if (expanding) void this.ensureStockTradesLoaded(stock);
  }

  daySummariesForStock(stock: StockSummary): TradeDaySummary[] {
    return summariseTradesByDay(
      this.tradesForStock(stock),
      (trade) => this.tradeAllocatedCharge(trade),
      (trade) => this.tradeNetPnL(trade)
    );
  }

  dayRowKey(stock: StockSummary, date: string): string {
    return `${this.stockRowKey(stock)}|${date}`;
  }

  isDayExpanded(stock: StockSummary, date: string): boolean {
    return this.expandedDayKey() === this.dayRowKey(stock, date);
  }

  toggleDayExpand(stock: StockSummary, date: string, event?: Event): void {
    event?.stopPropagation();
    const key = this.dayRowKey(stock, date);
    this.expandedDayKey.set(this.expandedDayKey() === key ? null : key);
  }

  /** Blended fallback for trades hydrated without their own allocated charges. */
  chargeRatio = computed(() => this.state.analysis()?.summary.chargeRatio ?? 0);

  tradeNetPnL(trade: Trade): number {
    return netPnLForTrade(trade, this.chargeRatio());
  }

  tradeAllocatedCharge(trade: Trade): number {
    return allocatedChargeForTrade(trade, this.chargeRatio());
  }

  tradesForStock(stock: StockSummary): Trade[] {
    const cached = this.lazyTrades.tradesForKey(this.lazyTrades.cacheKeyForStock(stock));
    if (cached.length) return cached;

    const report = this.state.report();
    const filtered = this.state.analysis()?.filteredTrades;
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

  tradeTypeLabel(type: string): string {
    return TRADE_TYPE_LABELS[type] || type;
  }

  tierTabLabel(tab: AutoTierTab): string {
    return `${tab.shortLabel} (${tab.count})`;
  }

  tierColumnClass(col: { align: 'left' | 'right'; mobile: boolean }, stock?: StockSummary, key?: string): string {
    const align = col.align === 'left' ? 'text-left' : 'text-right';
    const visibility = col.mobile ? '' : 'hidden md:table-cell';
    if (!stock || !key) return `${align} ${visibility}`.trim();
    if (key === 'stockName') return `col-name ${visibility}`.trim();
    return `${this.tierStockCellClass(key, stock)} ${visibility}`.trim();
  }

  stockPrice(symbol: string): string {
    const s = this.stocks().find((x) => x.symbol === symbol);
    return s ? `₹${s.ltp?.toFixed(2)} (${s.changePct?.toFixed(2)}%)` : '—';
  }

  tierStockCellClass(key: string, stock: StockSummary): string {
    const base = 'text-right tabular-nums';
    switch (key) {
      case 'realisedPnL':
        return `${base} ${this.pnlClass(stock.realisedPnL)}`;
      case 'allocatedCharges':
        return `${base} text-red-600`;
      case 'netPnL':
        return `${base} font-semibold ${this.pnlClass(stock.netPnL)}`;
      case 'ltp':
        return 'text-right text-slate-500';
      default:
        return base;
    }
  }

  private tierStockSortValue(stock: StockSummary, col: string): string | number {
    switch (col) {
      case 'stockName':
        return stock.stockName.toLowerCase();
      case 'realisedPnL':
        return stock.realisedPnL;
      case 'allocatedCharges':
        return stock.allocatedCharges;
      case 'netPnL':
        return stock.netPnL;
      default:
        return 0;
    }
  }

  stockSymbol(stock: StockSummary): string {
    return stock.symbol || normalizeSymbol(stock.stockName);
  }

  private clientCode(): string | null {
    return this.state.activeClientCode() ?? this.state.report()?.summary.clientCode ?? null;
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
}

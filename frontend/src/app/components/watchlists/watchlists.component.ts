import { Component, computed, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
import { StockSummary, TRADE_TYPE_LABELS, TradeType } from '../../models/trade.models';
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
import { TradeTypeFilterComponent } from '../shared/trade-type-filter/trade-type-filter.component';
import { DateRangeFilterComponent } from '../shared/date-range-filter/date-range-filter.component';
import { FILTER_QUERY_KEYS, readWatchlistFilters } from '../../utils/filter-url.utils';
import { ErrorBannerComponent } from '../shared/error-banner/error-banner.component';
import {
  ExpandableStockColumn,
  ExpandableStocksTableComponent,
} from '../shared/expandable-stocks-table/expandable-stocks-table.component';
import { StockScenarioPanelComponent } from '../shared/stock-scenario-panel/stock-scenario-panel.component';
import { TierSummaryBarComponent } from '../shared/tier-summary-bar/tier-summary-bar.component';
import {
  StockFilterRule,
  filterStocksByRules,
} from '../../utils/stock-scenario.utils';

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
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    TradeTypeFilterComponent,
    DateRangeFilterComponent,
    ErrorBannerComponent,
    ExpandableStocksTableComponent,
    StockScenarioPanelComponent,
    TierSummaryBarComponent,
  ],
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
    // Aggregate-first: watchlists use stock profiles / filtered summaries.
    // Accordion trade rows load on demand via LazyTradeLoaderService.
    await this.state.ensureLoadedFromFirebase();
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
  readonly formatCurrency = formatCurrency;
  readonly pnlClass = pnlClass;

  readonly mainTabs: { id: WatchlistTab; label: string }[] = [
    { id: 'losing', label: 'Losses' },
    { id: 'profitable', label: 'Profits' },
  ];

  readonly bookTabs: { id: PnLBook; label: string }[] = [
    { id: 'realised', label: 'Realised' },
    { id: 'holdings', label: 'Unrealised' },
  ];

  readonly allSubtabId = ALL_SUBTAB_ID;

  readonly stockColumns: ExpandableStockColumn[] = [
    'stockName',
    'tradeCount',
    'quantity',
    'buyValue',
    'sellValue',
    'realisedPnL',
    'realisedPnLPct',
    'allocatedCharges',
    'netPnL',
    'winRate',
  ];

  activeTab = signal<WatchlistTab>('losing');
  book = signal<PnLBook>('realised');
  tierMode = signal<PnlTierMode>('band');
  selectedAutoTierId = signal<string | null>(null);
  mobileFiltersOpen = signal(false);
  stockSearchQuery = signal('');
  stockFilterRules = signal<StockFilterRule[]>([]);
  scenarioPanelOpen = signal(false);

  readonly hiddenTradeTypes: TradeType[] = ['mtf'];

  bookStocks = computed((): StockSummary[] => {
    if (this.book() === 'holdings') {
      return holdingsToStockSummaries(this.state.report()?.unrealisedHoldings ?? []);
    }
    return this.filteredStocks.stocks();
  });

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

  tierStocksBase = computed(() => {
    const stockSummaries = this.bookStocks();
    const watchlist = this.activeAutoWatchlist();
    if (!watchlist) return [] as StockSummary[];

    if (watchlist.id === ALL_SUBTAB_ID) {
      return stockSummaries
        .filter((stock) =>
          this.activeTab() === 'profitable' ? stock.netPnL > 0 : stock.netPnL < 0
        )
        .sort((a, b) => b.netPnL - a.netPnL);
    }

    const tier = getPnlWatchlistTier(watchlist.id);
    return tier ? stockSummariesForPnlTier(stockSummaries, tier, this.tierMode()) : [];
  });

  tierStocks = computed(() => {
    let stocks = filterStocksByRules(this.tierStocksBase(), this.stockFilterRules());
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

  stockScenarioStats = computed(() => ({
    shown: this.tierStocks().length,
    total: this.tierStocksBase().length,
  }));

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

  emptyMessage = computed(() => {
    if (this.stockSearchQuery().trim()) {
      return `No stocks match "${this.stockSearchQuery().trim()}"`;
    }
    if (this.stockFilterRules().some((r) => r.value.trim())) {
      return 'No stocks match your scenario';
    }
    if (this.activeAutoWatchlist()?.id === ALL_SUBTAB_ID) {
      return `No ${this.activeTab() === 'profitable' ? 'profitable' : 'loss-making'} stocks found.`;
    }
    return 'No stocks in this tier yet.';
  });

  setTab(tab: WatchlistTab): void {
    this.activeTab.set(tab);
    this.selectedAutoTierId.set(null);
    this.lazyTrades.clear();
    this.filterUrl.patchWatchlistQuery({
      [FILTER_QUERY_KEYS.side]: tab,
      [FILTER_QUERY_KEYS.tier]: null,
    });
  }

  setBook(book: PnLBook): void {
    this.book.set(book);
    this.selectedAutoTierId.set(null);
    this.lazyTrades.clear();
    this.filterUrl.patchWatchlistQuery({
      [FILTER_QUERY_KEYS.book]: book === 'realised' ? null : book,
      [FILTER_QUERY_KEYS.tier]: null,
    });
  }

  setTierMode(mode: PnlTierMode): void {
    this.tierMode.set(mode);
    this.selectedAutoTierId.set(null);
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
    this.lazyTrades.clear();
    this.filterUrl.patchWatchlistQuery({
      [FILTER_QUERY_KEYS.tier]: id === ALL_SUBTAB_ID ? null : id,
    });
  }

  tierTabLabel(tab: AutoTierTab): string {
    return `${tab.shortLabel} (${tab.count})`;
  }

  hasStockSearch(): boolean {
    return this.stockSearchQuery().trim().length > 0;
  }

  clearStockSearch(): void {
    this.stockSearchQuery.set('');
  }

  stockSymbol(stock: StockSummary): string {
    return stock.symbol || normalizeSymbol(stock.stockName);
  }
}

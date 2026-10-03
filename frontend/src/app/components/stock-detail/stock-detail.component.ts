import { Component, computed, inject, signal, effect, OnInit } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { switchMap, of } from 'rxjs';
import { StockFirestoreService } from '../../services/stock-firestore.service';
import { StockLevelsService } from '../../services/stock-levels.service';
import { AuthService } from '../../services/auth.service';
import { TradeLedgerService } from '../../services/trade-ledger.service';
import { ReportStateService } from '../../services/report-state.service';
import { PageShellService } from '../../services/page-shell.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { StockLabelsStore } from '../../services/stock-labels.store';
import { ScreenerService } from '../../services/screener.service';
import { TradingChartComponent } from '../trading-chart/trading-chart.component';
import { ScreenerFundamentalsComponent } from '../screener-fundamentals/screener-fundamentals.component';
import { StockLabelsManagerComponent } from '../stock-labels/stock-labels-manager.component';
import { TrackingComponent } from '../tracking/tracking.component';
import { RegistryStock } from '../../models/trading-journal.models';
import { StockSnapshot } from '../../models/market.models';
import { formatCurrency, formatDate, formatPct, formatPrice, pnlClass } from '../../utils/format.utils';
import { formatDataAge, formatFetchedAt } from '../../utils/data-age.utils';
import { TRADE_TYPE_LABELS, Trade, TradeType } from '../../models/trade.models';
import { summariseTradesByDay, TradeDaySummary } from '../../utils/trade-day-summary.utils';
import {
  tradeAllocatedCharge as allocatedChargeForTrade,
  tradeNetPnL as netPnLForTrade,
} from '../../utils/trade-charges.utils';
import { normalizeIsin, stocksMatch } from '../../utils/stock-identity.utils';
import { normalizeSymbol } from '../../utils/upload-merge.utils';

@Component({
  selector: 'app-stock-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TradingChartComponent,
    ScreenerFundamentalsComponent,
    StockLabelsManagerComponent,
    TrackingComponent,
  ],
  templateUrl: './stock-detail.component.html',
})
export class StockDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private stockSvc = inject(StockFirestoreService);
  private levelsSvc = inject(StockLevelsService);
  readonly auth = inject(AuthService);
  private location = inject(Location);
  private pageShell = inject(PageShellService);
  readonly reportState = inject(ReportStateService);
  private ledger = inject(TradeLedgerService);
  private registrySvc = inject(RegistryStockService);
  readonly labelStore = inject(StockLabelsStore);
  private screenerSvc = inject(ScreenerService);

  newLevelPrice = '';
  newLevelLabel = '';
  newLevelType: 'support' | 'resistance' = 'support';
  levelError = signal<string | null>(null);

  screenerBusy = signal(false);
  screenerError = signal<string | null>(null);
  screenerSuccess = signal<string | null>(null);
  /** Pasted Screener.in company page. Used instead of ticker search when set. */
  screenerPageUrl = '';
  registryStock = signal<RegistryStock | null>(null);
  isinMarketStock = signal<StockSnapshot | null>(null);
  showLabelPanel = signal(false);

  /** Labels currently tagged to this stock, for the read-only chips in the hero. */
  assignedLabels = computed(() => {
    const ids = new Set(this.labelStore.labelIdsFor(this.symbol()));
    return this.labelStore.labels().filter((label) => ids.has(label.id));
  });

  /** Passed to the label manager so tagging also lists the stock in the registry. */
  readonly ensureRegistryRow = async (): Promise<void> => {
    const sym = this.symbol();
    if (!sym || this.registryStock()) return;
    const row = await this.registrySvc.ensureListed(sym, {
      name: this.displayName(),
      isin: this.displayIsin(),
      currentPrice: this.displayPrice()?.value,
      exchange: this.displayExchange(),
    });
    this.registryStock.set(row);
  };

  formatFetchedAt = formatFetchedAt;
  formatDataAge = formatDataAge;
  formatDate = formatDate;
  pnlClass = pnlClass;
  readonly tradeTypeLabels = TRADE_TYPE_LABELS;

  symbol = toSignal(this.route.paramMap.pipe(switchMap((p) => of(p.get('symbol')?.toUpperCase() ?? ''))), { initialValue: '' });

  stock = toSignal(
    this.route.paramMap.pipe(
      switchMap((p) => {
        const sym = p.get('symbol')?.toUpperCase() ?? '';
        return sym ? this.stockSvc.watchStock(sym) : of(undefined);
      })
    ),
    { initialValue: undefined }
  );

  chartView = toSignal(
    this.route.paramMap.pipe(
      switchMap((p) => {
        const sym = p.get('symbol')?.toUpperCase() ?? '';
        return sym ? this.stockSvc.watchChart(sym) : of(undefined);
      })
    ),
    { initialValue: undefined }
  );

  userLevels = toSignal(
    this.route.paramMap.pipe(
      switchMap((p) => {
        const sym = p.get('symbol')?.toUpperCase() ?? '';
        return sym ? this.levelsSvc.watch(sym) : of(undefined);
      })
    ),
    { initialValue: undefined }
  );

  activeTab = signal<'market' | 'fundamentals' | 'holdings' | 'my-trades' | 'trade-plan'>('fundamentals');
  fmt = formatCurrency;
  fmtPrice = formatPrice;
  fmtPct = formatPct;

  hasMarketData = computed(() => !!(this.stock() || this.isinMarketStock()));

  private resolvedMarket = computed(() => this.stock() ?? this.isinMarketStock() ?? undefined);

  displayName = computed(() => {
    const s = this.resolvedMarket();
    const reg = this.registryStock();
    return s?.name || reg?.name || this.symbol();
  });

  displayExchange = computed(() => this.resolvedMarket()?.exchange || this.registryStock()?.exchange || 'NSE');

  displayPrice = computed(() => {
    const s = this.resolvedMarket();
    if (s?.ltp) {
      return {
        value: s.ltp,
        change: s.change,
        changePct: s.changePct,
        fromMarket: true,
      };
    }
    const reg = this.registryStock();
    if (reg?.currentPrice && reg.currentPrice > 0) {
      return { value: reg.currentPrice, fromMarket: false };
    }
    return null;
  });

  headerPe = computed(() => this.resolvedMarket()?.pe ?? this.registryStock()?.pe);
  headerMarketCap = computed(() => this.resolvedMarket()?.marketCap ?? this.registryStock()?.marketCap);

  displayIsin = computed(() => {
    const fromRegistry = normalizeIsin(this.registryStock()?.isin);
    if (fromRegistry) return fromRegistry;
    const fromMarket = normalizeIsin(this.resolvedMarket()?.isin);
    if (fromMarket) return fromMarket;
    const fromHolding = normalizeIsin(this.myHolding()?.isin);
    if (fromHolding) return fromHolding;
    const fromTrade = this.myTrades().find((trade) => normalizeIsin(trade.isin))?.isin;
    return normalizeIsin(fromTrade);
  });

  private lastSymbol = '';

  week52Position = computed(() => {
    const s = this.resolvedMarket();
    if (!s?.week52High || !s?.week52Low || !s.ltp) return 50;
    const range = s.week52High - s.week52Low;
    if (range <= 0) return 50;
    return ((s.ltp - s.week52Low) / range) * 100;
  });

  private readonly _syncPageHeader = effect((onCleanup) => {
    const name = this.displayName();
    const isin = this.displayIsin();
    const title = isin ? `${name} · ${isin}` : name || 'Stock';
    this.pageShell.setHeader(title, '');
    onCleanup(() => this.pageShell.clearOverride());
  }, { allowSignalWrites: true });

  private readonly _resetTabOnSymbol = effect(() => {
    const sym = this.symbol();
    if (!sym || sym === this.lastSymbol) return;
    this.lastSymbol = sym;
    this.activeTab.set('fundamentals');
    this.screenerError.set(null);
    this.screenerSuccess.set(null);
    this.screenerPageUrl = '';
    this.expandedDayKey.set(null);
  }, { allowSignalWrites: true });

  private registryLoadGen = 0;

  private readonly _loadRegistryStock = effect(() => {
    const sym = this.symbol();
    const gen = ++this.registryLoadGen;
    if (!sym) {
      this.registryStock.set(null);
      this.isinMarketStock.set(null);
      return;
    }
    void this.registrySvc.getBySymbol(sym).then(async (row) => {
      if (gen !== this.registryLoadGen) return;
      this.registryStock.set(row);
      if (row?.screenerUrl && !this.screenerPageUrl.trim()) {
        this.screenerPageUrl = row.screenerUrl;
      }
      const isin = normalizeIsin(row?.isin);
      if (!isin) {
        this.isinMarketStock.set(null);
        return;
      }
      const market = await this.stockSvc.fetchStockByIsin(isin);
      if (gen !== this.registryLoadGen) return;
      this.isinMarketStock.set(market);
    });
    void this.labelStore.ensureLoaded();
  }, { allowSignalWrites: true });

  myTrades = signal<Trade[]>([]);
  tradesLoading = signal(false);

  private readonly _loadMyTrades = effect(() => {
    const sym = this.symbol();
    const clientCode = this.reportState.activeClientCode();
    if (!sym || !clientCode) {
      this.myTrades.set([]);
      return;
    }

    const isin = normalizeIsin(this.registryStock()?.isin);
    this.tradesLoading.set(true);
    void this.ledger.getTradesForStock(clientCode, { symbol: sym, isin }).then((rows) => {
      const trades: Trade[] = rows.map(
        ({
          stockName,
          isin,
          quantity,
          buyDate,
          buyPrice,
          buyValue,
          sellDate,
          sellPrice,
          sellValue,
          realisedPnL,
          remark,
          tradeType,
          holdingDays,
          allocatedCharges,
          netPnL,
        }) => ({
          stockName,
          isin,
          quantity,
          buyDate,
          buyPrice,
          buyValue,
          sellDate,
          sellPrice,
          sellValue,
          realisedPnL,
          remark,
          tradeType,
          holdingDays,
          allocatedCharges,
          netPnL,
        })
      );
      this.myTrades.set(trades);
    }).finally(() => this.tradesLoading.set(false));
  }, { allowSignalWrites: true });

  myStockSummary = computed(() => {
    const trades = this.myTrades();
    if (!trades.length) return null;
    const realisedPnL = trades.reduce((s, t) => s + t.realisedPnL, 0);
    const wins = trades.filter((t) => t.realisedPnL > 0).length;
    return { tradeCount: trades.length, realisedPnL, winRate: (wins / trades.length) * 100 };
  });

  myHolding = computed(() => {
    const sym = this.symbol();
    if (!sym) return null;
    const target = {
      symbol: sym,
      isin: normalizeIsin(this.registryStock()?.isin) || normalizeIsin(this.resolvedMarket()?.isin),
      stockName: this.displayName(),
    };
    return (
      (this.reportState.report()?.unrealisedHoldings ?? []).find(
        (holding) =>
          stocksMatch(holding, target) ||
          holding.symbol.toUpperCase() === sym ||
          normalizeSymbol(holding.stockName) === sym
      ) ?? null
    );
  });

  daySummaries = computed((): TradeDaySummary[] =>
    summariseTradesByDay(
      this.myTrades(),
      (trade) => this.tradeAllocatedCharge(trade),
      (trade) => this.tradeNetPnL(trade)
    )
  );

  expandedDayKey = signal<string | null>(null);

  chargeRatio = computed(() => this.reportState.analysis()?.summary.chargeRatio ?? 0);

  tradeAllocatedCharge(trade: Trade): number {
    return allocatedChargeForTrade(trade, this.chargeRatio());
  }

  tradeNetPnL(trade: Trade): number {
    return netPnLForTrade(trade, this.chargeRatio());
  }

  tradeTypeLabel(type: TradeType): string {
    return this.tradeTypeLabels[type] || type;
  }

  isDayExpanded(date: string): boolean {
    return this.expandedDayKey() === date;
  }

  toggleDayExpand(date: string, event?: Event): void {
    event?.stopPropagation();
    this.expandedDayKey.set(this.expandedDayKey() === date ? null : date);
  }

  goBack(): void {
    this.location.back();
  }

  fetchScreenerFromUrl(): void {
    void this.fetchScreener({ requirePageUrl: true });
  }

  ngOnInit(): void {
    void this.reportState.ensureLoadedFromFirebase();
  }

  async fetchScreener(opts?: { requirePageUrl?: boolean }): Promise<void> {
    const sym = this.symbol();
    if (!sym || this.screenerBusy()) return;

    const pageUrl = this.screenerPageUrl.trim();
    if (opts?.requirePageUrl && !pageUrl) {
      this.screenerError.set('Paste a Screener.in company page URL first.');
      this.screenerSuccess.set(null);
      return;
    }

    this.screenerBusy.set(true);
    this.screenerError.set(null);
    this.screenerSuccess.set(null);

    try {
      const data = await this.screenerSvc.fetchStock(sym, {
        isin: this.displayIsin(),
        name: this.displayName(),
        pageUrl: pageUrl || undefined,
      });
      const existing = this.registryStock() ?? {
        symbol: sym,
        name: data.name,
        currentPrice: 0,
        supports: [],
        resistances: [],
        updatedAt: Date.now(),
      };
      const nextIsin = normalizeIsin(data.isin) || normalizeIsin(existing.isin);
      const updated: RegistryStock = {
        ...existing,
        isin: nextIsin || existing.isin,
        name: data.name || existing.name,
        currentPrice: data.currentPrice ?? existing.currentPrice,
        marketCap: data.marketCap ?? existing.marketCap,
        pe: data.pe ?? existing.pe,
        bookValue: data.bookValue,
        dividendYield: data.dividendYield,
        roce: data.roce,
        roe: data.roe,
        faceValue: data.faceValue,
        highLow: data.highLow,
        salesGrowth3y: data.salesGrowth3y,
        salesGrowth5y: data.salesGrowth5y,
        salesGrowth10y: data.salesGrowth10y,
        salesGrowthTtm: data.salesGrowthTtm,
        profitGrowth3y: data.profitGrowth3y,
        profitGrowth5y: data.profitGrowth5y,
        profitGrowth10y: data.profitGrowth10y,
        profitGrowthTtm: data.profitGrowthTtm,
        stockCagr1y: data.stockCagr1y,
        stockCagr3y: data.stockCagr3y,
        stockCagr5y: data.stockCagr5y,
        stockCagr10y: data.stockCagr10y,
        promoterHolding: data.promoterHolding,
        fiiHolding: data.fiiHolding,
        diiHolding: data.diiHolding,
        publicHolding: data.publicHolding,
        governmentHolding: data.governmentHolding,
        otherHolding: data.otherHolding,
        quarterlyResults: data.quarterlyResults,
        profitLoss: data.profitLoss,
        balanceSheet: data.balanceSheet,
        cashFlow: data.cashFlow,
        shareholding: data.shareholding,
        screenerUrl: data.url,
        screenerFetchedAt: data.fetchedAt,
      };
      this.registryLoadGen++;
      await this.registrySvc.save(updated);
      this.registryStock.set({ ...updated });
      const fresh = await this.registrySvc.getBySymbol(sym);
      if (fresh) this.registryStock.set({ ...fresh });
      if (data.url) this.screenerPageUrl = data.url;
      const savedIsin = normalizeIsin(fresh?.isin ?? updated.isin);
      if (savedIsin) {
        const market = await this.stockSvc.fetchStockByIsin(savedIsin);
        this.isinMarketStock.set(market);
      }
      const tickerNote =
        data.symbol && data.symbol !== sym ? ` from the ${data.symbol} page` : '';
      const summary = `Fetched Screener data for ${sym}${tickerNote}`;
      this.screenerSuccess.set(savedIsin ? `${summary}. ISIN ${savedIsin}.` : `${summary}.`);
      this.activeTab.set('fundamentals');
    } catch (e) {
      this.screenerError.set(e instanceof Error ? e.message : 'Screener fetch failed');
    } finally {
      this.screenerBusy.set(false);
    }
  }

  rsi(s: { indicators?: { rsi?: number } }): number {
    return s.indicators?.rsi ?? 0;
  }

  macdHist(s: { indicators?: { macdHist?: number } }): number {
    return s.indicators?.macdHist ?? 0;
  }

  marketDataAge(lastUpdated: string): string {
    if (!lastUpdated) return 'unknown age';
    const ts = new Date(lastUpdated).getTime();
    if (!Number.isFinite(ts)) return 'unknown age';
    return formatDataAge(ts);
  }

  formatMarketCap(value?: number): string {
    if (!value || value <= 0) return '—';
    return `₹${(value / 1e7).toFixed(0)} Cr`;
  }

  async addUserLevel(): Promise<void> {
    const price = parseFloat(this.newLevelPrice);
    if (!price || price <= 0) {
      this.levelError.set('Enter a valid price');
      return;
    }
    this.levelError.set(null);
    try {
      await this.levelsSvc.addLevel(this.symbol(), this.newLevelType, price, this.newLevelLabel || (this.newLevelType === 'support' ? 'Support' : 'Resistance'));
      this.newLevelPrice = '';
      this.newLevelLabel = '';
    } catch (e) {
      this.levelError.set(e instanceof Error ? e.message : 'Failed to save level');
    }
  }
}

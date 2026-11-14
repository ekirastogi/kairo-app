import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, from, switchMap } from 'rxjs';
import { RegistryStock } from '../../models/trading-journal.models';
import { StockSnapshot } from '../../models/market.models';
import { AuthService } from '../../services/auth.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ScreenerService, ScreenerSnapshot } from '../../services/screener.service';
import { SignalWatch, SignalWatchService } from '../../services/signal-watch.service';
import { StockFirestoreService } from '../../services/stock-firestore.service';
import { ToastService } from '../../services/toast.service';
import { formatAnalysisChange, buildStockAnalysis, StockFundamentalAnalysis } from '../../utils/screener-analysis.utils';
import { formatPctSigned, formatPrice } from '../../utils/format.utils';
import { getMarketCapTier, MARKET_CAP_LABELS, MarketCapTier } from '../../utils/market-cap.utils';
import {
  avgPrice,
  buildPriceLadder,
  formatPriceListText,
  parsePriceListText,
  pctFromCmp,
  SignalBrokerTarget,
  SignalLadderPoint,
} from '../../utils/signal-watch.utils';
import { TableSortState } from '../../utils/table-sort.utils';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';

interface SignalRow extends SignalWatch {
  cmp: number | null;
  capTier: MarketCapTier | null;
  sector: string;
  analysis: StockFundamentalAnalysis;
  ladder: SignalLadderPoint[];
  avgTarget: number | null;
  avgDiff: number | null;
  pricesText: string;
  registry: RegistryStock | null;
}

function applyScreener(stock: RegistryStock | null, data: ScreenerSnapshot, fallbackSymbol: string): RegistryStock {
  const base: RegistryStock = stock ?? {
    symbol: data.symbol || fallbackSymbol,
    name: data.name || fallbackSymbol,
    currentPrice: 0,
    supports: [],
    resistances: [],
    updatedAt: Date.now(),
  };
  return {
    ...base,
    symbol: data.symbol || base.symbol,
    name: data.name || base.name,
    isin: data.isin || base.isin,
    currentPrice: data.currentPrice ?? base.currentPrice,
    marketCap: data.marketCap ?? base.marketCap,
    pe: data.pe ?? base.pe,
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
    updatedAt: Date.now(),
  };
}

function metricTone(value: number | null): string {
  if (value == null) return 'text-slate-500';
  if (value > 0.5) return 'text-emerald-700';
  if (value < -0.5) return 'text-rose-700';
  return 'text-slate-600';
}

@Component({
  selector: 'app-signals',
  standalone: true,
  imports: [CommonModule, NgTemplateOutlet, FormsModule, RouterLink, StockSearchInputComponent],
  templateUrl: './signals.component.html',
  host: { class: 'block' },
  styles: `
    .sig-ladder { position: relative; min-height: 4.5rem; }
    .sig-ladder-line { position: absolute; left: 0.75rem; right: 0.75rem; top: 1.85rem; height: 2px; background: #e2e8f0; }
    .sig-ladder-pt { position: absolute; top: 0; width: 4.5rem; margin-left: -2.25rem; text-align: center; }
    .sig-dot { margin: 0.35rem auto 0; height: 0.5rem; width: 0.5rem; border-radius: 999px; }
  `,
})
export class SignalsComponent {
  private watchSvc = inject(SignalWatchService);
  private registrySvc = inject(RegistryStockService);
  private screenerSvc = inject(ScreenerService);
  private stocksSvc = inject(StockFirestoreService);
  private toast = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly formatPrice = formatPrice;
  readonly formatPctSigned = formatPctSigned;
  readonly formatAnalysisChange = formatAnalysisChange;
  readonly pctFromCmp = pctFromCmp;
  readonly metricTone = metricTone;
  readonly tableSort = new TableSortState('symbol', 'asc');

  query = '';
  pricesText = '';
  picked: RegistryStock | null = null;
  busy = signal(false);
  refreshBusy = signal(false);
  expandedId = signal<string | null>(null);
  brokerName = '';
  brokerPrice = '';
  draftPrices: Record<string, string> = {};
  draftGuidance: Record<string, { profit: string; sales: string }> = {};
  private refreshedRegistry = signal<RegistryStock[]>([]);

  private dbWatches = toSignal(this.watchSvc.watchAll(), { initialValue: [] as SignalWatch[] });

  private symbolKey = computed(() =>
    [...new Set(this.dbWatches().map((row) => row.symbol.trim().toUpperCase()).filter(Boolean))]
      .sort()
      .join('\0')
  );

  private registryOverlay = toSignal(
    toObservable(this.symbolKey).pipe(
      distinctUntilChanged(),
      switchMap((key) => from(this.registrySvc.listBySymbols(key ? key.split('\0') : [])))
    ),
    { initialValue: [] as RegistryStock[] }
  );

  private catalog = toSignal(
    toObservable(this.symbolKey).pipe(
      distinctUntilChanged(),
      switchMap((key) => this.stocksSvc.watchStocksBySymbols(key ? key.split('\0') : []))
    ),
    { initialValue: [] as StockSnapshot[] }
  );

  extraStocks(): RegistryStock[] {
    return this.picked ? [this.picked] : [];
  }

  capLabelFor(tier: string | null | undefined): string {
    if (tier === 'large' || tier === 'mid' || tier === 'small' || tier === 'micro') {
      return MARKET_CAP_LABELS[tier];
    }
    return '—';
  }

  priceDraft(row: SignalRow): string {
    return this.draftPrices[row.id] || row.pricesText;
  }

  setPriceDraft(row: SignalRow, value: string): void {
    this.draftPrices[row.id] = value;
  }

  guidanceDraft(row: SignalRow, field: 'profit' | 'sales'): string {
    const draft = this.draftGuidance[row.id];
    if (!draft) return field === 'profit' ? row.guidanceProfit : row.guidanceSales;
    return field === 'profit' ? draft.profit : draft.sales;
  }

  setGuidanceDraft(row: SignalRow, field: 'profit' | 'sales', value: string): void {
    const current = this.draftGuidance[row.id] ?? { profit: row.guidanceProfit, sales: row.guidanceSales };
    this.draftGuidance[row.id] = { ...current, [field]: value };
  }

  rows = computed((): SignalRow[] => {
    const overlay = new Map(this.registryOverlay().map((s) => [s.symbol.toUpperCase(), s]));
    for (const stock of this.refreshedRegistry()) overlay.set(stock.symbol.toUpperCase(), stock);
    const catalog = new Map(this.catalog().map((s) => [s.symbol.toUpperCase(), s]));
    const built = this.dbWatches().map((row) => {
      const symbol = row.symbol.toUpperCase();
      const registry = overlay.get(symbol) ?? null;
      const snap = catalog.get(symbol);
      const cmp =
        registry?.currentPrice && registry.currentPrice > 0
          ? registry.currentPrice
          : snap?.ltp && snap.ltp > 0
            ? snap.ltp
            : null;
      const cap = registry?.marketCap ?? snap?.marketCap ?? 0;
      const avgTarget = avgPrice(row.prices);
      return {
        ...row,
        cmp,
        capTier: getMarketCapTier(cap),
        sector: snap?.sector?.trim() || '',
        analysis: buildStockAnalysis(registry),
        ladder: buildPriceLadder(row.prices, cmp),
        avgTarget,
        avgDiff: avgTarget != null ? pctFromCmp(cmp, avgTarget) : null,
        pricesText: formatPriceListText(row.prices),
        registry,
      };
    });
    return this.tableSort.sort(built, (row, column) => {
      switch (column) {
        case 'name':
          return row.name || row.symbol;
        case 'cmp':
          return row.cmp ?? -1;
        case 'avgTarget':
          return row.avgTarget ?? -1;
        case 'avgDiff':
          return row.avgDiff ?? Number.NEGATIVE_INFINITY;
        case 'cap':
          return row.capTier ?? '';
        default:
          return row.symbol;
      }
    });
  });

  expanded = computed(() => this.rows().find((row) => row.id === this.expandedId()) ?? null);

  onQuery(value: string): void {
    this.query = value.toUpperCase();
    if (!this.picked || this.picked.symbol.toUpperCase() !== this.query.trim()) {
      this.picked = null;
    }
  }

  onPicked(stock: RegistryStock): void {
    this.picked = stock;
    this.query = stock.symbol;
  }

  toggle(id: string): void {
    this.expandedId.update((cur) => (cur === id ? null : id));
    this.brokerName = '';
    this.brokerPrice = '';
    const row = this.rows().find((item) => item.id === id);
    if (row) {
      this.draftPrices[id] = row.pricesText;
      this.draftGuidance[id] = { profit: row.guidanceProfit, sales: row.guidanceSales };
    }
  }

  async addWatch(): Promise<void> {
    const stock = this.picked;
    if (!stock) {
      this.toast.error('Pick a stock');
      return;
    }
    const symbol = stock.symbol.trim().toUpperCase();
    if (this.dbWatches().some((row) => row.symbol.toUpperCase() === symbol)) {
      this.toast.error(`${symbol} is already on Signals`);
      return;
    }
    this.busy.set(true);
    try {
      const prices = parsePriceListText(this.pricesText);
      const id = await this.watchSvc.create({
        symbol,
        name: stock.name || symbol,
        isin: stock.isin,
        prices,
      });
      await this.registrySvc.ensureListed(symbol, { name: stock.name, isin: stock.isin });
      this.picked = null;
      this.query = '';
      this.pricesText = '';
      this.expandedId.set(id);
      this.toast.success(`Added ${symbol}`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Could not add stock');
    } finally {
      this.busy.set(false);
    }
  }

  async savePrices(row: SignalRow, raw: string): Promise<void> {
    const prices = parsePriceListText(raw);
    try {
      await this.watchSvc.update(row.id, { prices });
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Could not save prices');
    }
  }

  async saveGuidance(row: SignalRow, field: 'guidanceProfit' | 'guidanceSales', value: string): Promise<void> {
    try {
      await this.watchSvc.update(row.id, { [field]: value });
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Could not save guidance');
    }
  }

  async addBroker(row: SignalRow): Promise<void> {
    const broker = this.brokerName.trim();
    const price = parseFloat(this.brokerPrice.replace(/,/g, ''));
    if (!broker || !Number.isFinite(price) || price <= 0) {
      this.toast.error('Enter broker name and a price');
      return;
    }
    const next: SignalBrokerTarget[] = [...row.brokerTargets, { broker, price: Math.round(price * 100) / 100 }];
    try {
      await this.watchSvc.update(row.id, { brokerTargets: next });
      this.brokerName = '';
      this.brokerPrice = '';
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Could not save target');
    }
  }

  async removeBroker(row: SignalRow, index: number): Promise<void> {
    const next = row.brokerTargets.filter((_, i) => i !== index);
    try {
      await this.watchSvc.update(row.id, { brokerTargets: next });
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Could not remove target');
    }
  }

  async removeWatch(row: SignalRow, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (!confirm(`Remove ${row.symbol} from Signals?`)) return;
    try {
      await this.watchSvc.remove(row.id);
      if (this.expandedId() === row.id) this.expandedId.set(null);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Could not remove stock');
    }
  }

  async refreshAll(): Promise<void> {
    const symbols = this.dbWatches().map((row) => row.symbol);
    if (!symbols.length || this.refreshBusy()) return;
    this.refreshBusy.set(true);
    const failed: string[] = [];
    let updated = 0;
    try {
      const overlay: RegistryStock[] = [];
      for (const symbol of symbols) {
        try {
          const existing = await this.registrySvc.getBySymbol(symbol);
          const data = await this.screenerSvc.fetchStock(symbol, {
            isin: existing?.isin,
            name: existing?.name,
            pageUrl: existing?.screenerUrl,
          });
          const next = applyScreener(existing, data, symbol);
          await this.registrySvc.save(next);
          overlay.push(next);
          updated += 1;
        } catch {
          failed.push(symbol);
        }
      }
      this.refreshedRegistry.update((rows) => {
        const map = new Map(rows.map((s) => [s.symbol.toUpperCase(), s]));
        for (const stock of overlay) map.set(stock.symbol.toUpperCase(), stock);
        return [...map.values()];
      });
      this.registrySvc.reload();
      const failNote = failed.length
        ? ` ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}.`
        : '';
      const message = `Refreshed ${updated} stock${updated === 1 ? '' : 's'}.${failNote}`;
      if (failed.length) this.toast.error(message);
      else this.toast.success(message);
    } finally {
      this.refreshBusy.set(false);
    }
  }

  guidanceProfit(row: SignalRow): string {
    if (row.guidanceProfit.trim()) return row.guidanceProfit;
    return formatAnalysisChange(row.registry?.profitGrowthTtm ?? row.analysis.netProfit?.yoyChange ?? null, 'currency');
  }

  guidanceSales(row: SignalRow): string {
    if (row.guidanceSales.trim()) return row.guidanceSales;
    return formatAnalysisChange(row.registry?.salesGrowthTtm ?? row.analysis.sales?.yoyChange ?? null, 'currency');
  }
}

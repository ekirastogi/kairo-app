import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, from, switchMap } from 'rxjs';
import { RegistryStock } from '../../models/trading-journal.models';
import { StockSummary } from '../../models/trade.models';
import { FilteredStockService } from '../../services/filtered-stock.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ReportStateService } from '../../services/report-state.service';
import { ToastService } from '../../services/toast.service';
import { analysePnlTierInfo } from '../../utils/pnl-watchlist.utils';
import { formatCurrency, formatPrice, pnlClass } from '../../utils/format.utils';
import { readJson, writeJson } from '../../utils/local-store.utils';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';
import { ErrorBannerComponent } from '../shared/error-banner/error-banner.component';

const AOP_STORE_KEY = 'kairo-aop-targets-v1';

interface AopTarget {
  id: string;
  symbol: string;
  name: string;
  isin?: string;
  targetProfit: number;
  createdAt: number;
}

interface AopRow extends AopTarget {
  cmp: number | null;
  netPnL: number;
  currentTier: string;
  nextTier: string;
  afterPnL: number;
  newTier: string;
}

function loadTargets(): AopTarget[] {
  const rows = readJson<AopTarget[]>(AOP_STORE_KEY, []);
  return Array.isArray(rows) ? rows : [];
}

@Component({
  selector: 'app-aop',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, StockSearchInputComponent, ErrorBannerComponent],
  templateUrl: './aop.component.html',
  host: { class: 'block' },
})
export class AopComponent implements OnInit {
  readonly state = inject(ReportStateService);
  readonly filteredStocks = inject(FilteredStockService);
  private registrySvc = inject(RegistryStockService);
  private toast = inject(ToastService);

  readonly formatCurrency = formatCurrency;
  readonly formatPrice = formatPrice;
  readonly pnlClass = pnlClass;

  query = '';
  targetProfit = '';
  picked: RegistryStock | null = null;
  targets = signal<AopTarget[]>(loadTargets());

  async ngOnInit(): Promise<void> {
    await this.state.ensureLoadedFromFirebase();
  }

  private symbolKey = computed(() =>
    [...new Set(this.targets().map((row) => row.symbol.trim().toUpperCase()).filter(Boolean))]
      .sort()
      .join('\0')
  );

  private registry = toSignal(
    toObservable(this.symbolKey).pipe(
      distinctUntilChanged(),
      switchMap((key) => from(this.registrySvc.listBySymbols(key ? key.split('\0') : [])))
    ),
    { initialValue: [] as RegistryStock[] }
  );

  rows = computed((): AopRow[] => {
    const stocks = this.filteredStocks.stocks();
    const prices = new Map(
      this.registry().map((stock) => [stock.symbol.toUpperCase(), stock.currentPrice])
    );
    return this.targets().map((row) => {
      const summary = this.matchSummary(stocks, row);
      const netPnL = summary?.netPnL ?? 0;
      const target = row.targetProfit > 0 ? row.targetProfit : 0;
      const afterPnL = netPnL + target;
      const current = analysePnlTierInfo(netPnL);
      const next = analysePnlTierInfo(afterPnL);
      const cmp = prices.get(row.symbol.toUpperCase());
      return {
        ...row,
        cmp: cmp && cmp > 0 ? cmp : null,
        netPnL,
        currentTier: current.label,
        nextTier: current.nextLabel ?? '—',
        afterPnL,
        newTier: next.label,
      };
    });
  });

  extraStocks(): RegistryStock[] {
    return this.picked ? [this.picked] : [];
  }

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

  addTarget(): void {
    const stock = this.picked;
    if (!stock) {
      this.toast.error('Pick a registry stock');
      return;
    }
    const profit = parseFloat(this.targetProfit);
    if (!(profit > 0)) {
      this.toast.error('Enter a target profit');
      return;
    }
    const symbol = stock.symbol.trim().toUpperCase();
    if (this.targets().some((row) => row.symbol.toUpperCase() === symbol)) {
      this.toast.error(`${symbol} is already on AOP`);
      return;
    }
    this.targets.update((rows) => [
      {
        id: crypto.randomUUID(),
        symbol,
        name: stock.name || symbol,
        isin: stock.isin,
        targetProfit: profit,
        createdAt: Date.now(),
      },
      ...rows,
    ]);
    this.persist();
    this.query = '';
    this.targetProfit = '';
    this.picked = null;
    this.toast.success(`Added ${symbol}`);
  }

  setTargetProfit(id: string, value: string | number): void {
    const profit = typeof value === 'number' ? value : parseFloat(value);
    this.targets.update((rows) =>
      rows.map((row) =>
        row.id === id ? { ...row, targetProfit: profit > 0 ? profit : 0 } : row
      )
    );
    this.persist();
  }

  removeTarget(id: string): void {
    this.targets.update((rows) => rows.filter((row) => row.id !== id));
    this.persist();
  }

  private persist(): void {
    writeJson(AOP_STORE_KEY, this.targets());
  }

  private matchSummary(stocks: StockSummary[], row: AopTarget): StockSummary | undefined {
    const symbol = row.symbol.toUpperCase();
    const isin = (row.isin || '').toUpperCase();
    return (
      stocks.find((stock) => (stock.symbol || '').toUpperCase() === symbol) ??
      stocks.find((stock) => isin && (stock.isin || '').toUpperCase() === isin) ??
      stocks.find((stock) => (stock.stockName || '').toUpperCase() === row.name.toUpperCase())
    );
  }
}

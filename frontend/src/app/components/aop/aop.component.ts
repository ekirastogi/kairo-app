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
import {
  AopKind,
  aopAddDestinations,
  aopKindOf,
  aopMonthKeyFromIso,
  aopMonthOptions,
  aopPeriodHint,
  aopPeriodLabel,
  aopTodayIso,
  aopWeekKeyFromIso,
  aopWeekOptions,
  aopWritableKeys,
} from '../../utils/aop-period.utils';
import { analysePnlTierInfo } from '../../utils/pnl-watchlist.utils';
import { formatCurrency, formatPrice, pnlClass } from '../../utils/format.utils';
import { readJson, writeJson } from '../../utils/local-store.utils';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';
import { ErrorBannerComponent } from '../shared/error-banner/error-banner.component';

const AOP_STORE_V1 = 'kairo-aop-targets-v1';
const AOP_STORE_V2 = 'kairo-aop-targets-v2';

interface AopTarget {
  id: string;
  symbol: string;
  name: string;
  isin?: string;
  targetProfit: number;
  createdAt: number;
  periodKey: string;
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
  const v2 = readJson<AopTarget[] | null>(AOP_STORE_V2, null);
  if (Array.isArray(v2)) return v2;
  const v1 = readJson<Array<Omit<AopTarget, 'periodKey'>>>(AOP_STORE_V1, []);
  if (!Array.isArray(v1) || !v1.length) return [];
  const week = aopWeekKeyFromIso(aopTodayIso());
  const migrated = v1.map((row) => ({ ...row, periodKey: week }));
  writeJson(AOP_STORE_V2, migrated);
  return migrated;
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

  private todayIso = aopTodayIso();
  readonly addDestinations = aopAddDestinations(this.todayIso);
  readonly writableKeys = new Set(aopWritableKeys(this.todayIso));

  query = '';
  targetProfit = '';
  picked: RegistryStock | null = null;
  targets = signal<AopTarget[]>(loadTargets());
  viewKind = signal<AopKind>('week');
  viewKey = signal(aopWeekKeyFromIso(this.todayIso));
  addKey = signal(aopWeekKeyFromIso(this.todayIso));

  async ngOnInit(): Promise<void> {
    await this.state.ensureLoadedFromFirebase();
  }

  periodTabs = computed(() => {
    const keys = [...new Set(this.targets().map((row) => row.periodKey))];
    return this.viewKind() === 'month'
      ? aopMonthOptions(keys, this.todayIso)
      : aopWeekOptions(keys, this.todayIso);
  });

  viewLabel = computed(() => aopPeriodLabel(this.viewKey(), this.todayIso));
  viewHint = computed(() => aopPeriodHint(this.viewKey()));
  viewWritable = computed(() => this.writableKeys.has(this.viewKey()));

  periodTargets = computed(() =>
    this.targets().filter((row) => row.periodKey === this.viewKey())
  );

  periodTotal = computed(() =>
    this.periodTargets().reduce((sum, row) => sum + (row.targetProfit > 0 ? row.targetProfit : 0), 0)
  );

  private symbolKey = computed(() =>
    [...new Set(this.periodTargets().map((row) => row.symbol.trim().toUpperCase()).filter(Boolean))]
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
    return this.periodTargets().map((row) => {
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

  setViewKind(kind: AopKind): void {
    this.viewKind.set(kind);
    const tabs = kind === 'month'
      ? aopMonthOptions(this.storedKeys(), this.todayIso)
      : aopWeekOptions(this.storedKeys(), this.todayIso);
    const preferred = kind === 'month' ? aopMonthKeyFromIso(this.todayIso) : aopWeekKeyFromIso(this.todayIso);
    const next =
      tabs.find((tab) => tab.key === this.viewKey()) ??
      tabs.find((tab) => tab.key === preferred) ??
      tabs[0];
    if (next) this.selectPeriod(next.key);
  }

  selectPeriod(key: string): void {
    this.viewKey.set(key);
    this.viewKind.set(aopKindOf(key));
    if (this.writableKeys.has(key)) this.addKey.set(key);
  }

  setAddKey(key: string): void {
    this.addKey.set(key);
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
    const periodKey = this.addKey();
    if (!this.writableKeys.has(periodKey)) {
      this.toast.error('You can only add AOP for this week, next week, or this month');
      return;
    }
    const symbol = stock.symbol.trim().toUpperCase();
    if (this.targets().some((row) => row.periodKey === periodKey && row.symbol.toUpperCase() === symbol)) {
      this.toast.error(`${symbol} is already on ${aopPeriodLabel(periodKey, this.todayIso)}`);
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
        periodKey,
      },
      ...rows,
    ]);
    this.persist();
    this.query = '';
    this.targetProfit = '';
    this.picked = null;
    this.selectPeriod(periodKey);
    this.toast.success(`Added ${symbol} to ${aopPeriodLabel(periodKey, this.todayIso)}`);
  }

  setTargetProfit(id: string, value: string | number): void {
    const profit = typeof value === 'number' ? value : parseFloat(value);
    this.targets.update((rows) =>
      rows.map((row) => (row.id === id ? { ...row, targetProfit: profit > 0 ? profit : 0 } : row))
    );
    this.persist();
  }

  removeTarget(id: string): void {
    this.targets.update((rows) => rows.filter((row) => row.id !== id));
    this.persist();
  }

  private storedKeys(): string[] {
    return [...new Set(this.targets().map((row) => row.periodKey))];
  }

  private persist(): void {
    writeJson(AOP_STORE_V2, this.targets());
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

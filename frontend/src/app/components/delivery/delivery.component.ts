import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, from, switchMap } from 'rxjs';
import { RegistryStock } from '../../models/trading-journal.models';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ToastService } from '../../services/toast.service';
import { formatCurrency, formatPrice } from '../../utils/format.utils';
import { readJson, writeJson } from '../../utils/local-store.utils';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';
import { CmpRefreshButtonComponent, CmpRefreshStock } from '../shared/cmp-refresh-button/cmp-refresh-button.component';

const DELIVERY_STORE = 'kairo-delivery-buys-v1';

interface DeliveryPlan {
  id: string;
  symbol: string;
  name: string;
  isin?: string;
  quantity: number;
  targetPrice: number;
  boughtQty: number;
  createdAt: number;
}

interface DeliveryRow extends DeliveryPlan {
  cmp: number | null;
  remainingQty: number;
  pctAchieved: number | null;
  amountRequired: number;
  remainingAmount: number;
  currentAmount: number | null;
}

function loadPlans(): DeliveryPlan[] {
  const rows = readJson<DeliveryPlan[] | null>(DELIVERY_STORE, null);
  return Array.isArray(rows) ? rows : [];
}

function parsePositive(value: string | number): number {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseNonNegative(value: string | number): number {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

@Component({
  selector: 'app-delivery',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, StockSearchInputComponent, CmpRefreshButtonComponent],
  templateUrl: './delivery.component.html',
  host: { class: 'block' },
})
export class DeliveryComponent {
  private registrySvc = inject(RegistryStockService);
  private toast = inject(ToastService);

  readonly formatCurrency = formatCurrency;
  readonly formatPrice = formatPrice;

  query = '';
  quantity = '';
  targetPrice = '';
  picked: RegistryStock | null = null;
  plans = signal<DeliveryPlan[]>(loadPlans());
  private cmpOverlay = signal<RegistryStock[]>([]);

  private symbolKey = computed(() =>
    [...new Set(this.plans().map((row) => row.symbol.trim().toUpperCase()).filter(Boolean))]
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

  cmpStocks = computed((): CmpRefreshStock[] => {
    const overlay = new Map(this.cmpOverlay().map((stock) => [stock.symbol.toUpperCase(), stock]));
    const listed = new Map(this.registry().map((stock) => [stock.symbol.toUpperCase(), stock]));
    return this.plans().map((row) => {
      const symbol = row.symbol.toUpperCase();
      const reg = overlay.get(symbol) ?? listed.get(symbol);
      return {
        symbol,
        name: row.name,
        isin: row.isin ?? reg?.isin,
        updatedAt: reg?.updatedAt,
      };
    });
  });

  rows = computed((): DeliveryRow[] => {
    const overlay = new Map(this.cmpOverlay().map((stock) => [stock.symbol.toUpperCase(), stock.currentPrice]));
    const listed = new Map(this.registry().map((stock) => [stock.symbol.toUpperCase(), stock.currentPrice]));
    return this.plans().map((row) => {
      const qty = row.quantity > 0 ? row.quantity : 0;
      const bought = Math.min(row.boughtQty > 0 ? row.boughtQty : 0, qty || Infinity);
      const remainingQty = Math.max(0, qty - bought);
      const target = row.targetPrice > 0 ? row.targetPrice : 0;
      const cmp = overlay.get(row.symbol.toUpperCase()) ?? listed.get(row.symbol.toUpperCase());
      const live = cmp && cmp > 0 ? cmp : null;
      return {
        ...row,
        cmp: live,
        remainingQty,
        pctAchieved: qty > 0 ? (bought / qty) * 100 : null,
        amountRequired: qty * target,
        remainingAmount: remainingQty * target,
        currentAmount: live != null && bought > 0 ? bought * live : bought > 0 && target > 0 ? bought * target : null,
      };
    });
  });

  totalRequired = computed(() => this.rows().reduce((sum, row) => sum + row.amountRequired, 0));
  totalRemaining = computed(() => this.rows().reduce((sum, row) => sum + row.remainingAmount, 0));
  totalCurrent = computed(() =>
    this.rows().reduce((sum, row) => sum + (row.currentAmount ?? 0), 0)
  );
  totalPct = computed(() => {
    const qty = this.rows().reduce((sum, row) => sum + (row.quantity > 0 ? row.quantity : 0), 0);
    const bought = this.rows().reduce((sum, row) => sum + Math.min(row.boughtQty > 0 ? row.boughtQty : 0, row.quantity || 0), 0);
    return qty > 0 ? (bought / qty) * 100 : null;
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
    if (!this.targetPrice && stock.currentPrice > 0) {
      this.targetPrice = String(stock.currentPrice);
    }
  }

  addPlan(): void {
    const stock = this.picked;
    if (!stock) {
      this.toast.error('Pick a registry stock');
      return;
    }
    const quantity = parsePositive(this.quantity);
    if (!(quantity > 0)) {
      this.toast.error('Enter quantity');
      return;
    }
    const targetPrice = parsePositive(this.targetPrice);
    if (!(targetPrice > 0)) {
      this.toast.error('Enter a target buy price');
      return;
    }
    const symbol = stock.symbol.trim().toUpperCase();
    if (this.plans().some((row) => row.symbol.toUpperCase() === symbol)) {
      this.toast.error(`${symbol} is already on the delivery list`);
      return;
    }
    this.plans.update((rows) => [
      {
        id: crypto.randomUUID(),
        symbol,
        name: stock.name || symbol,
        isin: stock.isin,
        quantity,
        targetPrice,
        boughtQty: 0,
        createdAt: Date.now(),
      },
      ...rows,
    ]);
    this.persist();
    this.query = '';
    this.quantity = '';
    this.targetPrice = '';
    this.picked = null;
    this.toast.success(`Added ${symbol}`);
  }

  setQuantity(id: string, value: string | number): void {
    const quantity = parsePositive(value);
    this.plans.update((rows) =>
      rows.map((row) => {
        if (row.id !== id) return row;
        const boughtQty = Math.min(row.boughtQty, quantity);
        return { ...row, quantity, boughtQty };
      })
    );
    this.persist();
  }

  setTargetPrice(id: string, value: string | number): void {
    const targetPrice = parsePositive(value);
    this.plans.update((rows) =>
      rows.map((row) => (row.id === id ? { ...row, targetPrice } : row))
    );
    this.persist();
  }

  setBoughtQty(id: string, value: string | number): void {
    const boughtQty = parseNonNegative(value);
    this.plans.update((rows) =>
      rows.map((row) => {
        if (row.id !== id) return row;
        return { ...row, boughtQty: row.quantity > 0 ? Math.min(boughtQty, row.quantity) : boughtQty };
      })
    );
    this.persist();
  }

  removePlan(id: string): void {
    this.plans.update((rows) => rows.filter((row) => row.id !== id));
    this.persist();
  }

  onCmpRefreshed(updated: RegistryStock[]): void {
    const next = new Map(this.cmpOverlay().map((stock) => [stock.symbol.toUpperCase(), stock]));
    for (const stock of updated) next.set(stock.symbol.toUpperCase(), stock);
    this.cmpOverlay.set([...next.values()]);
  }

  private persist(): void {
    writeJson(DELIVERY_STORE, this.plans());
  }
}

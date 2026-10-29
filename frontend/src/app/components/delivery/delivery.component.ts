import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, from, switchMap } from 'rxjs';
import { RegistryStock } from '../../models/trading-journal.models';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ToastService } from '../../services/toast.service';
import { formatCurrency, formatDate, formatPrice } from '../../utils/format.utils';
import { istTodayIso } from '../../utils/market-calendar.utils';
import { readJson, writeJson } from '../../utils/local-store.utils';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';
import { CmpRefreshButtonComponent, CmpRefreshStock } from '../shared/cmp-refresh-button/cmp-refresh-button.component';

const DELIVERY_STORE = 'kairo-delivery-buys-v1';

interface DeliveryFill {
  id: string;
  quantity: number;
  boughtOn: string;
  createdAt: number;
}

interface DeliveryPlan {
  id: string;
  symbol: string;
  name: string;
  isin?: string;
  quantity: number;
  targetPrice: number;
  boughtQty: number;
  fills: DeliveryFill[];
  createdAt: number;
}

interface DeliveryRow extends DeliveryPlan {
  sno: number;
  cmp: number | null;
  remainingQty: number;
  pctAchieved: number | null;
  amountRequired: number;
  remainingAmount: number;
  currentAmount: number | null;
  boughtDates: string[];
}

function fillTotal(fills: DeliveryFill[]): number {
  return fills.reduce((sum, fill) => sum + (fill.quantity > 0 ? fill.quantity : 0), 0);
}

function isoFromMs(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function normalizeFill(fill: Partial<DeliveryFill> & { quantity: number; createdAt: number }): DeliveryFill {
  return {
    id: fill.id || crypto.randomUUID(),
    quantity: fill.quantity,
    boughtOn: fill.boughtOn || isoFromMs(fill.createdAt),
    createdAt: fill.createdAt,
  };
}

function loadPlans(): DeliveryPlan[] {
  const rows = readJson<Array<Partial<DeliveryPlan> & { id: string; symbol: string; name: string; quantity: number; targetPrice: number; createdAt: number }> | null>(
    DELIVERY_STORE,
    null
  );
  if (!Array.isArray(rows)) return [];
  let changed = false;
  const next = rows.map((row) => {
    const rawFills = Array.isArray(row.fills)
      ? row.fills
      : row.boughtQty && row.boughtQty > 0
        ? [{ id: crypto.randomUUID(), quantity: row.boughtQty, createdAt: row.createdAt, boughtOn: isoFromMs(row.createdAt) }]
        : [];
    const fills = rawFills.map((fill) => normalizeFill(fill));
    if (!Array.isArray(row.fills) || fills.some((fill, i) => fill.boughtOn !== rawFills[i]?.boughtOn)) changed = true;
    const boughtQty = fillTotal(fills);
    if (boughtQty !== (row.boughtQty ?? 0)) changed = true;
    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      isin: row.isin,
      quantity: row.quantity,
      targetPrice: row.targetPrice,
      boughtQty,
      fills,
      createdAt: row.createdAt,
    } satisfies DeliveryPlan;
  });
  if (changed) writeJson(DELIVERY_STORE, next);
  return next;
}

function parsePositive(value: string | number): number {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

@Component({
  selector: 'app-delivery',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, StockSearchInputComponent, CmpRefreshButtonComponent],
  templateUrl: './delivery.component.html',
  host: { class: 'block' },
  styles: `
    .dl-drawer { position: fixed; inset: 0; z-index: 50; display: flex; justify-content: flex-end; }
    .dl-drawer-scrim { position: absolute; inset: 0; background: rgb(15 23 42 / 0.4); }
    .dl-drawer-panel {
      position: relative;
      height: 100%;
      width: min(50vw, 100%);
      overflow-y: auto;
      background: #fff;
      box-shadow: -12px 0 40px rgb(15 23 42 / 0.18);
    }
    @media (max-width: 640px) {
      .dl-drawer-panel { width: 100%; }
    }
  `,
})
export class DeliveryComponent {
  private registrySvc = inject(RegistryStockService);
  private toast = inject(ToastService);

  readonly formatCurrency = formatCurrency;
  readonly formatPrice = formatPrice;
  readonly formatDate = formatDate;

  query = '';
  quantity = '';
  targetPrice = '';
  picked: RegistryStock | null = null;
  plans = signal<DeliveryPlan[]>(loadPlans());
  drawerId = signal<string | null>(null);
  addQty = '';
  addDate = istTodayIso();
  private cmpOverlay = signal<RegistryStock[]>([]);

  drawerRow = computed(() => this.rows().find((row) => row.id === this.drawerId()) ?? null);

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
    return this.plans().map((row, index) => {
      const qty = row.quantity > 0 ? row.quantity : 0;
      const bought = Math.min(row.boughtQty > 0 ? row.boughtQty : 0, qty || Infinity);
      const remainingQty = Math.max(0, qty - bought);
      const target = row.targetPrice > 0 ? row.targetPrice : 0;
      const cmp = overlay.get(row.symbol.toUpperCase()) ?? listed.get(row.symbol.toUpperCase());
      const live = cmp && cmp > 0 ? cmp : null;
      const boughtDates = [...new Set(row.fills.map((fill) => fill.boughtOn).filter(Boolean))].sort();
      return {
        ...row,
        sno: index + 1,
        cmp: live,
        remainingQty,
        pctAchieved: qty > 0 ? (bought / qty) * 100 : null,
        amountRequired: qty * target,
        remainingAmount: remainingQty * target,
        currentAmount: live != null && bought > 0 ? bought * live : bought > 0 && target > 0 ? bought * target : null,
        boughtDates,
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
        fills: [],
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
        let remaining = quantity;
        const fills: DeliveryFill[] = [];
        for (const fill of row.fills) {
          if (!(remaining > 0)) break;
          const qty = Math.min(fill.quantity, remaining);
          fills.push({ ...fill, quantity: qty });
          remaining -= qty;
        }
        return { ...row, quantity, fills, boughtQty: fillTotal(fills) };
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

  openAddQty(id: string): void {
    this.drawerId.set(id);
    this.addQty = '';
    this.addDate = istTodayIso();
  }

  closeDrawer(): void {
    this.drawerId.set(null);
    this.addQty = '';
    this.addDate = istTodayIso();
  }

  addBoughtQty(): void {
    const row = this.drawerRow();
    if (!row) return;
    const added = parsePositive(this.addQty);
    if (!(added > 0)) {
      this.toast.error('Enter quantity added');
      return;
    }
    const remaining = row.remainingQty;
    if (!(remaining > 0)) {
      this.toast.error('Target quantity is already filled');
      return;
    }
    if (added > remaining) {
      this.toast.error(`Only ${remaining} remaining`);
      return;
    }
    const boughtOn = this.addDate.trim() || istTodayIso();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(boughtOn)) {
      this.toast.error('Enter a valid buy date');
      return;
    }
    this.plans.update((rows) =>
      rows.map((plan) => {
        if (plan.id !== row.id) return plan;
        const fills = [...plan.fills, { id: crypto.randomUUID(), quantity: added, boughtOn, createdAt: Date.now() }];
        return { ...plan, fills, boughtQty: fillTotal(fills) };
      })
    );
    this.persist();
    this.addQty = '';
    this.toast.success(`Added ${added} to ${row.symbol}`);
  }

  removeFill(fillId: string): void {
    const row = this.drawerRow();
    if (!row) return;
    this.plans.update((rows) =>
      rows.map((plan) => {
        if (plan.id !== row.id) return plan;
        const fills = plan.fills.filter((fill) => fill.id !== fillId);
        return { ...plan, fills, boughtQty: fillTotal(fills) };
      })
    );
    this.persist();
  }

  removePlan(id: string): void {
    if (this.drawerId() === id) this.closeDrawer();
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

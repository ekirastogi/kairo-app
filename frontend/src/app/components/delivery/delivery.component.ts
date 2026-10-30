import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, from, switchMap } from 'rxjs';
import { RegistryStock } from '../../models/trading-journal.models';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ToastService } from '../../services/toast.service';
import { DeliveryFill, DeliveryPlan, DeliveryService } from '../../services/delivery.service';
import { formatCurrency, formatDate, formatPrice } from '../../utils/format.utils';
import { istTodayIso } from '../../utils/market-calendar.utils';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';
import { CmpRefreshButtonComponent, CmpRefreshStock } from '../shared/cmp-refresh-button/cmp-refresh-button.component';

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
  private deliverySvc = inject(DeliveryService);
  private toast = inject(ToastService);
  private pending = signal<Record<string, Partial<DeliveryPlan>>>({});
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly formatCurrency = formatCurrency;
  readonly formatPrice = formatPrice;
  readonly formatDate = formatDate;

  query = '';
  quantity = '';
  targetPrice = '';
  picked: RegistryStock | null = null;
  private dbPlans = toSignal(this.deliverySvc.watchAll(), { initialValue: [] as DeliveryPlan[] });
  drawerId = signal<string | null>(null);
  addQty = '';
  addDate = istTodayIso();
  busy = signal(false);
  private cmpOverlay = signal<RegistryStock[]>([]);

  plans = computed(() => {
    const pending = this.pending();
    return this.dbPlans().map((row) => (pending[row.id] ? { ...row, ...pending[row.id] } : row));
  });

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

  async addPlan(): Promise<void> {
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
    this.busy.set(true);
    try {
      await this.deliverySvc.create({
        symbol,
        name: stock.name || symbol,
        isin: stock.isin,
        quantity,
        targetPrice,
      });
      this.query = '';
      this.quantity = '';
      this.targetPrice = '';
      this.picked = null;
      this.toast.success(`Added ${symbol}`);
    } catch (error) {
      this.toast.error(error instanceof Error ? error.message : 'Could not add delivery buy');
    } finally {
      this.busy.set(false);
    }
  }

  setQuantity(id: string, value: string | number): void {
    const quantity = parsePositive(value);
    const current = this.plans().find((row) => row.id === id);
    if (!current) return;
    let remaining = quantity;
    const fills: DeliveryFill[] = [];
    for (const fill of current.fills) {
      if (!(remaining > 0)) break;
      const qty = Math.min(fill.quantity, remaining);
      fills.push({ ...fill, quantity: qty });
      remaining -= qty;
    }
    this.patchLocal(id, { quantity, fills, boughtQty: fillTotal(fills) });
    this.queueSave(id);
  }

  setTargetPrice(id: string, value: string | number): void {
    const targetPrice = parsePositive(value);
    this.patchLocal(id, { targetPrice });
    this.queueSave(id);
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

  async addBoughtQty(): Promise<void> {
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
    const fills = [...row.fills, { id: crypto.randomUUID(), quantity: added, boughtOn, createdAt: Date.now() }];
    this.patchLocal(row.id, { fills, boughtQty: fillTotal(fills) });
    try {
      await this.deliverySvc.update(row.id, { fills });
      this.clearPending(row.id);
      this.addQty = '';
      this.toast.success(`Added ${added} to ${row.symbol}`);
    } catch (error) {
      this.toast.error(error instanceof Error ? error.message : 'Could not save quantity');
    }
  }

  async removeFill(fillId: string): Promise<void> {
    const row = this.drawerRow();
    if (!row) return;
    const fills = row.fills.filter((fill) => fill.id !== fillId);
    this.patchLocal(row.id, { fills, boughtQty: fillTotal(fills) });
    try {
      await this.deliverySvc.update(row.id, { fills });
      this.clearPending(row.id);
    } catch (error) {
      this.toast.error(error instanceof Error ? error.message : 'Could not update lots');
    }
  }

  async removePlan(id: string): Promise<void> {
    if (this.drawerId() === id) this.closeDrawer();
    this.busy.set(true);
    try {
      await this.deliverySvc.remove(id);
      this.clearPending(id);
    } catch (error) {
      this.toast.error(error instanceof Error ? error.message : 'Could not remove stock');
    } finally {
      this.busy.set(false);
    }
  }

  onCmpRefreshed(updated: RegistryStock[]): void {
    const next = new Map(this.cmpOverlay().map((stock) => [stock.symbol.toUpperCase(), stock]));
    for (const stock of updated) next.set(stock.symbol.toUpperCase(), stock);
    this.cmpOverlay.set([...next.values()]);
  }

  private patchLocal(id: string, patch: Partial<DeliveryPlan>): void {
    this.pending.update((rows) => ({ ...rows, [id]: { ...rows[id], ...patch } }));
  }

  private clearPending(id: string): void {
    this.pending.update((rows) => {
      if (!(id in rows)) return rows;
      const next = { ...rows };
      delete next[id];
      return next;
    });
  }

  private queueSave(id: string): void {
    const prev = this.saveTimers.get(id);
    if (prev) clearTimeout(prev);
    this.saveTimers.set(
      id,
      setTimeout(() => {
        this.saveTimers.delete(id);
        void this.flushSave(id);
      }, 400)
    );
  }

  private async flushSave(id: string): Promise<void> {
    const pending = this.pending()[id];
    if (!pending) return;
    try {
      await this.deliverySvc.update(id, {
        quantity: pending.quantity,
        targetPrice: pending.targetPrice,
        fills: pending.fills,
      });
      this.clearPending(id);
    } catch (error) {
      this.toast.error(error instanceof Error ? error.message : 'Could not save delivery buy');
    }
  }
}

import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import { MomentumStock, MomentumCatalyst, RegistryStock } from '../../models/trading-journal.models';
import { MomentumStockService } from '../../services/momentum-stock.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { StockFirestoreService } from '../../services/stock-firestore.service';
import { TradePlanService } from '../../services/trade-plan.service';
import { formatCurrency, formatPctSigned, pnlClass } from '../../utils/format.utils';

const CATALYST_OPTIONS: { id: MomentumCatalyst; label: string }[] = [
  { id: 'earnings_beat', label: 'Earnings beat' },
  { id: 'guidance_raise', label: 'Guidance raise' },
  { id: 'result_surprise', label: 'Result surprise' },
  { id: 'sector_momentum', label: 'Sector momentum' },
  { id: 'breakout', label: 'Technical breakout' },
  { id: 'other', label: 'Other' },
];

@Component({
  selector: 'app-momentum-stocks',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './momentum-stocks.component.html',
})
export class MomentumStocksComponent implements OnInit {
  private momentumSvc = inject(MomentumStockService);
  private registrySvc = inject(RegistryStockService);
  private stockSvc = inject(StockFirestoreService);
  private planSvc = inject(TradePlanService);
  private router = inject(Router);

  stocks = toSignal(this.momentumSvc.watchAll(), { initialValue: [] as MomentumStock[] });
  registry = signal<RegistryStock[]>([]);

  showForm = signal(false);
  editingId = signal<string | null>(null);
  searchQuery = signal('');
  busy = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);
  symbolQuery = signal('');

  readonly catalystOptions = CATALYST_OPTIONS;
  fmt = formatCurrency;
  fmtPct = formatPctSigned;
  pnlClass = pnlClass;

  form = {
    symbol: '',
    name: '',
    cmp: '',
    entryPrice: '',
    targetPrice: '',
    stopLoss: '',
    quantity: '1',
    catalyst: 'earnings_beat' as MomentumCatalyst,
    resultDate: '',
    notes: '',
  };

  filteredStocks = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    let rows = this.stocks();
    if (q) {
      rows = rows.filter(
        (s) =>
          s.symbol.toLowerCase().includes(q) ||
          (s.stockName ?? '').toLowerCase().includes(q) ||
          (s.notes ?? '').toLowerCase().includes(q)
      );
    }
    return [...rows].sort((a, b) => {
      const dateA = a.resultDate ?? '';
      const dateB = b.resultDate ?? '';
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return b.updatedAt - a.updatedAt;
    });
  });

  symbolOptions = computed(() => {
    const q = this.symbolQuery().trim().toLowerCase();
    const rows = this.registry();
    if (!q) return rows.slice(0, 25);
    return rows
      .filter(
        (s) =>
          s.symbol.toLowerCase().includes(q) ||
          (s.name ?? '').toLowerCase().includes(q) ||
          (s.exchange ?? 'NSE').toLowerCase().includes(q)
      )
      .slice(0, 25);
  });

  async ngOnInit(): Promise<void> {
    try {
      this.registry.set(await this.registrySvc.listAll());
    } catch {
      // Symbol search falls back to manual entry.
    }
  }

  catalystLabel(id?: MomentumCatalyst): string {
    return CATALYST_OPTIONS.find((c) => c.id === id)?.label ?? 'Momentum';
  }

  upsidePct(stock: MomentumStock): number | null {
    const base = stock.entryPrice ?? stock.cmp;
    if (!base || !stock.targetPrice) return null;
    return ((stock.targetPrice - base) / base) * 100;
  }

  estPnL(stock: MomentumStock): number | null {
    const entry = stock.entryPrice ?? stock.cmp;
    if (!entry || !stock.targetPrice || !stock.quantity) return null;
    return TradePlanService.estimatePnL('delivery', 'long', stock.quantity, entry, stock.targetPrice);
  }

  openAddForm(): void {
    this.resetForm();
    this.editingId.set(null);
    this.showForm.set(true);
    this.error.set(null);
    this.success.set(null);
  }

  openEditForm(stock: MomentumStock): void {
    this.editingId.set(stock.id);
    this.form.symbol = stock.symbol;
    this.form.name = stock.stockName ?? stock.symbol;
    this.symbolQuery.set(stock.symbol);
    this.form.cmp = stock.cmp != null ? String(stock.cmp) : '';
    this.form.entryPrice = stock.entryPrice != null ? String(stock.entryPrice) : '';
    this.form.targetPrice = stock.targetPrice != null ? String(stock.targetPrice) : '';
    this.form.stopLoss = stock.stopLoss != null ? String(stock.stopLoss) : '';
    this.form.quantity = String(stock.quantity || 1);
    this.form.catalyst = stock.catalyst ?? 'earnings_beat';
    this.form.resultDate = stock.resultDate ?? '';
    this.form.notes = stock.notes ?? '';
    this.showForm.set(true);
    this.error.set(null);
    this.success.set(null);
  }

  cancelForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
    this.resetForm();
  }

  onSymbolQuery(value: string): void {
    this.symbolQuery.set(value);
    const sym = value.trim().toUpperCase();
    this.form.symbol = sym;
    const entry = this.registry().find((s) => s.symbol === sym);
    if (entry) {
      this.form.name = entry.name;
      void this.prefillFromMarket(sym, entry);
    }
  }

  async pickSymbol(symbol: string): Promise<void> {
    this.symbolQuery.set(symbol.toUpperCase());
    this.form.symbol = symbol.toUpperCase();
    const entry = this.registry().find((s) => s.symbol === symbol.toUpperCase());
    this.form.name = entry?.name ?? symbol.toUpperCase();
    await this.prefillFromMarket(symbol, entry);
  }

  private async prefillFromMarket(symbol: string, registryEntry?: RegistryStock): Promise<void> {
    const cmp = await this.resolveCmp(symbol, registryEntry);
    if (cmp != null && cmp > 0) {
      if (!this.form.cmp) this.form.cmp = String(cmp);
      if (!this.form.entryPrice) this.form.entryPrice = String(cmp);
    }
    if (registryEntry?.resistances[0] && !this.form.targetPrice) {
      this.form.targetPrice = String(registryEntry.resistances[0]);
    }
    if (registryEntry?.supports[0] && !this.form.stopLoss) {
      this.form.stopLoss = String(registryEntry.supports[0]);
    }
  }

  private async resolveCmp(symbol: string, registryEntry?: RegistryStock): Promise<number | null> {
    if (registryEntry?.currentPrice && registryEntry.currentPrice > 0) {
      return registryEntry.currentPrice;
    }
    try {
      const snap = await firstValueFrom(this.stockSvc.watchStock(symbol).pipe(take(1)));
      return snap?.ltp && snap.ltp > 0 ? snap.ltp : null;
    } catch {
      return null;
    }
  }

  async refreshCmp(stock: MomentumStock): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const registryEntry = this.registry().find((s) => s.symbol === stock.symbol);
      const cmp = await this.resolveCmp(stock.symbol, registryEntry);
      if (cmp == null) throw new Error('No live price available');
      await this.momentumSvc.refreshCmp(stock.id, cmp);
      this.success.set(`Updated CMP for ${stock.symbol}`);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Failed to refresh CMP');
    } finally {
      this.busy.set(false);
    }
  }

  async saveStock(): Promise<void> {
    const symbol = this.form.symbol.trim().toUpperCase();
    const quantity = parseInt(this.form.quantity, 10);
    if (!symbol) {
      this.error.set('Symbol is required');
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    this.success.set(null);
    try {
      const cmp = parseFloat(this.form.cmp);
      const entryPrice = parseFloat(this.form.entryPrice);
      const targetPrice = parseFloat(this.form.targetPrice);
      const stopLoss = parseFloat(this.form.stopLoss);
      await this.momentumSvc.save(
        {
          symbol,
          stockName: this.form.name.trim() || symbol,
          cmp: Number.isFinite(cmp) && cmp > 0 ? cmp : undefined,
          entryPrice: Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : undefined,
          targetPrice: Number.isFinite(targetPrice) && targetPrice > 0 ? targetPrice : undefined,
          stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : undefined,
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
          catalyst: this.form.catalyst,
          resultDate: this.form.resultDate || undefined,
          notes: this.form.notes,
        },
        this.editingId() ?? undefined
      );
      this.success.set(this.editingId() ? 'Momentum stock updated' : 'Added to momentum list');
      this.cancelForm();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      this.busy.set(false);
    }
  }

  async removeStock(stock: MomentumStock): Promise<void> {
    if (!confirm(`Remove ${stock.symbol} from momentum list?`)) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.momentumSvc.remove(stock.id);
      this.success.set(`Removed ${stock.symbol}`);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Failed to remove');
    } finally {
      this.busy.set(false);
    }
  }

  canCreateOpenPlan(stock: MomentumStock): boolean {
    const entry = stock.entryPrice ?? stock.cmp;
    return !!(entry && entry > 0 && stock.targetPrice && stock.targetPrice > 0);
  }

  async createOpenTradePlan(stock: MomentumStock): Promise<void> {
    const entry = stock.entryPrice ?? stock.cmp;
    if (!entry || entry <= 0) {
      this.error.set('Set CMP or entry price before creating a trade plan');
      return;
    }
    if (!stock.targetPrice || stock.targetPrice <= 0) {
      this.error.set('Target price is required');
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.planSvc.create({
        symbol: stock.symbol,
        stockName: stock.stockName,
        tradeDate: undefined,
        segment: 'delivery',
        direction: 'long',
        quantity: stock.quantity || 1,
        cmp: stock.cmp,
        entryPrice: entry,
        targetPrice: stock.targetPrice,
        stopLoss: stock.stopLoss,
        source: 'momentum',
        pool: 'open',
        momentumId: stock.id,
        notes: [this.catalystLabel(stock.catalyst), stock.notes].filter(Boolean).join(' · '),
      });
      this.success.set(`Added ${stock.symbol} to open trade plans`);
      void this.router.navigate(['/trade-plans'], { fragment: 'open' });
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Failed to create trade plan');
    } finally {
      this.busy.set(false);
    }
  }

  private resetForm(): void {
    this.form = {
      symbol: '',
      name: '',
      cmp: '',
      entryPrice: '',
      targetPrice: '',
      stopLoss: '',
      quantity: '1',
      catalyst: 'earnings_beat',
      resultDate: '',
      notes: '',
    };
    this.symbolQuery.set('');
  }
}

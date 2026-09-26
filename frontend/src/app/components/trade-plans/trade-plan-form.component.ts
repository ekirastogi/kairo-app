import { Component, computed, EventEmitter, inject, input, OnInit, Output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ScreenerService, ScreenerSnapshot } from '../../services/screener.service';
import { StockFirestoreService } from '../../services/stock-firestore.service';
import { TradePlanService } from '../../services/trade-plan.service';
import { PlannedEntryLeg, TradeDirection, TradeSegment, RegistryStock } from '../../models/trading-journal.models';
import { formatCurrency, formatPctSigned, pnlClass } from '../../utils/format.utils';
import {
  clampToUpcomingPlanDate,
  planDateTabLabel,
  todayIso,
  upcomingPlanDates,
} from '../../utils/trade-plan-date.utils';
import { parseTradePlanHash } from '../../utils/trade-plan-hash.utils';

interface EntryLegRow {
  price: string;
  quantity: string;
}

@Component({
  selector: 'app-trade-plan-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './trade-plan-form.component.html',
  styles: `
    .ladder-track {
      @apply relative mx-1 mt-2 h-2 rounded-full bg-slate-100;
    }
    .ladder-marker {
      @apply absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white;
    }
    .entry-row {
      @apply rounded-xl border border-slate-200 bg-slate-50/60 p-3;
    }
    .entry-row-scale {
      @apply border-dashed border-sky-200 bg-sky-50/40;
    }
  `,
})
export class TradePlanFormComponent implements OnInit {
  private registrySvc = inject(RegistryStockService);
  private screenerSvc = inject(ScreenerService);
  private stockSvc = inject(StockFirestoreService);
  private planSvc = inject(TradePlanService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  embedded = input(false);
  lockedSymbol = input<string | null>(null);
  @Output() saved = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();

  registry = signal<RegistryStock[]>([]);
  entryLegRows = signal<EntryLegRow[]>([{ price: '', quantity: '' }]);

  tradeDate = signal(todayIso());
  dateTabs = computed(() =>
    upcomingPlanDates().map((iso) => ({ iso, label: planDateTabLabel(iso) }))
  );
  symbolQuery = signal('');

  fmt = formatCurrency;
  fmtPct = formatPctSigned;
  pnlClass = pnlClass;
  error = signal<string | null>(null);
  busy = signal(false);
  screenerBusy = signal(false);
  loading = signal(false);
  editingId = signal<string | null>(null);
  isEditing = computed(() => this.editingId() != null);

  needsCmpFetch(): boolean {
    const sym = this.form.symbol.trim();
    const cmp = parseFloat(this.form.cmp);
    return !!sym && !(Number.isFinite(cmp) && cmp > 0);
  }

  form = {
    symbol: '',
    name: '',
    segment: 'intraday' as TradeSegment,
    direction: 'long' as TradeDirection,
    cmp: '',
    targetPrice: '',
    stopLoss: '',
    notes: '',
  };

  isShort = computed(() => this.form.segment === 'intraday' && this.form.direction === 'short');

  directionSummary = computed(() =>
    this.isShort()
      ? 'Sell first at entry → cover (buy back) at target. Scale-in by shorting more at higher prices.'
      : 'Buy at entry → sell at target. Scale-in by buying more at lower prices.'
  );

  initialEntryTitle = computed(() => (this.isShort() ? 'Initial short (sell first)' : 'Initial entry (buy)'));

  entryPriceLabel = computed(() => (this.isShort() ? 'Sell price' : 'Buy price'));

  targetLabel = computed(() => (this.isShort() ? 'Cover price (buy back) *' : 'Target / exit *'));

  stopLossHint = computed(() =>
    this.isShort() ? 'Stop above entry — price rises against the short' : 'Stop below entry — price falls against the long'
  );

  scaleInHint = computed(() =>
    this.isShort()
      ? 'Add scale-in levels at higher prices if the stock rallies against your short.'
      : 'Add scale-in levels at lower prices if the stock dips before your target.'
  );

  parsedEntryLegs = computed((): PlannedEntryLeg[] =>
    this.entryLegRows()
      .map((row) => ({
        quantity: parseFloat(row.quantity),
        price: parseFloat(row.price),
      }))
      .filter((leg) => Number.isFinite(leg.quantity) && leg.quantity > 0 && Number.isFinite(leg.price) && leg.price > 0)
  );

  entrySummary = computed(() => {
    const legs = this.parsedEntryLegs();
    const target = parseFloat(this.form.targetPrice);
    const stop = parseFloat(this.form.stopLoss);
    if (!legs.length || !target) return null;
    return TradePlanService.entryLegSummary(
      legs,
      this.form.segment,
      this.form.direction,
      target,
      Number.isFinite(stop) && stop > 0 ? stop : undefined
    );
  });

  exitPctPreview = computed(() => {
    const summary = this.entrySummary();
    const target = parseFloat(this.form.targetPrice);
    if (!summary || !target) return null;
    return TradePlanService.exitPctVsEntry(
      summary.avgEntryPrice,
      target,
      this.form.segment,
      this.form.direction
    );
  });

  stopLossPctPreview = computed(() => {
    const summary = this.entrySummary();
    const stop = parseFloat(this.form.stopLoss);
    if (!summary || !stop) return null;
    return TradePlanService.stopLossPctVsEntry(
      summary.avgEntryPrice,
      stop,
      this.form.segment,
      this.form.direction
    );
  });

  symbolOptions = computed(() => {
    const q = this.symbolQuery().trim().toLowerCase();
    const rows = this.registry();
    if (!q) return rows.slice(0, 30);
    return rows
      .filter(
        (s) =>
          s.symbol.toLowerCase().includes(q) ||
          (s.name ?? '').toLowerCase().includes(q) ||
          (s.exchange ?? 'NSE').toLowerCase().includes(q)
      )
      .slice(0, 30);
  });

  ladderMarkers = computed(() => {
    const cmp = parseFloat(this.form.cmp);
    const target = parseFloat(this.form.targetPrice);
    const stop = parseFloat(this.form.stopLoss);
    const legs = this.parsedEntryLegs();
    const prices = [
      ...legs.map((leg) => leg.price),
      ...(Number.isFinite(cmp) && cmp > 0 ? [cmp] : []),
      ...(Number.isFinite(target) && target > 0 ? [target] : []),
      ...(Number.isFinite(stop) && stop > 0 ? [stop] : []),
    ];
    if (prices.length < 2) return [];
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    const markers: { left: number; label: string; className: string }[] = [];
    if (Number.isFinite(cmp) && cmp > 0) {
      markers.push({ left: ((cmp - min) / span) * 100, label: 'CMP', className: 'bg-blue-500' });
    }
    legs.forEach((leg, index) => {
      markers.push({
        left: ((leg.price - min) / span) * 100,
        label: index === 0 ? 'E1' : `S${index}`,
        className: index === 0 ? 'bg-emerald-500' : 'bg-sky-500',
      });
    });
    if (Number.isFinite(target) && target > 0) {
      markers.push({ left: ((target - min) / span) * 100, label: 'TGT', className: 'bg-rose-500' });
    }
    if (Number.isFinite(stop) && stop > 0) {
      markers.push({ left: ((stop - min) / span) * 100, label: 'SL', className: 'bg-red-700' });
    }
    return markers;
  });

  async ngOnInit(): Promise<void> {
    await this.loadLookupData();

    const editId = this.route.snapshot.paramMap.get('id');
    if (editId) {
      await this.loadForEdit(editId);
      return;
    }
    const hashDate = parseTradePlanHash(window.location.hash).date;
    const date = clampToUpcomingPlanDate(
      hashDate || this.route.snapshot.queryParamMap.get('date')
    );
    this.tradeDate.set(date);
    const locked = this.lockedSymbol()?.trim();
    const symbol = locked || this.route.snapshot.queryParamMap.get('symbol');
    if (symbol) await this.pickSymbol(symbol);
  }

  private async loadLookupData(): Promise<void> {
    try {
      const registry = await this.registrySvc.listAll();
      this.registry.set(registry);
    } catch {
      // Symbol search falls back to manual entry.
    }
  }

  private async loadForEdit(id: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const trade = await this.planSvc.getById(id);
      if (!trade) {
        this.error.set('Trade plan not found');
        return;
      }
      this.editingId.set(id);
      this.tradeDate.set(trade.tradeDate);
      this.form.symbol = trade.symbol;
      this.form.name = trade.stockName ?? trade.symbol;
      this.symbolQuery.set(trade.symbol);
      this.form.segment = trade.segment;
      this.form.direction = trade.direction;
      this.form.cmp = trade.cmp != null ? String(trade.cmp) : '';
      this.form.targetPrice = String(trade.targetPrice);
      this.form.stopLoss = trade.stopLoss != null ? String(trade.stopLoss) : '';
      this.form.notes = trade.notes ?? '';
      const legs = trade.entryLegs?.length
        ? trade.entryLegs
        : [{ price: trade.entryPrice, quantity: trade.quantity }];
      this.entryLegRows.set(
        legs.map((leg) => ({ price: String(leg.price), quantity: String(leg.quantity) }))
      );
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Failed to load trade');
    } finally {
      this.loading.set(false);
    }
  }

  selectDate(iso: string): void {
    this.tradeDate.set(iso);
  }

  onSegmentChange(segment: TradeSegment): void {
    this.form.segment = segment;
    if (segment === 'delivery') {
      this.form.direction = 'long';
    }
  }

  setDirection(direction: TradeDirection): void {
    this.form.direction = direction;
  }

  onSymbolQuery(value: string): void {
    this.symbolQuery.set(value);
    const sym = value.trim().toUpperCase();
    this.form.symbol = sym;
    const registryEntry = this.registry().find((s) => s.symbol === sym);
    if (!registryEntry) return;
    void this.applySymbolPrefill(sym, {
      fillEntry: !this.entryLegRows()[0]?.price,
      fillTargets: !this.form.targetPrice && !this.form.stopLoss,
    });
  }

  onSymbolBlur(): void {
    const sym = this.form.symbol.trim().toUpperCase();
    if (!sym || this.form.cmp) return;
    void this.applySymbolPrefill(sym, {
      fillEntry: !this.entryLegRows()[0]?.price,
      fillTargets: false,
    });
  }

  async pickSymbol(symbol: string): Promise<void> {
    this.symbolQuery.set(symbol.toUpperCase());
    await this.applySymbolPrefill(symbol, { fillEntry: true, fillTargets: true });
  }

  addScaleIn(): void {
    this.entryLegRows.update((rows) => [...rows, { price: '', quantity: '' }]);
  }

  removeScaleIn(index: number): void {
    if (index === 0) return;
    this.entryLegRows.update((rows) => rows.filter((_, i) => i !== index));
  }

  updateEntryLeg(index: number, field: 'price' | 'quantity', value: string): void {
    this.entryLegRows.update((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
  }

  private async applySymbolPrefill(
    symbol: string,
    options: { fillEntry?: boolean; fillTargets?: boolean } = {}
  ): Promise<void> {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;

    const registryEntry = this.registry().find((s) => s.symbol === sym);
    this.form.symbol = sym;
    this.form.name = registryEntry?.name ?? sym;

    const cmp = await this.resolveCmp(sym, registryEntry);
    if (cmp != null && cmp > 0) {
      this.form.cmp = String(cmp);
      if (options.fillEntry !== false && !this.entryLegRows()[0]?.price) {
        this.updateEntryLeg(0, 'price', String(cmp));
      }
    }

    if (options.fillTargets !== false && registryEntry) {
      if (registryEntry.resistances[0] && !this.form.targetPrice) {
        this.form.targetPrice = String(registryEntry.resistances[0]);
      }
      if (registryEntry.supports[0] && !this.form.stopLoss) {
        this.form.stopLoss = String(registryEntry.supports[0]);
      }
    }
  }

  private async resolveCmp(symbol: string, registryEntry?: RegistryStock): Promise<number | null> {
    if (registryEntry?.currentPrice && registryEntry.currentPrice > 0) {
      return registryEntry.currentPrice;
    }
    try {
      const snap = await firstValueFrom(this.stockSvc.watchStock(symbol).pipe(take(1)));
      const ltp = snap?.ltp;
      return ltp && ltp > 0 ? ltp : null;
    } catch {
      return null;
    }
  }

  async fetchCmpFromScreener(): Promise<void> {
    const sym = this.form.symbol.trim().toUpperCase();
    if (!sym || this.screenerBusy()) return;

    this.screenerBusy.set(true);
    this.error.set(null);
    try {
      const existing =
        this.registry().find((s) => s.symbol === sym) ??
        (await this.registrySvc.getBySymbol(sym));
      const data = await this.screenerSvc.fetchStock(
        sym,
        existing?.name ?? (this.form.name.trim() || undefined)
      );
      const updated = this.applyScreenerSnapshot(
        existing ?? {
          symbol: sym,
          name: data.name || this.form.name || sym,
          currentPrice: 0,
          supports: [],
          resistances: [],
          updatedAt: Date.now(),
        },
        data
      );
      await this.registrySvc.save(updated);
      this.registry.update((rows) => {
        const without = rows.filter((s) => s.symbol !== sym);
        return [...without, updated].sort((a, b) => a.symbol.localeCompare(b.symbol));
      });

      this.form.symbol = sym;
      this.form.name = updated.name || this.form.name || sym;
      this.symbolQuery.set(sym);

      if (updated.currentPrice > 0) {
        this.form.cmp = String(updated.currentPrice);
        if (!this.entryLegRows()[0]?.price) {
          this.updateEntryLeg(0, 'price', String(updated.currentPrice));
        }
      } else {
        this.error.set(`Screener data saved for ${sym}, but no CMP was returned.`);
        return;
      }

      if (!this.form.targetPrice && updated.resistances[0]) {
        this.form.targetPrice = String(updated.resistances[0]);
      }
      if (!this.form.stopLoss && updated.supports[0]) {
        this.form.stopLoss = String(updated.supports[0]);
      }
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Screener fetch failed');
    } finally {
      this.screenerBusy.set(false);
    }
  }

  private applyScreenerSnapshot(stock: RegistryStock, data: ScreenerSnapshot): RegistryStock {
    return {
      ...stock,
      name: data.name || stock.name,
      currentPrice: data.currentPrice ?? stock.currentPrice,
      marketCap: data.marketCap ?? stock.marketCap,
      pe: data.pe ?? stock.pe,
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
  }

  cancel(): void {
    if (this.embedded()) {
      this.cancelled.emit();
      return;
    }
    void this.router.navigate(['/trade-plans'], { fragment: `date=${this.tradeDate()}` });
  }

  async save(): Promise<void> {
    this.error.set(null);
    const cmp = parseFloat(this.form.cmp);
    const target = parseFloat(this.form.targetPrice);
    const entryLegs = this.parsedEntryLegs();
    if (!this.form.symbol || !cmp || !target || !entryLegs.length) {
      this.error.set('Symbol, CMP, at least one entry, and target are required');
      return;
    }
    const validationError = TradePlanService.validatePlannedEntryLegs(
      entryLegs,
      this.form.segment,
      this.form.direction
    );
    if (validationError) {
      this.error.set(validationError);
      return;
    }
    const summary = TradePlanService.entryLegSummary(
      entryLegs,
      this.form.segment,
      this.form.direction,
      target,
      parseFloat(this.form.stopLoss) || undefined
    );
    const stock = this.registry().find((s) => s.symbol === this.form.symbol.toUpperCase());
    const editId = this.editingId();
    this.busy.set(true);
    try {
      const payload = {
        symbol: this.form.symbol,
        stockName: stock?.name ?? this.form.name,
        tradeDate: this.tradeDate(),
        segment: this.form.segment,
        direction: this.form.direction,
        quantity: summary.totalQuantity,
        cmp,
        entryPrice: summary.avgEntryPrice,
        targetPrice: target,
        stopLoss: parseFloat(this.form.stopLoss) || undefined,
        entryLegs,
        notes: this.form.notes,
      };
      if (editId) {
        await this.planSvc.update(editId, payload);
      } else {
        await this.planSvc.create({ ...payload, source: 'manual' });
      }
      if (this.embedded()) {
        this.saved.emit();
      } else {
        await this.router.navigate(['/trade-plans'], { fragment: `date=${this.tradeDate()}` });
      }
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : editId ? 'Failed to update trade' : 'Failed to add trade');
    } finally {
      this.busy.set(false);
    }
  }
}

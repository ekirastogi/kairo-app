import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatCurrency, formatPrice, formatPctSigned, formatDate, pnlClass } from '../../utils/format.utils';
import {
  AvgFill,
  AvgPosition,
  AvgTarget,
  FillSide,
  createFill,
  createTarget,
  fillsToExecutionLegs,
  openPosition,
  positionDirection,
  summarizeFills,
} from '../../utils/avg-calculator.utils';
import { ChargeSegment } from '../../models/charges.models';
import {
  CHARGE_SEGMENTS,
  CHARGE_SEGMENT_LABELS,
  roundToTick,
  tradeSegmentForCharge,
} from '../../utils/charges.utils';
import { ChargesService } from '../../services/charges.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ScreenerService, ScreenerSnapshot } from '../../services/screener.service';
import { TradePlanService } from '../../services/trade-plan.service';
import { PriceTrackerService } from '../../services/price-tracker.service';
import { ViewContextService } from '../../services/view-context.service';
import { readJson, writeJson } from '../../utils/local-store.utils';
import { ExecutionLeg, RegistryStock } from '../../models/trading-journal.models';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';
import { istTodayIso } from '../../utils/market-calendar.utils';

const PLANS_KEY = 'kairo-stock-plans-v2';
const LEGACY_PLANS_KEY = 'kairo-stock-plans-v1';
const LEGACY_SHEETS_KEY = 'kairo-avg-sheets-v1';
const LEGACY_STATE_KEY = 'kairo-avg-calculator-v2';

type ProfitUnit = 'inr' | 'pct';
type RightTab = 'guide' | 'price' | 'profit';

const PROFIT_PRESETS = [1000, 5000, 10000, 25000, 50000] as const;

interface StockPlan {
  id: string;
  symbol: string;
  segment: ChargeSegment;
  fills: AvgFill[];
  exits: AvgFill[];
  targets: AvgTarget[];
  historySavedAt?: number;
  updatedAt: number;
}

interface PlansStore {
  plans: StockPlan[];
  activeId: string;
}

function emptyPlan(partial?: Partial<StockPlan>): StockPlan {
  return {
    id: crypto.randomUUID(),
    symbol: '',
    segment: 'delivery',
    fills: [],
    exits: [],
    targets: [],
    updatedAt: Date.now(),
    ...partial,
  };
}

function normalizePlan(raw: Partial<StockPlan> & { id?: string; markPrice?: number | null }): StockPlan {
  return emptyPlan({
    id: raw.id ?? crypto.randomUUID(),
    symbol: raw.symbol ?? '',
    segment: raw.segment ?? 'delivery',
    fills: Array.isArray(raw.fills) ? raw.fills : [],
    exits: Array.isArray(raw.exits) ? raw.exits : [],
    targets: Array.isArray(raw.targets)
      ? raw.targets.map((t) => ({ ...t, quantity: t.quantity ?? 0 }))
      : [],
    historySavedAt: raw.historySavedAt,
    updatedAt: raw.updatedAt ?? Date.now(),
  });
}

function loadStore(): PlansStore {
  for (const key of [PLANS_KEY, LEGACY_PLANS_KEY]) {
    const stored = readJson<PlansStore | null>(key, null);
    if (stored?.plans?.length && stored.activeId) {
      const plans = stored.plans.map(normalizePlan);
      const activeId = plans.some((p) => p.id === stored.activeId) ? stored.activeId : plans[0].id;
      return { plans, activeId };
    }
  }

  const legacySheets = readJson<StockPlan[]>(LEGACY_SHEETS_KEY, []);
  const legacyWorking = readJson<Partial<StockPlan> & { sheetId?: string | null }>(LEGACY_STATE_KEY, {});
  if (legacySheets.length) {
    const plans = legacySheets.map(normalizePlan);
    const activeId = plans.find((p) => p.id === legacyWorking.sheetId)?.id ?? plans[0].id;
    return { plans, activeId };
  }

  const migrated = emptyPlan({
    symbol: legacyWorking.symbol ?? '',
    segment: legacyWorking.segment ?? 'delivery',
    fills: Array.isArray(legacyWorking.fills) ? legacyWorking.fills : [],
    targets: Array.isArray(legacyWorking.targets) ? legacyWorking.targets : [],
  });
  return { plans: [migrated], activeId: migrated.id };
}

@Component({
  selector: 'app-avg-calculator',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, StockSearchInputComponent],
  templateUrl: './avg-calculator.component.html',
  styles: `
    .blotter-row {
      @apply grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 sm:grid-cols-[5.5rem_1fr_1fr_auto];
    }
    .field-label {
      @apply text-[10px] font-semibold uppercase tracking-wide text-slate-400;
    }
    .mini-toggle {
      @apply shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold text-slate-500 transition hover:text-slate-800;
    }
    .mini-toggle-active {
      @apply bg-slate-900 text-white hover:text-white;
    }
    .plan-tab {
      @apply flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white pl-3 pr-1 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-slate-300;
    }
    .plan-tab-active {
      @apply border-kairo-500 bg-kairo-50 text-kairo-700;
    }
    .target-row {
      @apply rounded-xl border border-slate-200 bg-white p-3 transition hover:border-slate-300;
    }
    .target-metric {
      @apply rounded-lg bg-slate-50 px-2.5 py-1.5;
    }
    .target-metric-label {
      @apply text-[10px] font-semibold uppercase tracking-wide text-slate-400;
    }
    .target-metric-value {
      @apply mt-0.5 text-sm font-semibold tabular-nums;
    }
    .qty-input {
      @apply w-20 rounded-lg border border-slate-200 px-2 py-1 text-right text-sm font-semibold tabular-nums text-slate-900 focus:border-kairo-500 focus:outline-none;
    }
    .help-backdrop {
      @apply fixed inset-0 z-40 bg-slate-900/40;
    }
    .help-dialog {
      @apply fixed inset-x-4 top-[12%] z-50 mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl sm:inset-x-auto;
    }
  `,
})
export class AvgCalculatorComponent {
  private readonly charges = inject(ChargesService);
  private readonly tradePlans = inject(TradePlanService);
  private readonly trackers = inject(PriceTrackerService);
  private readonly registrySvc = inject(RegistryStockService);
  private readonly screenerSvc = inject(ScreenerService);
  private readonly viewContext = inject(ViewContextService);
  private store = loadStore();

  plans = signal<StockPlan[]>(this.store.plans);
  planId = signal<string>(this.store.activeId);

  private activePlan(): StockPlan {
    return this.plans().find((p) => p.id === this.planId()) ?? this.plans()[0];
  }

  symbol = signal<string>(this.activePlan().symbol);
  symbolQuery = signal<string>(this.activePlan().symbol);
  stockName = signal('');
  stockExchange = signal('');
  stockIsin = signal('');
  stockPrice = signal<number | null>(null);
  pickedRegistry = signal<RegistryStock[]>([]);
  refreshBusy = signal(false);
  segment = signal<ChargeSegment>(this.activePlan().segment);
  fills = signal<AvgFill[]>(this.activePlan().fills);
  exits = signal<AvgFill[]>(this.activePlan().exits);
  targets = signal<AvgTarget[]>(this.activePlan().targets);
  historySavedAt = signal<number | null>(this.activePlan().historySavedAt ?? null);

  draftSide = signal<FillSide>('buy');
  draftExitSide = signal<FillSide>('sell');
  draftPrice = '';
  draftQty = '';
  draftExitPrice = '';
  draftExitQty = '';
  draftTarget = '';
  draftTargetQty = '';
  draftProfit = '';
  rightTab = signal<RightTab>('guide');
  profitUnit = signal<ProfitUnit>('inr');
  helpOpen = signal(false);
  addError = signal<string | null>(null);
  exitError = signal<string | null>(null);
  targetError = signal<string | null>(null);
  notice = signal<string | null>(null);
  savingToBook = signal(false);
  savingToHistory = signal(false);

  readonly formatCurrency = formatCurrency;
  readonly formatPrice = formatPrice;
  readonly formatPctSigned = formatPctSigned;
  readonly pnlClass = pnlClass;
  readonly segmentLabels = CHARGE_SEGMENT_LABELS;
  readonly segments = CHARGE_SEGMENTS.filter((segment) => segment !== 'mtf');
  readonly profitPresets = PROFIT_PRESETS;

  stockHintName = computed(() => {
    const name = this.stockName();
    const price = this.stockPrice();
    if (!name) return '';
    return price != null && price > 0 ? `${name} · ${formatPrice(price)}` : name;
  });

  book = computed(() => summarizeFills([...this.fills(), ...this.exits()]));
  position = computed(() => openPosition(this.book()));

  private readonly _publishViewContext = effect(() => {
    const position = this.position();
    const book = this.book();
    this.viewContext.publish({
      page: 'Utility',
      title: `Utility — ${this.symbol() || 'no stock'}`,
      data: {
        symbol: this.symbol(),
        name: this.stockName(),
        segment: this.segment(),
        cmp: this.stockPrice(),
        book,
        position,
        fills: this.fills().map((fill) => ({ side: fill.side, price: fill.price, quantity: fill.quantity })),
        exits: this.exits().map((fill) => ({ side: fill.side, price: fill.price, quantity: fill.quantity })),
        targets: this.targets().map((target) => ({ price: target.price, quantity: target.quantity })),
      },
    });
  }, { allowSignalWrites: true });

  ladder = computed(() => {
    const position = this.position();
    if (!position) return null;
    return this.charges.ladder({
      segment: this.segment(),
      direction: positionDirection(position),
      entryPrice: position.avgPrice,
      totalQuantity: position.quantity,
      slices: this.targets().map((target) => ({ quantity: target.quantity, price: target.price })),
    });
  });

  targetRows = computed(() => {
    const slices = this.ladder()?.slices ?? [];
    return this.targets().map((target, i) => ({ target, slice: slices[i] ?? null }));
  });

  unallocatedQty = computed(() => {
    const position = this.position();
    if (!position) return 0;
    const allocated = this.targets().reduce((sum, t) => sum + Math.max(0, t.quantity || 0), 0);
    return position.quantity - allocated;
  });

  breakeven = computed(() => {
    const position = this.position();
    if (!position) return null;
    return this.charges.breakevenPrice(this.tradeFor(position));
  });

  bookedTrip = computed(() => {
    const book = this.book();
    if (book.matchedQty <= 0 || book.matchedAvgBuy == null || book.matchedAvgSell == null) {
      return null;
    }
    const isShort = this.openingWasShort();
    return this.charges.roundTrip({
      segment: this.segment(),
      direction: isShort ? 'short' : 'long',
      quantity: book.matchedQty,
      entryPrice: isShort ? book.matchedAvgSell : book.matchedAvgBuy,
      exitPrice: isShort ? book.matchedAvgBuy : book.matchedAvgSell,
    });
  });

  stayGreen = computed(() => {
    const position = this.position();
    const booked = this.bookedTrip();
    if (!position) return null;
    const bookedNet = booked?.netPnL ?? 0;
    const goal = -bookedNet;
    const tick =
      position.side === 'buy'
        ? goal >= 0
          ? 'up'
          : 'down'
        : goal >= 0
          ? 'down'
          : 'up';
    const solved = this.charges.profitTarget(this.tradeFor(position), goal);
    if (!solved) return null;
    return {
      label: bookedNet >= 0 ? 'Stop to stay green' : 'Cover to get green',
      goal,
      price: roundToTick(solved.targetPrice, tick),
      movePerShare: solved.movePerShare,
      movePct: solved.movePct,
      charges: solved.roundTrip.charges,
    };
  });

  exitGuideRows = computed(() => {
    const position = this.position();
    if (!position) return [];
    const trade = this.tradeFor(position);
    const tick = position.side === 'buy' ? 'up' : 'down';
    return PROFIT_PRESETS.map((profit) => {
      const solved = this.charges.profitTarget(trade, profit);
      if (!solved) {
        return {
          profit,
          price: null as number | null,
          movePerShare: null as number | null,
          movePct: null as number | null,
          charges: null as number | null,
        };
      }
      return {
        profit,
        price: roundToTick(solved.targetPrice, tick),
        movePerShare: solved.movePerShare,
        movePct: solved.movePct,
        charges: solved.roundTrip.charges,
      };
    });
  });

  canAddToBook = computed(() => {
    if (!this.symbol().trim()) return false;
    if (this.fullyClosed()) return this.book().matchedQty > 0 && !this.historySavedAt();
    return this.position() != null && this.targets().length > 0;
  });

  addToBookHint = computed(() => {
    if (this.canAddToBook()) return null;
    if (!this.symbol().trim()) return 'Pick a stock first';
    if (this.fullyClosed() && this.historySavedAt()) return 'Already added as a closed trade';
    if (!this.position()) return 'Add lots to open a position';
    if (!this.targets().length) return 'Add an exit target first';
    return null;
  });

  fullyClosed = computed(() => this.position() == null && this.bookedTrip() != null);

  canSaveToHistory = computed(
    () => this.fullyClosed() && this.symbol().trim().length > 0 && this.book().matchedQty > 0
  );

  historyDayLabel = computed(() => formatDate(istTodayIso()));

  suggestedExitSide(): FillSide {
    const position = this.position();
    if (!position) return this.draftExitSide();
    return position.side === 'buy' ? 'sell' : 'buy';
  }

  planLabel(plan: StockPlan): string {
    const symbol = plan.id === this.planId() ? this.symbol().trim() : plan.symbol.trim();
    return symbol || 'New plan';
  }

  setSide(side: FillSide): void {
    this.draftSide.set(side);
  }

  setExitSide(side: FillSide): void {
    this.draftExitSide.set(side);
  }

  setSegment(segment: ChargeSegment): void {
    this.segment.set(segment);
    this.persist();
  }

  onSymbolQuery(value: string): void {
    this.symbolQuery.set(value);
    const match = this.findRegistry(value);
    if (match) {
      this.applyRegistry(match);
      return;
    }
    this.symbol.set(value.trim().toUpperCase());
    this.stockName.set('');
    this.stockExchange.set('');
    this.stockIsin.set('');
    this.stockPrice.set(null);
    this.persist();
  }

  onStockPicked(stock: RegistryStock): void {
    this.applyRegistry(stock);
  }

  async refreshStockDetails(): Promise<void> {
    const sym = this.symbol().trim().toUpperCase();
    if (!sym || this.refreshBusy()) return;
    this.refreshBusy.set(true);
    this.notice.set(null);
    try {
      const existing =
        (await this.registrySvc.getBySymbol(sym)) ??
        this.findRegistry(sym) ??
        emptyRegistry(sym, this.stockName(), this.stockIsin(), this.stockExchange());
      const data = await this.screenerSvc.fetchStock(sym, {
        isin: existing.isin || this.stockIsin() || undefined,
        name: existing.name || this.stockName() || undefined,
      });
      const updated = applyScreenerSnapshot(existing, data);
      await this.registrySvc.save(updated);
      this.applyRegistry(updated);
      this.notice.set(
        updated.currentPrice > 0
          ? `Refreshed ${sym} · CMP ${formatPrice(updated.currentPrice)}`
          : `Refreshed stock details for ${sym}`
      );
    } catch (error) {
      this.notice.set(error instanceof Error ? error.message : 'Could not refresh stock details');
    } finally {
      this.refreshBusy.set(false);
    }
  }

  setRightTab(tab: RightTab): void {
    this.rightTab.set(tab);
    this.targetError.set(null);
  }

  setProfitUnit(unit: ProfitUnit): void {
    this.profitUnit.set(unit);
  }

  toggleHelp(): void {
    this.helpOpen.update((open) => !open);
  }

  addFill(): void {
    const parsed = this.parseLot(this.draftPrice, this.draftQty, this.addError);
    if (!parsed) return;
    this.fills.update((rows) => [...rows, createFill(this.draftSide(), parsed.price, parsed.quantity)]);
    this.draftPrice = '';
    this.draftQty = '';
    this.markUnsavedHistory();
    this.persist();
    this.draftExitSide.set(this.suggestedExitSide());
  }

  addCustomExit(): void {
    const remaining = this.position()?.quantity ?? 0;
    const parsed = this.parseLot(this.draftExitPrice, this.draftExitQty, this.exitError, remaining);
    if (!parsed) return;
    const side = this.draftExitSide();
    this.exits.update((rows) => [...rows, createFill(side, parsed.price, parsed.quantity)]);
    this.draftExitPrice = '';
    this.draftExitQty = '';
    this.markUnsavedHistory();
    this.persist();
  }

  removeFill(id: string): void {
    this.fills.update((rows) => rows.filter((row) => row.id !== id));
    this.markUnsavedHistory();
    this.persist();
  }

  removeExit(id: string): void {
    this.exits.update((rows) => rows.filter((row) => row.id !== id));
    this.markUnsavedHistory();
    this.persist();
  }

  resetLots(): void {
    this.fills.set([]);
    this.addError.set(null);
    this.markUnsavedHistory();
    this.persist();
  }

  resetExits(): void {
    this.exits.set([]);
    this.targets.set([]);
    this.exitError.set(null);
    this.targetError.set(null);
    this.markUnsavedHistory();
    this.persist();
  }

  private parseLot(
    priceRaw: string,
    qtyRaw: string,
    error: ReturnType<typeof signal<string | null>>,
    fallbackQty = 0
  ): { price: number; quantity: number } | null {
    const price = Number(priceRaw);
    const typedQty = Number(qtyRaw);
    const quantity =
      Number.isFinite(typedQty) && typedQty > 0
        ? typedQty
        : fallbackQty > 0
          ? fallbackQty
          : NaN;
    if (!Number.isFinite(price) || price <= 0) {
      error.set('Enter a valid price');
      return null;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      error.set('Enter a valid quantity');
      return null;
    }
    error.set(null);
    return { price, quantity };
  }

  private defaultSliceQty(): number {
    const left = this.unallocatedQty();
    if (left > 0) return left;
    return this.position()?.quantity ?? 0;
  }

  addTarget(): void {
    const price = Number(this.draftTarget);
    if (!Number.isFinite(price) || price <= 0) {
      this.targetError.set('Enter a valid target price');
      return;
    }
    const typedQty = Number(this.draftTargetQty);
    const quantity =
      Number.isFinite(typedQty) && typedQty > 0 ? typedQty : this.defaultSliceQty();
    this.targetError.set(null);
    this.targets.update((rows) => [...rows, createTarget(price, quantity)]);
    this.draftTarget = '';
    this.draftTargetQty = '';
    this.persist();
  }

  addProfitTarget(): void {
    const position = this.position();
    if (!position) {
      this.targetError.set('Add lots on the left, then optional partial exits');
      return;
    }
    const goal = Number(this.draftProfit);
    if (!Number.isFinite(goal) || goal <= 0) {
      this.targetError.set('Enter the profit you are aiming for');
      return;
    }
    if (this.addSolvedTarget(goal, Number(this.draftTargetQty))) {
      this.draftProfit = '';
      this.draftTargetQty = '';
    }
  }

  addPresetTarget(profit: number): void {
    this.addSolvedTarget(profit, this.defaultSliceQty());
  }

  private addSolvedTarget(netProfit: number, typedQty: number): boolean {
    const position = this.position();
    if (!position) {
      this.targetError.set('Open quantity is zero after the exits you added');
      return false;
    }
    const quantity =
      Number.isFinite(typedQty) && typedQty > 0 ? typedQty : this.defaultSliceQty();
    if (quantity <= 0) {
      this.targetError.set('Nothing left to allocate — reduce an existing target first');
      return false;
    }

    const profit =
      this.rightTab() === 'profit' && this.profitUnit() === 'pct'
        ? (position.avgPrice * quantity * netProfit) / 100
        : netProfit;
    const solved = this.charges.profitTarget({ ...this.tradeFor(position), quantity }, profit);
    if (!solved) {
      this.targetError.set('That amount is not reachable at a valid price');
      return false;
    }

    this.targetError.set(null);
    const roundDir =
      (position.side === 'buy' && profit >= 0) || (position.side === 'sell' && profit < 0)
        ? 'up'
        : 'down';
    const price = roundToTick(solved.targetPrice, roundDir);
    this.targets.update((rows) => [...rows, createTarget(price, quantity)]);
    this.persist();
    return true;
  }

  submitTarget(): void {
    if (this.rightTab() === 'profit') this.addProfitTarget();
    else this.addTarget();
  }

  setTargetQty(id: string, value: unknown): void {
    const quantity = Number(value);
    this.targets.update((rows) =>
      rows.map((row) =>
        row.id === id ? { ...row, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 0 } : row
      )
    );
    this.persist();
  }

  setTargetPrice(id: string, value: unknown): void {
    const price = Number(value);
    this.targets.update((rows) =>
      rows.map((row) =>
        row.id === id ? { ...row, price: Number.isFinite(price) && price > 0 ? price : 0 } : row
      )
    );
    this.persist();
  }

  splitEvenly(): void {
    const position = this.position();
    const rows = this.targets();
    if (!position || !rows.length) return;
    const each = Math.floor(position.quantity / rows.length);
    const remainder = position.quantity - each * rows.length;
    this.targets.set(rows.map((row, i) => ({ ...row, quantity: each + (i < remainder ? 1 : 0) })));
    this.persist();
  }

  removeTarget(id: string): void {
    this.targets.update((rows) => rows.filter((row) => row.id !== id));
    this.persist();
  }

  newPlan(): void {
    const plan = emptyPlan();
    this.plans.update((rows) => [...rows, plan]);
    this.selectPlan(plan.id);
  }

  duplicatePlan(): void {
    const current = this.snapshot();
    const copy = emptyPlan({
      ...current,
      id: crypto.randomUUID(),
      symbol: current.symbol ? `${current.symbol} copy` : '',
      historySavedAt: undefined,
    });
    this.plans.update((rows) => [...rows, copy]);
    this.selectPlan(copy.id);
  }

  selectPlan(id: string): void {
    this.flushToPlans();
    const plan = this.plans().find((row) => row.id === id);
    if (!plan) return;
    this.planId.set(id);
    this.symbol.set(plan.symbol);
    this.symbolQuery.set(plan.symbol);
    const match = this.findRegistry(plan.symbol);
    this.stockName.set(match?.name ?? '');
    this.stockExchange.set(match?.exchange ?? '');
    this.stockIsin.set(match?.isin ?? '');
    this.stockPrice.set(match?.currentPrice && match.currentPrice > 0 ? match.currentPrice : null);
    this.segment.set(plan.segment);
    this.fills.set(plan.fills);
    this.exits.set(plan.exits);
    this.targets.set(plan.targets.map((t) => ({ ...t, quantity: t.quantity ?? 0 })));
    this.historySavedAt.set(plan.historySavedAt ?? null);
    this.notice.set(null);
    this.targetError.set(null);
    this.addError.set(null);
    this.exitError.set(null);
    this.rightTab.set('guide');
    this.writeStore();
  }

  deletePlan(id: string, event: Event): void {
    event.stopPropagation();
    this.flushToPlans();
    const remaining = this.plans().filter((row) => row.id !== id);
    if (!remaining.length) {
      const fresh = emptyPlan();
      this.plans.set([fresh]);
      this.selectPlan(fresh.id);
      return;
    }
    this.plans.set(remaining);
    if (this.planId() === id) this.selectPlan(remaining[0].id);
    else this.writeStore();
  }

  async addToTradeBook(): Promise<void> {
    if (this.fullyClosed()) {
      await this.saveToTradeHistory();
      return;
    }

    const position = this.position();
    const symbol = this.symbol().trim().toUpperCase();
    if (!position || !symbol) return;
    const targets = this.targets()
      .filter((target) => target.quantity > 0 && target.price > 0)
      .map((target) => ({ quantity: target.quantity, price: target.price }));
    if (!targets.length) {
      this.notice.set('Add at least one target with a quantity and price');
      return;
    }

    this.savingToBook.set(true);
    try {
      await this.tradePlans.create({
        symbol,
        segment: tradeSegmentForCharge(this.segment()),
        direction: positionDirection(position),
        quantity: position.quantity,
        entryPrice: position.avgPrice,
        targetPrice: position.avgPrice,
        targets,
        pool: 'open',
        notes: 'From stock plan',
      });
      this.notice.set(`${symbol} added to the trade book`);
    } catch (error) {
      this.notice.set(error instanceof Error ? error.message : 'Could not add to trade book');
    } finally {
      this.savingToBook.set(false);
    }
  }

  async saveToTradeHistory(): Promise<void> {
    if (!this.canSaveToHistory() || this.savingToHistory() || this.historySavedAt()) return;
    const symbol = this.symbol().trim().toUpperCase();
    const book = this.book();
    const legs = this.closedExecutionLegs();
    if (!symbol || !legs || book.matchedAvgBuy == null || book.matchedAvgSell == null) {
      this.notice.set('Add matching buys and sells before saving history');
      return;
    }

    const isShort = this.openingWasShort();
    const entryPrice = isShort ? book.matchedAvgSell : book.matchedAvgBuy;
    const exitPrice = isShort ? book.matchedAvgBuy : book.matchedAvgSell;
    this.savingToHistory.set(true);
    this.notice.set(null);
    try {
      await this.trackers.saveExecuted({
        symbol,
        stockName: this.stockName() || symbol,
        isin: this.stockIsin() || undefined,
        action: isShort ? 'Short' : 'Long',
        quantity: book.matchedQty,
        segment: tradeSegmentForCharge(this.segment()),
        entryPrice,
        targetPrice: exitPrice,
        targets: [{ quantity: book.matchedQty, price: exitPrice }],
        buyLegs: legs.buyLegs,
        sellLegs: legs.sellLegs,
        notes: 'From utility',
      });
      this.historySavedAt.set(Date.now());
      this.persist();
      this.notice.set(`${symbol} added to the trade book as a closed trade for ${this.historyDayLabel()}`);
    } catch (error) {
      this.notice.set(error instanceof Error ? error.message : 'Could not save to trade history');
    } finally {
      this.savingToHistory.set(false);
    }
  }

  onFillKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.addFill();
    }
  }

  onExitKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.addCustomExit();
    }
  }

  onTargetKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.submitTarget();
    }
  }

  positionLabel(): string {
    const position = this.position();
    if (!position) return 'No open quantity';
    const side = position.side === 'buy' ? 'Long' : 'Short';
    return `${side} ${position.quantity} at ${formatPrice(position.avgPrice)}`;
  }

  signedMove(value: number | null): string {
    if (value == null || !Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${formatPrice(value)}`;
  }

  private tradeFor(position: AvgPosition) {
    return {
      segment: this.segment(),
      direction: positionDirection(position),
      quantity: position.quantity,
      entryPrice: position.avgPrice,
    };
  }

  private openingWasShort(): boolean {
    const remaining = this.book().remainingSide;
    if (remaining === 'sell') return true;
    if (remaining === 'buy') return false;
    const first = this.fills()[0] ?? this.exits()[0];
    return first?.side === 'sell';
  }

  private closedExecutionLegs(): { buyLegs: ExecutionLeg[]; sellLegs: ExecutionLeg[] } | null {
    const book = this.book();
    if (book.matchedQty <= 0 || book.matchedAvgBuy == null || book.matchedAvgSell == null) {
      return null;
    }
    const fromFills = fillsToExecutionLegs([...this.fills(), ...this.exits()]);
    if (!TradePlanService.validateExecutionLegs(fromFills.buyLegs, fromFills.sellLegs)) {
      return fromFills;
    }
    return {
      buyLegs: [{ quantity: book.matchedQty, price: book.matchedAvgBuy }],
      sellLegs: [{ quantity: book.matchedQty, price: book.matchedAvgSell }],
    };
  }

  private markUnsavedHistory(): void {
    if (this.historySavedAt() != null) this.historySavedAt.set(null);
  }

  private snapshot(): StockPlan {
    return {
      id: this.planId(),
      symbol: this.symbol().trim().toUpperCase(),
      segment: this.segment(),
      fills: this.fills(),
      exits: this.exits(),
      targets: this.targets(),
      historySavedAt: this.historySavedAt() ?? undefined,
      updatedAt: Date.now(),
    };
  }

  private flushToPlans(): void {
    const current = this.snapshot();
    this.plans.update((rows) => rows.map((row) => (row.id === current.id ? current : row)));
  }

  private persist(): void {
    this.flushToPlans();
    this.writeStore();
  }

  private writeStore(): void {
    writeJson(PLANS_KEY, { plans: this.plans(), activeId: this.planId() } satisfies PlansStore);
  }

  private findRegistry(value: string): RegistryStock | undefined {
    const q = value.trim().toUpperCase();
    if (!q) return undefined;
    return this.pickedRegistry().find((stock) => stock.symbol.toUpperCase() === q);
  }

  private applyRegistry(stock: RegistryStock): void {
    this.symbol.set(stock.symbol);
    this.stockName.set(stock.name);
    this.stockExchange.set(stock.exchange || 'NSE');
    this.stockIsin.set(stock.isin ?? '');
    this.stockPrice.set(stock.currentPrice > 0 ? stock.currentPrice : null);
    this.symbolQuery.set(stock.symbol);
    this.pickedRegistry.update((rows) => {
      const next = rows.filter((row) => row.symbol !== stock.symbol);
      next.push(stock);
      return next;
    });
    this.persist();
  }
}

function emptyRegistry(symbol: string, name: string, isin: string, exchange: string): RegistryStock {
  return {
    symbol,
    name: name || symbol,
    isin: isin || undefined,
    exchange: exchange || 'NSE',
    currentPrice: 0,
    supports: [],
    resistances: [],
    updatedAt: Date.now(),
  };
}

function applyScreenerSnapshot(stock: RegistryStock, data: ScreenerSnapshot): RegistryStock {
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

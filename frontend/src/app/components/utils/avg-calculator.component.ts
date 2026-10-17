import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { formatCurrency, formatPrice, formatDate, pnlClass } from '../../utils/format.utils';
import {
  AvgFill,
  AvgPosition,
  AvgTarget,
  FillSide,
  createFill,
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
import { readJson, writeJson } from '../../utils/local-store.utils';
import { ExecutionLeg, RegistryStock } from '../../models/trading-journal.models';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';
import { istTodayIso } from '../../utils/market-calendar.utils';

const PLANS_KEY = 'kairo-stock-plans-v2';
const LEGACY_PLANS_KEY = 'kairo-stock-plans-v1';
const LEGACY_SHEETS_KEY = 'kairo-avg-sheets-v1';
const LEGACY_STATE_KEY = 'kairo-avg-calculator-v2';

interface StockPlan {
  id: string;
  name: string;
  symbol: string;
  segment: ChargeSegment;
  fills: AvgFill[];
  exits: AvgFill[];
  targets: AvgTarget[];
  /** Whole-trade net profit after charges. Remaining qty is always used. */
  targetProfit?: number | null;
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
    name: '',
    symbol: '',
    segment: 'delivery',
    fills: [],
    exits: [],
    targets: [],
    targetProfit: null,
    updatedAt: Date.now(),
    ...partial,
  };
}

function normalizePlan(raw: Partial<StockPlan> & { id?: string; markPrice?: number | null }): StockPlan {
  return emptyPlan({
    id: raw.id ?? crypto.randomUUID(),
    name: raw.name ?? '',
    symbol: raw.symbol ?? '',
    segment: raw.segment ?? 'delivery',
    fills: Array.isArray(raw.fills) ? raw.fills : [],
    exits: Array.isArray(raw.exits) ? raw.exits : [],
    targets: Array.isArray(raw.targets)
      ? raw.targets.map((t) => ({
          ...t,
          quantity: t.quantity ?? 0,
          profitGoal: t.profitGoal,
        }))
      : [],
    historySavedAt: raw.historySavedAt,
    targetProfit:
      raw.targetProfit != null && Number.isFinite(raw.targetProfit) ? raw.targetProfit : null,
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
  private store = loadStore();

  plans = signal<StockPlan[]>(this.store.plans);
  planId = signal<string>(this.store.activeId);

  private activePlan(): StockPlan {
    return this.plans().find((p) => p.id === this.planId()) ?? this.plans()[0];
  }

  symbol = signal<string>(this.activePlan().symbol);
  planName = signal<string>(this.activePlan().name);
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
  targetProfit = signal<number | null>(this.activePlan().targetProfit ?? null);
  historySavedAt = signal<number | null>(this.activePlan().historySavedAt ?? null);

  draftSide = signal<FillSide>('buy');
  draftExitSide = signal<FillSide>('sell');
  draftPrice = '';
  draftQty = '';
  draftExitPrice = '';
  draftExitQty = '';
  draftTargetProfit = this.activePlan().targetProfit != null ? String(this.activePlan().targetProfit) : '';
  helpOpen = signal(false);
  addError = signal<string | null>(null);
  exitError = signal<string | null>(null);
  targetError = signal<string | null>(null);
  notice = signal<string | null>(null);
  savingToBook = signal(false);
  savingToHistory = signal(false);

  readonly formatCurrency = formatCurrency;
  readonly formatPrice = formatPrice;
  readonly pnlClass = pnlClass;
  readonly segmentLabels = CHARGE_SEGMENT_LABELS;
  readonly segments = CHARGE_SEGMENTS.filter((segment) => segment !== 'mtf');

  stockHintName = computed(() => {
    const name = this.stockName();
    const price = this.stockPrice();
    if (!name) return '';
    return price != null && price > 0 ? `${name} · ${formatPrice(price)}` : name;
  });

  book = computed(() => summarizeFills([...this.fills(), ...this.exits()]));
  position = computed(() => openPosition(this.book()));

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

  remainingProfitGoal = computed(() => {
    const goal = this.targetProfit();
    if (goal == null) return null;
    return goal - (this.bookedTrip()?.netPnL ?? 0);
  });

  remainingProfitExit = computed(() => {
    const goal = this.remainingProfitGoal();
    const position = this.position();
    if (goal == null || !position) return null;
    return this.solveProfitExit(goal, position.quantity);
  });

  canAddToBook = computed(() => {
    if (!this.symbol().trim()) return false;
    if (this.fullyClosed()) return this.book().matchedQty > 0 && !this.historySavedAt();
    return this.position() != null;
  });

  addToBookHint = computed(() => {
    if (this.canAddToBook()) return null;
    if (!this.symbol().trim()) return 'Pick a stock first';
    if (this.fullyClosed() && this.historySavedAt()) return 'Already added as a closed trade';
    if (!this.position()) return 'Add lots to open a position';
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
    const active = plan.id === this.planId();
    const name = (active ? this.planName() : plan.name ?? '').trim();
    if (name) return name;
    const symbol = (active ? this.symbol() : plan.symbol).trim();
    return symbol || 'New plan';
  }

  setPlanName(value: string): void {
    this.planName.set(value);
    this.persist();
  }

  displayName(): string {
    return this.planName().trim() || this.stockName().trim() || this.symbol().trim();
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
        pageUrl: existing.screenerUrl,
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

  setTargetProfit(value: string | number | null): void {
    const raw = value == null ? '' : String(value);
    this.draftTargetProfit = raw;
    const parsed = Number(raw);
    this.targetProfit.set(Number.isFinite(parsed) && raw.trim() !== '' ? parsed : null);
    this.targetError.set(null);
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

  private solveProfitExit(
    netProfit: number,
    quantity: number
  ): {
    quantity: number;
    price: number;
    movePerShare: number;
    movePct: number;
    charges: number;
  } | null {
    const position = this.position();
    if (!position || quantity <= 0) return null;
    const solved = this.charges.profitTarget({ ...this.tradeFor(position), quantity }, netProfit);
    if (!solved) return null;
    const roundDir =
      (position.side === 'buy' && netProfit >= 0) || (position.side === 'sell' && netProfit < 0)
        ? 'up'
        : 'down';
    return {
      quantity,
      price: roundToTick(solved.targetPrice, roundDir),
      movePerShare: solved.movePerShare,
      movePct: solved.movePct,
      charges: solved.roundTrip.charges,
    };
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
      name: current.name.trim() ? `${current.name.trim()} copy` : '',
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
    this.planName.set(plan.name ?? '');
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
    this.targetProfit.set(plan.targetProfit ?? null);
    this.draftTargetProfit = plan.targetProfit != null ? String(plan.targetProfit) : '';
    this.historySavedAt.set(plan.historySavedAt ?? null);
    this.notice.set(null);
    this.targetError.set(null);
    this.addError.set(null);
    this.exitError.set(null);
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
    const remaining = this.remainingProfitExit();
    const stop = this.stayGreen();
    const exitPrice = remaining?.price ?? stop?.price;
    if (exitPrice == null) {
      this.notice.set('Set a target profit, or add lots so a stay-green price can be solved');
      return;
    }
    const targets = [{ quantity: position.quantity, price: exitPrice }];

    this.savingToBook.set(true);
    try {
      await this.tradePlans.create({
        symbol,
        stockName: this.displayName() || symbol,
        segment: tradeSegmentForCharge(this.segment()),
        direction: positionDirection(position),
        quantity: position.quantity,
        entryPrice: position.avgPrice,
        targetPrice: position.avgPrice,
        targets,
        pool: 'open',
        notes: 'From stock plan',
      });
      this.notice.set(`${this.displayName() || symbol} added to the trade book`);
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
        stockName: this.displayName() || symbol,
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
      this.notice.set(
        `${this.displayName() || symbol} added to the trade book as a closed trade for ${this.historyDayLabel()}`
      );
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
      (event.target as HTMLInputElement | null)?.blur();
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
      name: this.planName().trim(),
      symbol: this.symbol().trim().toUpperCase(),
      segment: this.segment(),
      fills: this.fills(),
      exits: this.exits(),
      targets: this.targets(),
      targetProfit: this.targetProfit(),
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

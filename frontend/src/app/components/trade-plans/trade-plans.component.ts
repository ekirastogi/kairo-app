import { Component, computed, effect, HostListener, inject, OnDestroy, OnInit, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { combineLatest, of, switchMap } from 'rxjs';
import { OPEN_TRADES_PAGE_SIZE, TradePlanService } from '../../services/trade-plan.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ChargesService } from '../../services/charges.service';
import { PlannedTrade } from '../../models/trading-journal.models';
import { formatCurrency, formatPctSigned, formatPrice, pnlClass, pnlBadgeClass } from '../../utils/format.utils';
import {
  isPastPlanDate,
  isUpcomingPlanDate,
  isWeekend,
  normalizePlanViewDate,
  planDateHeading,
  planDateTabLabel,
  todayIso,
  upcomingPlanDates,
} from '../../utils/trade-plan-date.utils';
import {
  parseTradePlanHash,
  replaceTradePlanHash,
} from '../../utils/trade-plan-hash.utils';

type SortKey = 'symbol' | 'estimatedPnL' | 'realizedPnL';

interface ExecLegRow {
  quantity: string;
  price: string;
}

interface PriceLevel {
  key: 'cmp' | 'entry' | 'exit' | 'sl';
  label: string;
  price: number;
  pct: number | null;
  labelClass: string;
  markerClass: string;
}

@Component({
  selector: 'app-trade-plans',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './trade-plans.component.html',
  styles: `
    .plan-date-tab {
      @apply shrink-0 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800;
    }
    .plan-date-tab-active {
      @apply bg-slate-900 text-white shadow-sm hover:bg-slate-900 hover:text-white;
    }
    .trade-item {
      @apply transition;
    }
    .trade-item:not(.trade-card-skipped):not(.trade-card-profit):not(.trade-card-loss):hover {
      @apply bg-slate-50/60;
    }
    .trade-card-skipped {
      @apply bg-amber-50;
    }
    .trade-card-skipped:hover {
      @apply bg-amber-100/80;
    }
    .trade-card-profit {
      @apply bg-emerald-50;
    }
    .trade-card-profit:hover {
      @apply bg-emerald-100/70;
    }
    .trade-card-loss {
      @apply bg-red-50;
    }
    .trade-card-loss:hover {
      @apply bg-red-100/70;
    }
    .trade-identity {
      @apply min-w-0 shrink;
      max-width: min(100%, calc(100vw - 8.5rem));
    }
    @media (min-width: 1024px) {
      .trade-identity {
        width: 9rem;
        max-width: 9rem;
      }
    }
    .trade-name {
      @apply text-base font-bold leading-snug text-slate-900;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .price-ribbon {
      @apply relative h-2 rounded-full bg-slate-100;
    }
    .ribbon-pin-label {
      @apply absolute bottom-0 w-[4.5rem] -translate-x-1/2 text-center;
    }
    .ribbon-segment {
      @apply absolute top-0 h-full rounded-full;
    }
    .ribbon-profit {
      @apply bg-emerald-500;
    }
    .ribbon-loss {
      @apply bg-red-500;
    }
    .ribbon-executed {
      @apply absolute top-1/2 z-20 h-3 -translate-y-1/2 rounded-full shadow-md ring-2 ring-white;
    }
    .ribbon-executed-profit {
      @apply bg-emerald-600;
    }
    .ribbon-executed-loss {
      @apply bg-red-600;
    }
    .price-marker {
      @apply absolute top-1/2 z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white;
    }
    .action-menu {
      @apply fixed z-50 min-w-[9rem] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg;
    }
    .action-menu-item {
      @apply flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50;
    }
    .scale-in-marker {
      @apply h-2 w-2 bg-sky-400;
    }
  `,
})
export class TradePlansComponent implements OnInit, OnDestroy {
  private planSvc = inject(TradePlanService);
  private registrySvc = inject(RegistryStockService);
  private chargesSvc = inject(ChargesService);
  private route = inject(ActivatedRoute);

  tradeDate = signal(normalizePlanViewDate(todayIso()));
  calendarOpen = signal(false);
  sortKey = signal<SortKey>('symbol');
  executingTrade = signal<PlannedTrade | null>(null);
  execBuyLegs = signal<ExecLegRow[]>([{ quantity: '', price: '' }]);
  execSellLegs = signal<ExecLegRow[]>([{ quantity: '', price: '' }]);
  execError = signal<string | null>(null);
  execBusy = signal(false);
  menuOpenId = signal<string | null>(null);
  menuPosition = signal<{ top: number; right: number; openUp: boolean } | null>(null);
  carryForwardPreview = signal<{ count: number; sourceDate: string | null } | null>(null);
  carryForwardBusy = signal(false);
  carryForwardMessage = signal<string | null>(null);
  viewMode = signal<'open' | 'date'>('date');
  openPage = signal(0);
  assigningTrade = signal<PlannedTrade | null>(null);
  assignTargetDate = signal('');
  assignError = signal<string | null>(null);
  assignBusy = signal(false);
  bulkEdit = signal(false);
  selectedIds = signal<Set<string>>(new Set());
  bulkBusy = signal(false);
  bulkMessage = signal<string | null>(null);
  private hashChangeHandler = () => this.applyFromHash(false);

  upcomingTabs = computed(() =>
    upcomingPlanDates().map((iso) => ({ iso, label: planDateTabLabel(iso) }))
  );

  pastDateMax = computed(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });

  viewingPast = computed(() => this.viewMode() === 'date' && isPastPlanDate(this.tradeDate()));
  isOpenView = computed(() => this.viewMode() === 'open');
  dateHeading = computed(() => (this.isOpenView() ? 'Open trades' : planDateHeading(this.tradeDate())));

  trades = toSignal(
    toObservable(this.tradeDate).pipe(switchMap((date) => this.planSvc.watchForDate(date))),
    { initialValue: [] as PlannedTrade[] }
  );

  openTradesPage = toSignal(
    combineLatest([toObservable(this.viewMode), toObservable(this.openPage)]).pipe(
      switchMap(([mode, page]) =>
        mode === 'open'
          ? this.planSvc.watchOpenTrades(page, OPEN_TRADES_PAGE_SIZE)
          : of({ trades: [], total: 0, page, pageSize: OPEN_TRADES_PAGE_SIZE })
      )
    ),
    { initialValue: { trades: [] as PlannedTrade[], total: 0, page: 0, pageSize: OPEN_TRADES_PAGE_SIZE } }
  );

  openTrades = computed(() => this.openTradesPage().trades);
  openTradesTotal = computed(() => this.openTradesPage().total);
  openPageCount = computed(() =>
    Math.max(1, Math.ceil(this.openTradesTotal() / OPEN_TRADES_PAGE_SIZE))
  );
  openPageLabel = computed(() => {
    const total = this.openTradesTotal();
    if (!total) return 'No open trades';
    const page = this.openPage();
    const from = page * OPEN_TRADES_PAGE_SIZE + 1;
    const to = Math.min(total, (page + 1) * OPEN_TRADES_PAGE_SIZE);
    return `${from}–${to} of ${total}`;
  });

  planDateFragment = computed(() => `date=${this.tradeDate()}`);

  registry = toSignal(this.registrySvc.watchAll(), { initialValue: [] });

  /** Registry prices, kept fresh by realtime updates plus the 60s poll. */
  private livePrices = computed(() => {
    const prices = new Map<string, number>();
    for (const stock of this.registry()) {
      if (stock.currentPrice > 0) prices.set(stock.symbol.toUpperCase(), stock.currentPrice);
    }
    return prices;
  });

  fmt = formatCurrency;
  fmtPrice = formatPrice;
  fmtPct = formatPctSigned;
  pnlClass = pnlClass;
  pnlBadgeClass = pnlBadgeClass;

  daySummary = computed(() => this.planSvc.summarizeDay(this.tradeDate(), this.trades()));

  /** Estimated charges across every trade shown for the day. */
  dayCharges = computed(() =>
    this.sortedTrades().reduce((sum, t) => sum + this.tradeCharges(t), 0)
  );

  dayNetPnL = computed(() => this.daySummary().estimatedPnL - this.dayCharges());

  openCharges = computed(() =>
    this.sortedOpenTrades().reduce((sum, t) => sum + this.tradeCharges(t), 0)
  );

  openEstimatedPnL = computed(() =>
    this.sortedOpenTrades().reduce((sum, t) => sum + t.estimatedPnL, 0)
  );

  execPreviewPnL = computed(() => {
    const buyLegs = this.parseExecLegs(this.execBuyLegs());
    const sellLegs = this.parseExecLegs(this.execSellLegs());
    if (!buyLegs.length || !sellLegs.length) return null;
    if (TradePlanService.validateExecutionLegs(buyLegs, sellLegs)) return null;
    return TradePlanService.realizedPnLFromLegs(buyLegs, sellLegs);
  });

  execBuyTotalQty = computed(() =>
    this.parseExecLegs(this.execBuyLegs()).reduce((sum, leg) => sum + leg.quantity, 0)
  );

  execSellTotalQty = computed(() =>
    this.parseExecLegs(this.execSellLegs()).reduce((sum, leg) => sum + leg.quantity, 0)
  );

  execQtyBalanced = computed(() => {
    const buy = this.execBuyTotalQty();
    const sell = this.execSellTotalQty();
    return buy > 0 && buy === sell;
  });

  sortedTrades = computed(() => {
    const key = this.sortKey();
    const rows = this.trades().filter((t) => t.status !== 'open' && t.status !== 'skipped');
    rows.sort((a, b) => {
      switch (key) {
        case 'estimatedPnL':
          return b.estimatedPnL - a.estimatedPnL;
        case 'realizedPnL':
          return (b.realizedPnL ?? 0) - (a.realizedPnL ?? 0);
        default:
          return a.symbol.localeCompare(b.symbol);
      }
    });
    return rows;
  });

  sortedOpenTrades = computed(() => {
    const key = this.sortKey();
    const rows = [...this.openTrades()];
    rows.sort((a, b) => {
      switch (key) {
        case 'estimatedPnL':
          return b.estimatedPnL - a.estimatedPnL;
        case 'realizedPnL':
          return (b.realizedPnL ?? 0) - (a.realizedPnL ?? 0);
        default:
          return a.symbol.localeCompare(b.symbol);
      }
    });
    return rows;
  });

  menuTrade = computed(() => {
    const id = this.menuOpenId();
    if (!id) return null;
    return (
      this.trades().find((t) => t.id === id) ??
      this.openTrades().find((t) => t.id === id) ??
      null
    );
  });

  carryForwardLabel = computed(() => {
    const preview = this.carryForwardPreview();
    if (!preview?.count || !preview.sourceDate) return null;
    const dateLabel = planDateTabLabel(preview.sourceDate);
    const tradeWord = preview.count === 1 ? 'trade' : 'trades';
    return `Carry forward ${preview.count} ${tradeWord} from ${dateLabel}`;
  });

  visibleBulkTrades = computed(() =>
    this.isOpenView() ? this.sortedOpenTrades() : this.sortedTrades()
  );

  selectedCount = computed(() => this.selectedIds().size);

  allVisibleSelected = computed(() => {
    const rows = this.visibleBulkTrades();
    if (!rows.length) return false;
    const selected = this.selectedIds();
    return rows.every((t) => selected.has(t.id));
  });

  constructor() {
    effect(() => {
      const date = this.tradeDate();
      this.trades();
      untracked(() => {
        this.carryForwardMessage.set(null);
        if (!isUpcomingPlanDate(date)) {
          this.carryForwardPreview.set(null);
          return;
        }
        void this.refreshCarryForwardPreview(date);
      });
    });
  }

  ngOnInit(): void {
    this.applyFromHash(false);
    window.addEventListener('hashchange', this.hashChangeHandler);
  }

  ngOnDestroy(): void {
    window.removeEventListener('hashchange', this.hashChangeHandler);
  }

  private applyFromHash(syncHash = false): void {
    const legacyView = this.route.snapshot.queryParamMap.get('view');
    const legacyDate = this.route.snapshot.queryParamMap.get('date');
    const parsed = parseTradePlanHash(window.location.hash);

    if (legacyView === 'open' || parsed.view === 'open') {
      this.viewMode.set('open');
      this.calendarOpen.set(false);
      this.openPage.set(0);
      this.clearBulkState();
      if (syncHash || legacyView === 'open') replaceTradePlanHash('open');
      return;
    }

    this.viewMode.set('date');
    this.clearBulkState();
    const date = legacyDate || parsed.date;
    if (date) {
      this.tradeDate.set(normalizePlanViewDate(date));
      if (syncHash || legacyDate) replaceTradePlanHash('date', this.tradeDate());
    }
  }

  selectOpenTab(syncRoute = true): void {
    this.viewMode.set('open');
    this.calendarOpen.set(false);
    this.openPage.set(0);
    this.clearBulkState();
    if (syncRoute) replaceTradePlanHash('open');
  }

  selectTab(iso: string): void {
    this.viewMode.set('date');
    this.setTradeDate(iso);
    this.calendarOpen.set(false);
    this.clearBulkState();
  }

  onPastDatePick(value: string): void {
    if (!value || isWeekend(value) || !isPastPlanDate(value)) return;
    this.viewMode.set('date');
    this.setTradeDate(value);
    this.calendarOpen.set(false);
    this.clearBulkState();
  }

  toggleCalendar(): void {
    this.calendarOpen.update((v) => !v);
  }

  setSort(key: SortKey): void {
    this.sortKey.set(key);
  }

  canAddPlan(): boolean {
    return isUpcomingPlanDate(this.tradeDate());
  }

  private async refreshCarryForwardPreview(targetDate: string): Promise<void> {
    try {
      const preview = await this.planSvc.countUnfinishedFromPreviousTradingDay(targetDate);
      if (targetDate !== this.tradeDate()) return;
      this.carryForwardPreview.set(preview);
    } catch {
      if (targetDate === this.tradeDate()) {
        this.carryForwardPreview.set(null);
      }
    }
  }

  async carryForwardFromPreviousDay(): Promise<void> {
    const preview = this.carryForwardPreview();
    if (!preview?.count || this.carryForwardBusy()) return;

    const dateLabel = preview.sourceDate ? planDateTabLabel(preview.sourceDate) : 'previous day';
    const tradeWord = preview.count === 1 ? 'trade' : 'trades';
    if (!confirm(`Copy ${preview.count} unexecuted ${tradeWord} from ${dateLabel} to ${planDateTabLabel(this.tradeDate())}?`)) {
      return;
    }

    this.carryForwardBusy.set(true);
    this.carryForwardMessage.set(null);
    try {
      const result = await this.planSvc.copyUnfinishedFromPreviousTradingDay(this.tradeDate());
      if (result.copied === 0) {
        this.carryForwardMessage.set('No trades were copied — they may already exist in today\'s plan.');
      } else {
        let msg = `Copied ${result.copied} ${result.copied === 1 ? 'trade' : 'trades'} from ${planDateTabLabel(result.sourceDate)}.`;
        if (result.skippedDuplicates > 0) {
          msg += ` Skipped ${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? '' : 's'}.`;
        }
        this.carryForwardMessage.set(msg);
      }
      await this.refreshCarryForwardPreview(this.tradeDate());
    } catch (e) {
      this.carryForwardMessage.set(e instanceof Error ? e.message : 'Failed to carry forward trades');
    } finally {
      this.carryForwardBusy.set(false);
    }
  }

  private setTradeDate(iso: string, syncRoute = true): void {
    this.viewMode.set('date');
    this.tradeDate.set(iso);
    if (syncRoute) replaceTradePlanHash('date', iso);
  }

  setOpenPage(page: number): void {
    const max = this.openPageCount() - 1;
    this.openPage.set(Math.max(0, Math.min(page, max)));
  }

  /** Current price: live from the registry, falling back to the snapshot taken when the plan was saved. */
  liveCmp(t: PlannedTrade): number | undefined {
    return this.livePrices().get(t.symbol.toUpperCase()) ?? t.cmp;
  }

  isLivePrice(t: PlannedTrade): boolean {
    return this.livePrices().has(t.symbol.toUpperCase());
  }

  entryPct(t: PlannedTrade): number | null {
    return TradePlanService.pctVsCmp(t.entryPrice, this.liveCmp(t));
  }

  exitPct(t: PlannedTrade): number | null {
    return TradePlanService.pctVsCmp(t.targetPrice, this.liveCmp(t));
  }

  /** Planned price move from average entry to target, signed for longs/shorts. */
  planMovePct(t: PlannedTrade): number | null {
    return TradePlanService.exitPctVsEntry(t.entryPrice, t.targetPrice, t.segment, t.direction);
  }

  fillMovePct(t: PlannedTrade): number | null {
    const summary = this.executionSummary(t);
    if (!summary) return null;
    return TradePlanService.exitPctVsEntry(
      summary.avgBuyPrice,
      summary.avgSellPrice,
      t.segment,
      t.direction
    );
  }

  displayedMovePct(t: PlannedTrade): number | null {
    if (t.status === 'executed') {
      return this.fillMovePct(t) ?? this.planMovePct(t);
    }
    return this.planMovePct(t);
  }

  moveLabel(t: PlannedTrade): string {
    if (t.status === 'executed' && this.fillMovePct(t) != null) {
      return 'Fill move';
    }
    return `${this.entryLabel(t)} → ${this.exitLabel(t)}`;
  }

  stopLossPnL(t: PlannedTrade): number | null {
    return TradePlanService.stopLossPnL(t);
  }

  stopLossPct(t: PlannedTrade): number | null {
    return TradePlanService.stopLossPctVsEntry(t.entryPrice, t.stopLoss, t.segment, t.direction);
  }

  hasStopLoss(t: PlannedTrade): boolean {
    return this.stopLossPnL(t) != null;
  }

  displayPnL(t: PlannedTrade): number {
    if (t.status === 'executed') {
      const summary = this.executionSummary(t);
      if (summary) return summary.realizedPnL;
      if (t.realizedPnL != null) return t.realizedPnL;
    }
    return t.estimatedPnL;
  }

  executionSummary(t: PlannedTrade) {
    return TradePlanService.executionSummary(t);
  }

  executionFillSummary(t: PlannedTrade): string | null {
    const summary = this.executionSummary(t);
    if (!summary) return null;
    const legNote =
      summary.buyLegs.length > 1 || summary.sellLegs.length > 1
        ? ` · ${summary.buyLegs.length}B/${summary.sellLegs.length}S`
        : '';
    return `${summary.quantity} qty · B ${this.fmt(summary.avgBuyPrice)} · S ${this.fmt(summary.avgSellPrice)}${legNote}`;
  }

  pnlLabel(t: PlannedTrade): string {
    return t.status === 'executed' ? 'Realized' : 'Est. P&L';
  }

  statusLabel(t: PlannedTrade): string {
    switch (t.status) {
      case 'executed': return 'Executed';
      case 'open': return 'Open';
      case 'skipped': return 'Skipped';
      default: return 'Planned';
    }
  }

  statusBadgeClass(t: PlannedTrade): string {
    switch (t.status) {
      case 'executed':
        return this.displayPnL(t) >= 0
          ? 'bg-emerald-100 text-emerald-800 ring-emerald-300'
          : 'bg-red-100 text-red-800 ring-red-300';
      case 'open':
      case 'skipped': return 'bg-amber-100 text-amber-800 ring-amber-300';
      default: return 'bg-slate-100 text-slate-700 ring-slate-200';
    }
  }

  tradeCardClass(t: PlannedTrade): string {
    if (t.status === 'open' || t.status === 'skipped') return 'trade-card-skipped';
    if (t.status === 'executed') {
      const pnl = this.displayPnL(t);
      if (pnl > 0) return 'trade-card-profit';
      if (pnl < 0) return 'trade-card-loss';
    }
    return '';
  }

  typeBadgeClass(t: PlannedTrade): string {
    if (t.segment === 'delivery') return 'bg-indigo-50 text-indigo-700';
    return t.direction === 'short' ? 'bg-rose-50 text-rose-700' : 'bg-sky-50 text-sky-700';
  }

  openExecuteModal(trade: PlannedTrade): void {
    this.executingTrade.set(trade);
    this.execError.set(null);
    const summary = TradePlanService.executionSummary(trade);
    if (summary) {
      this.execBuyLegs.set(summary.buyLegs.map((leg) => ({ quantity: String(leg.quantity), price: String(leg.price) })));
      this.execSellLegs.set(summary.sellLegs.map((leg) => ({ quantity: String(leg.quantity), price: String(leg.price) })));
      return;
    }
    const entryLegs = trade.entryLegs?.length
      ? trade.entryLegs
      : [{ quantity: trade.quantity, price: trade.entryPrice }];
    const totalQty = entryLegs.reduce((sum, leg) => sum + leg.quantity, 0);
    if (trade.segment === 'intraday' && trade.direction === 'short') {
      this.execBuyLegs.set([{ quantity: String(totalQty), price: String(trade.targetPrice) }]);
      this.execSellLegs.set(
        entryLegs.map((leg) => ({ quantity: String(leg.quantity), price: String(leg.price) }))
      );
    } else {
      this.execBuyLegs.set(
        entryLegs.map((leg) => ({ quantity: String(leg.quantity), price: String(leg.price) }))
      );
      this.execSellLegs.set([{ quantity: String(totalQty), price: String(trade.targetPrice) }]);
    }
  }

  closeExecuteModal(): void {
    this.executingTrade.set(null);
    this.execError.set(null);
    this.execBuyLegs.set([{ quantity: '', price: '' }]);
    this.execSellLegs.set([{ quantity: '', price: '' }]);
  }

  addExecBuyLeg(): void {
    this.execBuyLegs.update((rows) => [...rows, { quantity: '', price: '' }]);
  }

  removeExecBuyLeg(index: number): void {
    this.execBuyLegs.update((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== index)));
  }

  addExecSellLeg(): void {
    this.execSellLegs.update((rows) => [...rows, { quantity: '', price: '' }]);
  }

  removeExecSellLeg(index: number): void {
    this.execSellLegs.update((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== index)));
  }

  updateExecBuyLeg(index: number, field: 'quantity' | 'price', value: string): void {
    this.execBuyLegs.update((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
  }

  updateExecSellLeg(index: number, field: 'quantity' | 'price', value: string): void {
    this.execSellLegs.update((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
  }

  private parseExecLegs(rows: ExecLegRow[]) {
    return rows
      .map((row) => ({
        quantity: parseFloat(row.quantity),
        price: parseFloat(row.price),
      }))
      .filter((leg) => Number.isFinite(leg.quantity) && leg.quantity > 0 && Number.isFinite(leg.price) && leg.price > 0);
  }

  async confirmExecuted(): Promise<void> {
    const trade = this.executingTrade();
    if (!trade) return;

    const buyLegs = this.parseExecLegs(this.execBuyLegs());
    const sellLegs = this.parseExecLegs(this.execSellLegs());
    const validationError = TradePlanService.validateExecutionLegs(buyLegs, sellLegs);
    if (validationError) {
      this.execError.set(validationError);
      return;
    }

    this.execBusy.set(true);
    this.execError.set(null);
    try {
      await this.planSvc.updateExecution(trade.id, 'executed', { buyLegs, sellLegs });
      this.closeExecuteModal();
    } catch (e) {
      this.execError.set(e instanceof Error ? e.message : 'Failed to save execution');
    } finally {
      this.execBusy.set(false);
    }
  }

  async markSkipped(trade: PlannedTrade): Promise<void> {
    await this.planSvc.moveToOpen(trade.id);
  }

  openAssignModal(trade: PlannedTrade): void {
    this.assigningTrade.set(trade);
    this.assignTargetDate.set(normalizePlanViewDate(todayIso()));
    this.assignError.set(null);
  }

  closeAssignModal(): void {
    this.assigningTrade.set(null);
    this.assignTargetDate.set('');
    this.assignError.set(null);
  }

  async confirmAssignToDay(): Promise<void> {
    const trade = this.assigningTrade();
    const targetDate = this.assignTargetDate().trim();
    if (!trade || !targetDate) return;
    if (isWeekend(targetDate)) {
      this.assignError.set('Pick a weekday');
      return;
    }

    this.assignBusy.set(true);
    this.assignError.set(null);
    try {
      await this.planSvc.assignOpenTradeToDate(trade.id, targetDate);
      this.closeAssignModal();
    } catch (e) {
      this.assignError.set(e instanceof Error ? e.message : 'Failed to assign trade');
    } finally {
      this.assignBusy.set(false);
    }
  }

  openedFromLabel(t: PlannedTrade): string | null {
    if (!t.openedFromDate) return null;
    return `From ${planDateTabLabel(t.openedFromDate)}`;
  }

  async resetPlanned(trade: PlannedTrade): Promise<void> {
    await this.planSvc.updateExecution(trade.id, 'planned');
  }

  async removeTrade(id: string): Promise<void> {
    if (!confirm('Remove this planned trade?')) return;
    await this.planSvc.remove(id);
  }

  startBulkEdit(): void {
    this.bulkEdit.set(true);
    this.bulkMessage.set(null);
    this.closeMenu();
  }

  exitBulkEdit(): void {
    this.clearBulkState();
  }

  isSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  toggleSelect(id: string, event?: Event): void {
    event?.stopPropagation();
    this.selectedIds.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  toggleSelectAllVisible(): void {
    const rows = this.visibleBulkTrades();
    this.selectedIds.update((current) => {
      const next = new Set(current);
      if (rows.length && rows.every((t) => next.has(t.id))) {
        for (const t of rows) next.delete(t.id);
      } else {
        for (const t of rows) next.add(t.id);
      }
      return next;
    });
  }

  async deleteSelected(): Promise<void> {
    const ids = [...this.selectedIds()];
    if (!ids.length || this.bulkBusy()) return;
    const tradeWord = ids.length === 1 ? 'trade' : 'trades';
    if (!confirm(`Remove ${ids.length} selected ${tradeWord}? This cannot be undone.`)) return;
    this.bulkBusy.set(true);
    this.bulkMessage.set(null);
    try {
      const removed = await this.planSvc.removeMany(ids);
      this.selectedIds.set(new Set());
      this.bulkMessage.set(removed ? `Removed ${removed} ${removed === 1 ? 'trade' : 'trades'}` : 'No trades removed');
    } catch (e) {
      this.bulkMessage.set(e instanceof Error ? e.message : 'Failed to delete selected trades');
    } finally {
      this.bulkBusy.set(false);
    }
  }

  async deleteAllInView(): Promise<void> {
    if (this.bulkBusy()) return;
    const count = this.isOpenView() ? this.openTradesTotal() : this.sortedTrades().length;
    if (!count) return;
    const scope = this.isOpenView() ? 'open trades' : `trades for ${this.dateHeading()}`;
    if (!confirm(`Remove all ${count} ${scope}? This cannot be undone.`)) return;
    this.bulkBusy.set(true);
    this.bulkMessage.set(null);
    try {
      const removed = this.isOpenView()
        ? await this.planSvc.removeAllOpen()
        : await this.planSvc.removeAllForDate(this.tradeDate());
      this.selectedIds.set(new Set());
      this.bulkMessage.set(removed ? `Removed ${removed} ${removed === 1 ? 'trade' : 'trades'}` : 'No trades removed');
      this.bulkEdit.set(false);
    } catch (e) {
      this.bulkMessage.set(e instanceof Error ? e.message : 'Failed to delete trades');
    } finally {
      this.bulkBusy.set(false);
    }
  }

  private clearBulkState(): void {
    this.bulkEdit.set(false);
    this.selectedIds.set(new Set());
    this.bulkMessage.set(null);
    this.bulkBusy.set(false);
  }

  segmentLabel(t: PlannedTrade): string {
    if (t.segment === 'delivery') return 'Delivery';
    return t.direction === 'short' ? 'Short' : 'Long';
  }

  segmentDetail(t: PlannedTrade): string {
    if (t.segment === 'delivery') return 'Delivery';
    return `Intraday · ${t.direction === 'short' ? 'Short' : 'Long'}`;
  }

  entryLabel(t: PlannedTrade): string {
    return this.hasScaleIns(t) ? 'Avg entry' : 'Entry';
  }

  hasScaleIns(t: PlannedTrade): boolean {
    return (t.entryLegs?.length ?? 0) > 1;
  }

  quantityDetail(t: PlannedTrade): string {
    const legs = t.entryLegs?.length ?? 0;
    if (legs > 1) {
      return `${t.quantity} qty · ${legs} entries · avg ${this.fmt(t.entryPrice)}`;
    }
    return `${t.quantity} qty`;
  }

  /**
   * Estimated round-trip charges. Executed trades are priced off their actual fills;
   * everything else off the planned target ladder.
   */
  tradeCharges(t: PlannedTrade): number {
    const execution = TradePlanService.executionSummary(t);
    if (t.status === 'executed' && execution) {
      const legs = [
        ...execution.buyLegs.map((leg) => ({ ...leg, side: 'buy' as const })),
        ...execution.sellLegs.map((leg) => ({ ...leg, side: 'sell' as const })),
      ];
      return legs.reduce(
        (sum, leg) =>
          sum +
          this.chargesSvc.legCharges({
            segment: t.segment,
            side: leg.side,
            price: leg.price,
            quantity: leg.quantity,
          }).total,
        0
      );
    }

    const targets = TradePlanService.resolveTargets(t);
    if (!targets.length || !t.entryPrice) return 0;
    return this.chargesSvc.ladder({
      segment: t.segment,
      direction: t.direction,
      entryPrice: t.entryPrice,
      totalQuantity: t.quantity,
      slices: targets,
    }).charges;
  }

  /** P&L after the estimated charges. */
  tradeNetPnL(t: PlannedTrade): number {
    return this.displayPnL(t) - this.tradeCharges(t);
  }

  /** Partial exit ladder with per-slice net P&L; empty when there is a single target. */
  targetLadder(
    t: PlannedTrade
  ): { key: string; label: string; price: number; quantity: number; netPnL: number }[] {
    const targets = TradePlanService.sanitizeTargets(t.targets);
    if (targets.length < 2 || !t.entryPrice) return [];
    const ladder = this.chargesSvc.ladder({
      segment: t.segment,
      direction: t.direction,
      entryPrice: t.entryPrice,
      totalQuantity: t.quantity,
      slices: targets,
    });
    return ladder.slices.map((slice, index) => ({
      key: `target-${index}`,
      label: `T${index + 1}`,
      price: slice.price,
      quantity: slice.quantity,
      netPnL: slice.netPnL,
    }));
  }

  scaleInLevels(t: PlannedTrade): { key: string; label: string; price: number; quantity: number }[] {
    const legs = t.entryLegs ?? [];
    if (legs.length <= 1) return [];
    return legs.slice(1).map((leg, index) => ({
      key: `scale-${index}`,
      label: `Scale ${index + 1}`,
      price: leg.price,
      quantity: leg.quantity,
    }));
  }

  scaleInMarkers(t: PlannedTrade): { key: string; price: number; markerClass: string }[] {
    const legs = t.entryLegs ?? [];
    if (legs.length <= 1) return [];
    return legs.slice(1).map((leg, index) => ({
      key: `scale-marker-${index}`,
      price: leg.price,
      markerClass: 'bg-sky-400',
    }));
  }

  tradeName(t: PlannedTrade): string {
    const fromPlan = t.stockName?.trim();
    if (fromPlan && fromPlan.toUpperCase() !== t.symbol.toUpperCase()) return fromPlan;
    const fromRegistry = this.registry().find((s) => s.symbol === t.symbol)?.name?.trim();
    if (fromRegistry) return fromRegistry;
    return fromPlan || t.symbol;
  }

  accentClass(t: PlannedTrade): string {
    if (t.segment === 'delivery') return 'bg-indigo-500';
    return t.direction === 'short' ? 'bg-rose-500' : 'bg-sky-500';
  }

  priceRange(t: PlannedTrade): { min: number; max: number } {
    const prices = [
      this.liveCmp(t),
      t.entryPrice,
      t.targetPrice,
      t.stopLoss,
      ...(t.entryLegs?.map((leg) => leg.price) ?? []),
      ...TradePlanService.resolveTargets(t).map((target) => target.price),
    ].filter((p): p is number => p != null && p > 0);
    const summary = this.executionSummary(t);
    if (summary) {
      prices.push(summary.avgBuyPrice, summary.avgSellPrice);
    }
    if (!prices.length) return { min: 0, max: 1 };
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (min === max) return { min: min * 0.99, max: max * 1.01 };
    return { min, max };
  }

  markerLeft(value: number | undefined, t: PlannedTrade): number {
    if (value == null || value <= 0) return 0;
    const { min, max } = this.priceRange(t);
    return ((value - min) / (max - min)) * 100;
  }

  private ribbonSegment(from: number, to: number, t: PlannedTrade): { left: number; width: number } {
    const leftPct = this.markerLeft(Math.min(from, to), t);
    const rightPct = this.markerLeft(Math.max(from, to), t);
    return { left: leftPct, width: Math.max(rightPct - leftPct, 1) };
  }

  ribbonProfitSegment(t: PlannedTrade): { left: number; width: number } {
    return this.ribbonSegment(t.entryPrice, t.targetPrice, t);
  }

  ribbonLossSegment(t: PlannedTrade): { left: number; width: number } | null {
    if (t.stopLoss == null) return null;
    return this.ribbonSegment(t.entryPrice, t.stopLoss, t);
  }

  executedTradeSegment(t: PlannedTrade): { left: number; width: number; profitable: boolean } | null {
    if (t.status !== 'executed') return null;
    const summary = this.executionSummary(t);
    if (!summary) return null;
    const segment = this.ribbonSegment(summary.avgBuyPrice, summary.avgSellPrice, t);
    return { ...segment, profitable: summary.realizedPnL >= 0 };
  }

  isShort(t: PlannedTrade): boolean {
    return t.segment === 'intraday' && t.direction === 'short';
  }

  exitLabel(t: PlannedTrade): string {
    return this.isShort(t) ? 'Exit' : 'Target';
  }

  flowArrow(t: PlannedTrade): string {
    if (t.targetPrice === t.entryPrice) return '→';
    if (this.isShort(t)) return t.targetPrice < t.entryPrice ? '↓' : '↑';
    return t.targetPrice > t.entryPrice ? '↑' : '↓';
  }

  flowArrowClass(t: PlannedTrade): string {
    const profitable = this.isShort(t)
      ? t.targetPrice < t.entryPrice
      : t.targetPrice > t.entryPrice;
    if (t.targetPrice === t.entryPrice) return 'text-slate-400';
    return profitable ? 'text-emerald-600' : 'text-red-600';
  }

  /** Fixed display order: CMP → Entry → Exit → SL (trade sequence, not price sort). */
  priceLevels(t: PlannedTrade): PriceLevel[] {
    const levels: PriceLevel[] = [];
    const cmp = this.liveCmp(t);
    if (cmp != null) {
      levels.push({
        key: 'cmp',
        label: this.isLivePrice(t) ? 'CMP · live' : 'CMP',
        price: cmp,
        pct: null,
        labelClass: 'text-blue-600',
        markerClass: 'bg-blue-500',
      });
    }
    levels.push({
      key: 'entry',
      label: this.entryLabel(t),
      price: t.entryPrice,
      pct: this.entryPct(t),
      labelClass: 'text-emerald-600',
      markerClass: 'bg-emerald-500',
    });
    levels.push({
      key: 'exit',
      label: this.exitLabel(t),
      price: t.targetPrice,
      pct: this.exitPct(t),
      labelClass: 'text-red-600',
      markerClass: 'bg-red-500',
    });
    if (t.stopLoss != null) {
      levels.push({
        key: 'sl',
        label: 'SL',
        price: t.stopLoss,
        pct: this.stopLossPct(t),
        labelClass: 'text-red-500',
        markerClass: 'bg-red-700 ring-2 ring-white',
      });
    }
    return levels;
  }

  toggleMenu(id: string, event: Event): void {
    event.stopPropagation();
    if (this.menuOpenId() === id) {
      this.closeMenu();
      return;
    }
    const btn = event.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    const menuHeight = 120;
    const openUp = rect.bottom + menuHeight > window.innerHeight - 16;
    this.menuPosition.set({
      top: openUp ? rect.top - menuHeight - 4 : rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
      openUp,
    });
    this.menuOpenId.set(id);
  }

  closeMenu(): void {
    this.menuOpenId.set(null);
    this.menuPosition.set(null);
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.closeMenu();
  }
}

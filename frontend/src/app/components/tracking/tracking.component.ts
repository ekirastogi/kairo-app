import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { ExecutionLeg, RegistryStock, TradeSegment } from '../../models/trading-journal.models';
import { TradePlanService } from '../../services/trade-plan.service';
import { ChargesService } from '../../services/charges.service';
import { MarketQuoteService } from '../../services/market-quote.service';
import { PriceTracker, PriceTrackerService } from '../../services/price-tracker.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ToastService } from '../../services/toast.service';
import { formatDataAge } from '../../utils/data-age.utils';
import { formatCurrency, formatPrice, formatPctSigned, pnlClass } from '../../utils/format.utils';
import {
  TrackerPlanSnapshot,
  allocateTrackerSlices,
  trackerAbsDiffPct,
  trackerDiffPct,
  trackerDirection,
  trackerEntryPrice,
  trackerIsSized,
  trackerProximity,
  trackerSegment,
} from '../../utils/price-tracker.utils';
import { TableSortState } from '../../utils/table-sort.utils';

type TrackerColumn =
  | 'symbol'
  | 'action'
  | 'targetPrice'
  | 'cmp'
  | 'diff'
  | 'nextTargets'
  | 'charges'
  | 'netPnL'
  | 'updatedAt';

const ACTION_PRESETS = ['Long', 'Short'] as const;
const SEGMENT_PRESETS: TradeSegment[] = ['intraday', 'delivery'];
const AUTO_REFRESH_MS = 60_000;
const AUTO_REFRESH_KEY = 'kairo-tracking-auto-refresh';

interface TrackerEconomics {
  quantity: number;
  entry: number;
  charges: number;
  netPnL: number;
  slPnL: number | null;
  slices: Array<{ key: string; label: string; price: number; quantity: number; netPnL: number }>;
}

interface TrackerRow extends PriceTracker {
  diffPct: number | null;
  absDiffPct: number | null;
  proximity: ReturnType<typeof trackerProximity>;
  sized: boolean;
  economics: TrackerEconomics | null;
}

interface HistoryRow extends PriceTracker {
  closedQty: number;
  entry: number;
  exit: number;
  winPct: number;
  gross: number;
  charges: number;
  netPnL: number;
}

@Component({
  selector: 'app-tracking',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './tracking.component.html',
})
export class TrackingComponent implements OnInit, OnDestroy {
  private trackerSvc = inject(PriceTrackerService);
  private registrySvc = inject(RegistryStockService);
  private quotes = inject(MarketQuoteService);
  private toast = inject(ToastService);
  private charges = inject(ChargesService);

  trackers = toSignal(this.trackerSvc.watchAll(), { initialValue: [] as PriceTracker[] });
  registry = signal<RegistryStock[]>([]);

  formOpen = signal(false);
  editingId = signal<string | null>(null);
  expandedId = signal<string | null>(null);
  searchQuery = signal('');
  symbolQuery = signal('');
  busy = signal(false);
  refreshBusy = signal(false);
  refreshDone = signal(0);
  refreshTotal = signal(0);
  autoRefresh = signal(false);
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  tableSort = new TableSortState('diff', 'asc');
  historySort = new TableSortState('executedAt', 'desc');
  activeTab = signal<'open' | 'history'>('open');
  history = signal<PriceTracker[]>([]);
  historyLoaded = signal(false);
  historyBusy = signal(false);
  executingId = signal<string | null>(null);
  execBuy = signal<Array<{ quantity: string; price: string }>>([{ quantity: '', price: '' }]);
  execSell = signal<Array<{ quantity: string; price: string }>>([{ quantity: '', price: '' }]);
  readonly actionPresets = ACTION_PRESETS;
  readonly segmentPresets = SEGMENT_PRESETS;
  readonly formatPrice = formatPrice;
  readonly formatCurrency = formatCurrency;
  readonly formatPctSigned = formatPctSigned;
  readonly formatDataAge = formatDataAge;
  readonly pnlClass = pnlClass;

  private nextLevelKey = 1;
  form = {
    symbol: '',
    name: '',
    isin: '',
    exchange: '',
    action: 'Long',
    targetPrice: '',
    nextTargets: [{ key: 0, price: '' }],
    exits: [{ key: 0, price: '', quantity: '' }],
    notes: '',
    quantity: '',
    segment: 'intraday' as TradeSegment,
    entryPrice: '',
    stopLoss: '',
  };

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

  rows = computed(() => {
    this.charges.rates();
    const q = this.searchQuery().trim().toLowerCase();
    const mapped: TrackerRow[] = this.trackers().map((t) => {
      const economics = this.economicsFor(t);
      return {
        ...t,
        diffPct: trackerDiffPct(t.cmp, t.targetPrice),
        absDiffPct: trackerAbsDiffPct(t.cmp, t.targetPrice),
        proximity: trackerProximity(t.cmp, t.targetPrice),
        sized: economics != null,
        economics,
      };
    });
    const filtered = q
      ? mapped.filter(
          (t) =>
            t.symbol.toLowerCase().includes(q) ||
            (t.stockName ?? '').toLowerCase().includes(q) ||
            this.displayAction(t.action).toLowerCase().includes(q) ||
            t.action.toLowerCase().includes(q)
        )
      : mapped;
    return this.tableSort.sort(filtered, (row, column) => this.sortValue(row, column as TrackerColumn));
  });

  nearCount = computed(() => this.rows().filter((r) => r.proximity === 'near').length);
  hotCount = computed(() => this.rows().filter((r) => r.proximity === 'hot').length);
  sizedCount = computed(() => this.rows().filter((r) => r.sized).length);

  historyRows = computed(() => {
    this.charges.rates();
    const q = this.searchQuery().trim().toLowerCase();
    const mapped = this.history()
      .map((plan) => this.toHistoryRow(plan))
      .filter((row): row is HistoryRow => row != null);
    const filtered = q
      ? mapped.filter(
          (row) =>
            row.symbol.toLowerCase().includes(q) ||
            (row.stockName ?? '').toLowerCase().includes(q) ||
            this.displayAction(row.action).toLowerCase().includes(q)
        )
      : mapped;
    return this.historySort.sort(filtered, (row, column) => {
      switch (column) {
        case 'symbol':
          return row.symbol;
        case 'netPnL':
          return row.netPnL;
        case 'charges':
          return row.charges;
        default:
          return row.executedAt ?? row.updatedAt;
      }
    });
  });

  historySummary = computed(() => {
    const rows = this.historyRows();
    const wins = rows.filter((row) => row.netPnL > 0).length;
    return {
      count: rows.length,
      wins,
      winRate: rows.length ? (wins / rows.length) * 100 : 0,
      gross: rows.reduce((sum, row) => sum + row.gross, 0),
      charges: rows.reduce((sum, row) => sum + row.charges, 0),
      netPnL: rows.reduce((sum, row) => sum + row.netPnL, 0),
    };
  });

  refreshLabel = computed(() => {
    if (!this.refreshBusy()) return 'Refresh CMP';
    const total = this.refreshTotal();
    return total ? `Refreshing ${this.refreshDone() + 1}/${total}…` : 'Refreshing…';
  });

  async ngOnInit(): Promise<void> {
    try {
      this.registry.set(await this.registrySvc.listAll());
    } catch {
      // Symbol picker falls back to an empty list.
    }
    if (typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_REFRESH_KEY) === '1') {
      this.setAutoRefresh(true);
    }
  }

  ngOnDestroy(): void {
    this.clearAutoRefresh();
  }

  setAutoRefresh(on: boolean): void {
    this.autoRefresh.set(on);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTO_REFRESH_KEY, on ? '1' : '0');
    }
    this.clearAutoRefresh();
    if (!on) return;
    void this.refreshAll({ silent: true });
    this.autoRefreshTimer = setInterval(() => {
      if (!this.refreshBusy()) void this.refreshAll({ silent: true });
    }, AUTO_REFRESH_MS);
  }

  private clearAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  openAddForm(): void {
    this.resetForm();
    this.editingId.set(null);
    this.formOpen.set(true);
  }

  onAddClick(): void {
    if (this.formOpen() && !this.editingId()) {
      this.cancelForm();
      return;
    }
    this.openAddForm();
  }

  openEdit(tracker: PriceTracker): void {
    this.editingId.set(tracker.id);
    this.form.symbol = tracker.symbol;
    this.form.name = tracker.stockName ?? tracker.symbol;
    this.form.isin = tracker.isin ?? '';
    this.form.exchange = this.findRegistry(tracker.symbol)?.exchange || '';
    this.form.action = this.normalizeAction(tracker.action);
    this.form.targetPrice = String(tracker.targetPrice);
    this.form.nextTargets = tracker.nextTargets.length
      ? tracker.nextTargets.map((price) => ({ key: this.nextLevelKey++, price: String(price) }))
      : [this.emptyLevel()];
    this.form.exits = tracker.targets?.length
      ? tracker.targets.map((exit) => ({
          key: this.nextLevelKey++,
          price: String(exit.price),
          quantity: exit.quantity ? String(exit.quantity) : '',
        }))
      : [this.emptyExit()];
    this.form.notes = tracker.notes ?? '';
    this.form.quantity = tracker.quantity ? String(tracker.quantity) : '';
    this.form.segment = tracker.segment === 'delivery' ? 'delivery' : 'intraday';
    this.form.entryPrice = tracker.entryPrice ? String(tracker.entryPrice) : '';
    this.form.stopLoss = tracker.stopLoss ? String(tracker.stopLoss) : '';
    this.symbolQuery.set(tracker.symbol);
    this.formOpen.set(true);
  }

  cancelForm(): void {
    this.formOpen.set(false);
    this.editingId.set(null);
    this.resetForm();
  }

  onSymbolQuery(value: string): void {
    this.symbolQuery.set(value);
    const match = this.findRegistry(value);
    if (match) {
      this.applyRegistry(match);
      return;
    }
    this.form.symbol = value.trim().toUpperCase();
  }

  setAction(action: (typeof ACTION_PRESETS)[number]): void {
    this.form.action = action;
  }

  setSegment(segment: TradeSegment): void {
    this.form.segment = segment;
  }

  displayAction(action: string): (typeof ACTION_PRESETS)[number] {
    return this.normalizeAction(action);
  }

  private normalizeAction(action: string): (typeof ACTION_PRESETS)[number] {
    const value = action.trim().toLowerCase();
    return value === 'sell' || value === 'short' ? 'Short' : 'Long';
  }

  addNextTarget(): void {
    this.form.nextTargets = [...this.form.nextTargets, this.emptyLevel()];
  }

  removeNextTarget(key: number): void {
    const next = this.form.nextTargets.filter((level) => level.key !== key);
    this.form.nextTargets = next.length ? next : [this.emptyLevel()];
  }

  addExit(): void {
    this.form.exits = [...this.form.exits, this.emptyExit()];
  }

  removeExit(key: number): void {
    const next = this.form.exits.filter((level) => level.key !== key);
    this.form.exits = next.length ? next : [this.emptyExit()];
  }

  rowClass(row: TrackerRow): string {
    const parts = ['plan-row'];
    if (this.isExpanded(row)) parts.push('plan-row-open');
    if (row.proximity === 'hot') parts.push('plan-row-hot');
    if (row.proximity === 'near') parts.push('plan-row-near');
    return parts.join(' ');
  }

  sideClass(action: string): string {
    return this.displayAction(action) === 'Short' ? 'side-short' : 'side-long';
  }

  proximityClass(row: { proximity: 'hot' | 'near' | null; diffPct?: number | null }): string {
    if (row.proximity === 'hot') return 'text-emerald-700';
    if (row.proximity === 'near') return 'text-amber-700';
    return this.pnlClass(row.diffPct ?? 0);
  }

  grossPnL(economics: TrackerEconomics): number {
    return economics.netPnL + economics.charges;
  }

  isExpanded(row: PriceTracker): boolean {
    return this.expandedId() === row.id;
  }

  toggleExpanded(row: PriceTracker): void {
    const next = this.expandedId() === row.id ? null : row.id;
    this.expandedId.set(next);
    if (this.executingId() !== next) this.executingId.set(null);
  }

  setTab(tab: 'open' | 'history'): void {
    this.activeTab.set(tab);
    this.expandedId.set(null);
    this.executingId.set(null);
    this.formOpen.set(false);
    if (tab === 'history') void this.ensureHistory();
  }

  async ensureHistory(): Promise<void> {
    if (this.historyLoaded() || this.historyBusy()) return;
    this.historyBusy.set(true);
    try {
      this.history.set(await this.trackerSvc.listExecuted());
      this.historyLoaded.set(true);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to load history');
    } finally {
      this.historyBusy.set(false);
    }
  }

  startExecute(row: TrackerRow): void {
    this.executingId.set(row.id);
    const qty = row.quantity ? String(row.quantity) : '';
    const entry = this.entryFor(row);
    const exit = row.targets?.[0]?.price;
    const entryPrice = entry ? String(entry) : '';
    const exitPrice = exit ? String(exit) : '';
    if (this.displayAction(row.action) === 'Short') {
      this.execSell.set([{ quantity: qty, price: entryPrice }]);
      this.execBuy.set([{ quantity: qty, price: exitPrice }]);
    } else {
      this.execBuy.set([{ quantity: qty, price: entryPrice }]);
      this.execSell.set([{ quantity: qty, price: exitPrice }]);
    }
  }

  addExecLeg(side: 'buy' | 'sell'): void {
    const blank = { quantity: '', price: '' };
    if (side === 'buy') this.execBuy.update((legs) => [...legs, blank]);
    else this.execSell.update((legs) => [...legs, blank]);
  }

  removeExecLeg(side: 'buy' | 'sell', index: number): void {
    if (side === 'buy') {
      this.execBuy.update((legs) => (legs.length > 1 ? legs.filter((_, i) => i !== index) : legs));
    } else {
      this.execSell.update((legs) => (legs.length > 1 ? legs.filter((_, i) => i !== index) : legs));
    }
  }

  async saveExecute(row: TrackerRow): Promise<void> {
    const buyLegs = this.parseExecLegs(this.execBuy());
    const sellLegs = this.parseExecLegs(this.execSell());
    const invalid = TradePlanService.validateExecutionLegs(buyLegs, sellLegs);
    if (invalid) {
      this.toast.error(invalid);
      return;
    }
    this.busy.set(true);
    try {
      await this.trackerSvc.execute(row.id, buyLegs, sellLegs);
      this.executingId.set(null);
      this.expandedId.set(null);
      if (this.historyLoaded()) {
        const closed = {
          ...row,
          status: 'executed' as const,
          buyLegs,
          sellLegs,
          realizedPnL: TradePlanService.realizedPnLFromLegs(buyLegs, sellLegs),
          executedAt: Date.now(),
        };
        this.history.update((rows) => [closed, ...rows.filter((item) => item.id !== row.id)]);
      }
      this.toast.success(`Closed ${row.symbol}`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to close plan');
    } finally {
      this.busy.set(false);
    }
  }

  async reopen(row: PriceTracker): Promise<void> {
    this.busy.set(true);
    try {
      await this.trackerSvc.reopen(row.id);
      this.history.update((rows) => rows.filter((item) => item.id !== row.id));
      this.expandedId.set(null);
      this.toast.success(`Reopened ${row.symbol}`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to reopen plan');
    } finally {
      this.busy.set(false);
    }
  }

  execPreview(row: TrackerRow): { qty: number; gross: number; charges: number; net: number } | null {
    const buyLegs = this.parseExecLegs(this.execBuy());
    const sellLegs = this.parseExecLegs(this.execSell());
    if (TradePlanService.validateExecutionLegs(buyLegs, sellLegs)) return null;
    return this.realizedEconomics(row, buyLegs, sellLegs, TradePlanService.realizedPnLFromLegs(buyLegs, sellLegs));
  }

  private parseExecLegs(legs: Array<{ quantity: string; price: string }>): ExecutionLeg[] {
    return legs
      .map((leg) => ({ quantity: parseFloat(leg.quantity), price: parseFloat(leg.price) }))
      .filter((leg) => leg.quantity > 0 && leg.price > 0);
  }

  private toHistoryRow(plan: PriceTracker): HistoryRow | null {
    const summary = TradePlanService.executionSummary(plan);
    if (!summary) return null;
    const stats = this.realizedEconomics(plan, summary.buyLegs, summary.sellLegs, summary.realizedPnL);
    if (!stats) return null;
    const short = this.displayAction(plan.action) === 'Short';
    const entry = short ? summary.avgSellPrice : summary.avgBuyPrice;
    const exit = short ? summary.avgBuyPrice : summary.avgSellPrice;
    const winPct = entry > 0 ? ((exit - entry) / entry) * 100 * (short ? -1 : 1) : 0;
    return {
      ...plan,
      closedQty: stats.qty,
      entry,
      exit,
      winPct,
      gross: stats.gross,
      charges: stats.charges,
      netPnL: stats.net,
    };
  }

  private realizedEconomics(
    plan: Pick<PriceTracker, 'action' | 'segment'>,
    buyLegs: ExecutionLeg[],
    sellLegs: ExecutionLeg[],
    gross: number
  ): { qty: number; gross: number; charges: number; net: number } | null {
    const qty = TradePlanService.legTotalQty(buyLegs);
    const avgBuy = TradePlanService.weightedAvgPrice(buyLegs);
    const avgSell = TradePlanService.weightedAvgPrice(sellLegs);
    if (!(qty > 0) || !(avgBuy > 0) || !(avgSell > 0)) return null;
    const short = this.displayAction(plan.action) === 'Short';
    const trip = this.charges.roundTrip({
      segment: trackerSegment(plan),
      direction: trackerDirection(plan.action),
      quantity: qty,
      entryPrice: short ? avgSell : avgBuy,
      exitPrice: short ? avgBuy : avgSell,
    });
    return { qty, gross, charges: trip.charges, net: trip.netPnL };
  }

  entryFor(row: TrackerRow): number {
    return trackerEntryPrice(row) ?? row.targetPrice;
  }

  toggleSort(column: TrackerColumn, event?: Event): void {
    this.tableSort.toggle(column, event);
  }

  formPreview(): TrackerEconomics | null {
    return this.economicsFor(this.formSnapshot());
  }

  nextLevelsLabel(prices: number[]): string {
    return prices.map((price) => formatPrice(price)).join(' · ') || '—';
  }

  async save(): Promise<void> {
    const picked = this.findRegistry(this.form.symbol || this.symbolQuery());
    if (!picked) {
      this.toast.error('Pick a stock from the registry');
      return;
    }
    const action = this.normalizeAction(this.form.action);
    const targetPrice = parseFloat(this.form.targetPrice);
    if (!(targetPrice > 0)) {
      this.toast.error('Enter a trigger price');
      return;
    }

    const quantity = parseFloat(this.form.quantity);
    const entryPrice = parseFloat(this.form.entryPrice);
    const stopLoss = parseFloat(this.form.stopLoss);
    const nextTargets = this.form.nextTargets.map((level) => level.price);
    const targets = this.parsedExits();

    this.busy.set(true);
    try {
      const existing = this.editingId()
        ? this.trackers().find((t) => t.id === this.editingId())
        : undefined;
      await this.trackerSvc.save(
        {
          symbol: picked.symbol,
          stockName: picked.name,
          isin: picked.isin,
          action,
          targetPrice,
          nextTargets,
          targets,
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
          segment: Number.isFinite(quantity) && quantity > 0 ? this.form.segment : null,
          entryPrice: Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : null,
          stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : null,
          cmp: existing?.cmp ?? (picked.currentPrice > 0 ? picked.currentPrice : undefined),
          cmpSource: existing?.cmpSource ?? this.quotes.source,
          cmpFetchedAt: existing?.cmpFetchedAt,
          notes: this.form.notes,
        },
        this.editingId() ?? undefined
      );
      this.toast.success(this.editingId() ? `Updated ${picked.symbol}` : `Added ${picked.symbol}`);
      this.cancelForm();
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to save plan');
    } finally {
      this.busy.set(false);
    }
  }

  async remove(tracker: PriceTracker): Promise<void> {
    if (!confirm(`Remove ${tracker.symbol} at ${formatPrice(tracker.targetPrice)}?`)) return;
    try {
      await this.trackerSvc.remove(tracker.id);
      if (this.editingId() === tracker.id) this.cancelForm();
      this.toast.success(`Removed ${tracker.symbol}`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to remove plan');
    }
  }

  async refreshAll(opts: { silent?: boolean } = {}): Promise<void> {
    const symbols = [...new Set(this.trackers().map((t) => t.symbol))];
    if (!symbols.length) {
      if (!opts.silent) this.toast.success('Nothing to refresh yet. Add a plan first.');
      return;
    }

    this.refreshBusy.set(true);
    const failed: string[] = [];
    let updated = 0;
    try {
      this.refreshTotal.set(symbols.length);
      for (const [index, symbol] of symbols.entries()) {
        this.refreshDone.set(index);
        const plan = this.trackers().find((t) => t.symbol === symbol);
        try {
          const quote = await this.quotes.quote(symbol, {
            isin: plan?.isin || this.findRegistry(symbol)?.isin,
          });
          await this.trackerSvc.applyQuote(symbol, quote);
          const registry = this.findRegistry(symbol);
          if (registry) {
            await this.registrySvc.save({ ...registry, currentPrice: quote.price });
          }
          updated++;
        } catch {
          failed.push(symbol);
        }
      }
      const failNote = failed.length
        ? ` ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}.`
        : '';
      const message = `Refreshed CMP for ${updated} stock${updated === 1 ? '' : 's'} from ${this.quotes.source}.${failNote}`;
      if (failed.length) this.toast.error(message);
      else if (!opts.silent) this.toast.success(message);
    } finally {
      this.refreshBusy.set(false);
      this.refreshDone.set(0);
      this.refreshTotal.set(0);
    }
  }

  private economicsFor(plan: TrackerPlanSnapshot): TrackerEconomics | null {
    if (!trackerIsSized(plan)) return null;
    const entry = trackerEntryPrice(plan);
    const slices = allocateTrackerSlices(plan);
    if (entry == null || !slices.length || !(plan.quantity ?? 0)) return null;
    const ladder = this.charges.ladder({
      segment: trackerSegment(plan),
      direction: trackerDirection(plan.action),
      entryPrice: entry,
      totalQuantity: plan.quantity as number,
      slices,
    });
    let slPnL: number | null = null;
    if (plan.stopLoss != null && plan.stopLoss > 0) {
      slPnL = this.charges.roundTrip({
        segment: trackerSegment(plan),
        direction: trackerDirection(plan.action),
        quantity: plan.quantity as number,
        entryPrice: entry,
        exitPrice: plan.stopLoss,
      }).netPnL;
    }
    return {
      quantity: plan.quantity as number,
      entry,
      charges: ladder.charges,
      netPnL: ladder.netPnL,
      slPnL,
      slices: ladder.slices.map((slice, index) => ({
        key: `t-${index}`,
        label: `T${index + 1}`,
        price: slice.price,
        quantity: slice.quantity,
        netPnL: slice.netPnL,
      })),
    };
  }

  private formSnapshot(): TrackerPlanSnapshot {
    const quantity = parseFloat(this.form.quantity);
    const entryPrice = parseFloat(this.form.entryPrice);
    const stopLoss = parseFloat(this.form.stopLoss);
    const targetPrice = parseFloat(this.form.targetPrice);
    const targets = this.parsedExits();
    return {
      action: this.form.action,
      targetPrice: Number.isFinite(targetPrice) ? targetPrice : 0,
      nextTargets: this.form.nextTargets.map((level) => parseFloat(level.price)).filter((n) => n > 0),
      targets,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
      segment: this.form.segment,
      entryPrice: Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : undefined,
      stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : undefined,
    };
  }

  private sortValue(row: TrackerRow, column: TrackerColumn): string | number {
    switch (column) {
      case 'symbol':
        return row.symbol;
      case 'action':
        return row.action;
      case 'targetPrice':
        return row.targetPrice;
      case 'cmp':
        return row.cmp ?? -1;
      case 'diff':
        return row.absDiffPct ?? Number.POSITIVE_INFINITY;
      case 'nextTargets':
        return row.nextTargets[0] ?? -1;
      case 'charges':
        return row.economics?.charges ?? -1;
      case 'netPnL':
        return row.economics?.netPnL ?? Number.NEGATIVE_INFINITY;
      case 'updatedAt':
        return row.cmpFetchedAt ?? row.updatedAt;
      default:
        return 0;
    }
  }

  private findRegistry(value: string): RegistryStock | undefined {
    const q = value.trim().toUpperCase();
    if (!q) return undefined;
    return this.registry().find((s) => s.symbol === q);
  }

  private applyRegistry(stock: RegistryStock): void {
    this.form.symbol = stock.symbol;
    this.form.name = stock.name;
    this.form.isin = stock.isin ?? '';
    this.form.exchange = stock.exchange || 'NSE';
    this.symbolQuery.set(stock.symbol);
  }

  private parsedExits(): Array<{ price: number; quantity?: number }> {
    return this.form.exits
      .map((level) => ({
        price: parseFloat(level.price),
        quantity: parseFloat(level.quantity),
      }))
      .filter((level) => Number.isFinite(level.price) && level.price > 0)
      .map((level) => ({
        price: level.price,
        quantity: Number.isFinite(level.quantity) && level.quantity > 0 ? level.quantity : undefined,
      }));
  }

  private emptyLevel(): { key: number; price: string } {
    return { key: this.nextLevelKey++, price: '' };
  }

  private emptyExit(): { key: number; price: string; quantity: string } {
    return { key: this.nextLevelKey++, price: '', quantity: '' };
  }

  private resetForm(): void {
    this.form.symbol = '';
    this.form.name = '';
    this.form.isin = '';
    this.form.exchange = '';
    this.form.action = 'Long';
    this.form.targetPrice = '';
    this.form.nextTargets = [this.emptyLevel()];
    this.form.exits = [this.emptyExit()];
    this.form.notes = '';
    this.form.quantity = '';
    this.form.segment = 'intraday';
    this.form.entryPrice = '';
    this.form.stopLoss = '';
    this.symbolQuery.set('');
  }
}

import { Component, computed, effect, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { combineLatest, distinctUntilChanged, from, map, switchMap } from 'rxjs';
import { ExecutionLeg, RegistryStock, TradeSegment } from '../../models/trading-journal.models';
import { TradePlanService } from '../../services/trade-plan.service';
import { ChargesService } from '../../services/charges.service';
import { MarketQuoteService } from '../../services/market-quote.service';
import { PriceTracker, PriceTrackerService } from '../../services/price-tracker.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ToastService } from '../../services/toast.service';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';
import { formatDataAge } from '../../utils/data-age.utils';
import { formatCurrency, formatPrice, formatPctSigned, pnlClass } from '../../utils/format.utils';
import { normalizeIsin } from '../../utils/stock-identity.utils';
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
  trackerTriggerHit,
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
const CMP_STALE_MS = 30 * 60 * 1000;

const REFRESH_WINDOWS = [
  { id: '30m', label: '30 min', ms: 30 * 60 * 1000 },
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '4h', label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { id: '1d', label: '1 day', ms: 24 * 60 * 60 * 1000 },
] as const;

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
  triggerHit: boolean;
  sized: boolean;
  economics: TrackerEconomics | null;
}

interface RefreshCandidate {
  symbol: string;
  name: string;
  isin?: string;
  ageMs: number | null;
  ageLabel: string;
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
  imports: [CommonModule, FormsModule, RouterLink, StockSearchInputComponent],
  templateUrl: './tracking.component.html',
})
export class TrackingComponent implements OnInit, OnDestroy {
  /** When set, the blotter and form stay on this symbol (stock detail tab). */
  readonly lockedSymbol = input('');
  readonly lockedName = input('');
  readonly lockedIsin = input('');

  private route = inject(ActivatedRoute);
  private trackerSvc = inject(PriceTrackerService);
  private registrySvc = inject(RegistryStockService);
  private quotes = inject(MarketQuoteService);
  private toast = inject(ToastService);
  private charges = inject(ChargesService);

  trackers = toSignal(this.trackerSvc.watchAll(), { initialValue: [] as PriceTracker[] });
  private planRegistryTick = signal(0);
  planRegistry = toSignal(
    combineLatest([
      toObservable(this.trackers).pipe(
        map((rows) => [...new Set(rows.map((row) => row.symbol.toUpperCase()))].sort().join('\0')),
        distinctUntilChanged()
      ),
      toObservable(this.planRegistryTick),
    ]).pipe(
      switchMap(([key]) => from(this.registrySvc.listBySymbols(key ? key.split('\0') : [])))
    ),
    { initialValue: [] as RegistryStock[] }
  );
  pickedRegistry = signal<RegistryStock[]>([]);
  /** Quotes saved in this session. Wins over the last registry fetch so CMP updates without a reload. */
  private refreshedRegistry = signal<RegistryStock[]>([]);
  symbolQuery = signal('');

  formOpen = signal(false);
  editingId = signal<string | null>(null);
  expandedId = signal<string | null>(null);
  searchQuery = signal('');
  busy = signal(false);
  refreshBusy = signal(false);
  refreshDone = signal(0);
  refreshTotal = signal(0);
  refreshPickerOpen = signal(false);
  refreshPreset = signal<string>('30m');
  refreshSelection = signal<string[]>([]);
  readonly refreshWindows = REFRESH_WINDOWS;
  autoRefresh = signal(false);
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  readonly planView = toSignal(
    this.route.data.pipe(map((data) => (data['planView'] === 'history' ? 'history' : 'open') as 'open' | 'history')),
    { initialValue: 'open' as const }
  );
  tableSort = new TableSortState('diff', 'asc');
  historySort = new TableSortState('executedAt', 'desc');
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

  refreshCandidates = computed((): RefreshCandidate[] => {
    const now = Date.now();
    const bySymbol = new Map<string, { symbol: string; name: string; isin?: string }>();
    for (const plan of this.openPlans()) {
      const symbol = plan.symbol.trim().toUpperCase();
      if (!symbol || bySymbol.has(symbol)) continue;
      bySymbol.set(symbol, { symbol, name: plan.stockName || symbol, isin: plan.isin });
    }
    return [...bySymbol.values()]
      .map((plan) => {
        const at = this.liveCmpAt(plan);
        return {
          ...plan,
          ageMs: at != null ? Math.max(0, now - at) : null,
          ageLabel: formatDataAge(at),
        };
      })
      .sort((a, b) => (b.ageMs ?? Number.POSITIVE_INFINITY) - (a.ageMs ?? Number.POSITIVE_INFINITY));
  });

  rows = computed(() => {
    this.charges.rates();
    this.refreshedRegistry();
    const q = this.searchQuery().trim().toLowerCase();
    const mapped: TrackerRow[] = this.trackers().map((t) => {
      const economics = this.economicsFor(t);
      const cmp = this.liveCmp(t);
      return {
        ...t,
        cmp,
        cmpFetchedAt: this.liveCmpAt(t),
        diffPct: trackerDiffPct(cmp, t.targetPrice),
        absDiffPct: trackerAbsDiffPct(cmp, t.targetPrice),
        proximity: trackerProximity(cmp, t.targetPrice),
        triggerHit: trackerTriggerHit(t.action, cmp, t.targetPrice),
        sized: economics != null,
        economics,
      };
    });
    const forSymbol = mapped.filter((row) => this.matchesLocked(row));
    const filtered = q
      ? forSymbol.filter(
          (t) =>
            t.symbol.toLowerCase().includes(q) ||
            (t.stockName ?? '').toLowerCase().includes(q) ||
            this.displayAction(t.action).toLowerCase().includes(q) ||
            t.action.toLowerCase().includes(q)
        )
      : forSymbol;
    const sorted = this.tableSort.sort(filtered, (row, column) => this.sortValue(row, column as TrackerColumn));
    const hits = sorted.filter((row) => row.triggerHit);
    const rest = sorted.filter((row) => !row.triggerHit);
    return [...hits, ...rest];
  });

  nearCount = computed(() => this.rows().filter((r) => !r.triggerHit && r.proximity === 'near').length);
  hotCount = computed(() => this.rows().filter((r) => !r.triggerHit && r.proximity === 'hot').length);
  triggerCount = computed(() => this.rows().filter((r) => r.triggerHit).length);
  sizedCount = computed(() => this.rows().filter((r) => r.sized).length);

  historyRows = computed(() => {
    this.charges.rates();
    const q = this.searchQuery().trim().toLowerCase();
    const mapped = this.history()
      .filter((plan) => this.matchesLocked(plan))
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
        case 'executedAt':
          return row.executedAt ?? row.updatedAt;
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

  private readonly loadHistoryView = effect(() => {
    if (this.planView() === 'history') void this.ensureHistory();
  }, { allowSignalWrites: true });

  private readonly loadLockedStock = effect(() => {
    const sym = this.lockedSymbol().trim().toUpperCase();
    if (!sym) return;
    void this.registrySvc.getBySymbol(sym).then((row) => {
      if (!row || this.lockedSymbol().trim().toUpperCase() !== sym) return;
      this.rememberRegistry(row);
      if (!this.formOpen()) this.applyRegistry(row);
    });
  }, { allowSignalWrites: true });

  async ngOnInit(): Promise<void> {
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
    const locked = this.lockedSymbol().trim().toUpperCase();
    if (locked) {
      const known = this.findRegistry(locked);
      if (known) this.applyRegistry(known);
      else {
        this.form.symbol = locked;
        this.form.name = this.lockedName().trim() || locked;
        this.form.isin = normalizeIsin(this.lockedIsin());
        this.symbolQuery.set(locked);
      }
    }
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

  onStockPicked(stock: RegistryStock): void {
    this.applyRegistry(stock);
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

  tradeDate(row: Pick<PriceTracker, 'executedAt' | 'updatedAt'>): string {
    const ms = row.executedAt ?? row.updatedAt;
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
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
    if (row.triggerHit) {
      parts.push('plan-row-trigger');
    } else if (row.proximity === 'hot') {
      parts.push('plan-row-hot');
    } else if (row.proximity === 'near') {
      parts.push('plan-row-near');
    }
    return parts.join(' ');
  }

  sideClass(action: string): string {
    return this.displayAction(action) === 'Short' ? 'side-short' : 'side-long';
  }

  proximityClass(row: { proximity: 'hot' | 'near' | null; diffPct?: number | null; triggerHit?: boolean }): string {
    if (row.triggerHit) return 'text-cyan-700';
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

  exitFor(row: TrackerRow): number | null {
    const price = row.targets?.[0]?.price;
    return price != null && price > 0 ? price : null;
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
    const locked = this.lockedSymbol().trim().toUpperCase();
    let picked = this.findRegistry(locked || this.form.symbol || this.symbolQuery());
    if (!picked && locked) {
      picked = await this.registrySvc.ensureListed(locked, {
        name: this.lockedName().trim() || this.form.name || locked,
        isin: normalizeIsin(this.lockedIsin()) || this.form.isin,
        exchange: this.form.exchange || undefined,
      });
      this.rememberRegistry(picked);
    }
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

  openRefreshPicker(): void {
    if (this.refreshBusy()) return;
    if (this.refreshPickerOpen()) {
      this.refreshPickerOpen.set(false);
      return;
    }
    this.selectRefreshOlderThan(CMP_STALE_MS, '30m');
    this.refreshPickerOpen.set(true);
  }

  selectAllRefresh(): void {
    this.refreshPreset.set('all');
    this.refreshSelection.set(this.refreshCandidates().map((row) => row.symbol));
  }

  clearRefresh(): void {
    this.refreshPreset.set('none');
    this.refreshSelection.set([]);
  }

  selectRefreshOlderThan(ms: number, preset: string): void {
    this.refreshPreset.set(preset);
    this.refreshSelection.set(
      this.refreshCandidates()
        .filter((row) => row.ageMs == null || row.ageMs >= ms)
        .map((row) => row.symbol)
    );
  }

  isRefreshSelected(symbol: string): boolean {
    return this.refreshSelection().includes(symbol);
  }

  toggleRefresh(symbol: string): void {
    this.refreshPreset.set('custom');
    this.refreshSelection.update((current) =>
      current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol]
    );
  }

  confirmRefresh(): void {
    const symbols = this.refreshSelection();
    if (!symbols.length || this.refreshBusy()) return;
    this.refreshPickerOpen.set(false);
    void this.refreshSymbols(symbols);
  }

  downloadCsv(): void {
    const history = this.planView() === 'history';
    const table = history ? this.historyCsv() : this.openCsv();
    if (table.length < 2) return;
    const csv = table.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = history ? 'trade-history.csv' : 'trade-plans.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  private openCsv(): string[][] {
    const header = ['Symbol', 'Name', 'Side', 'CMP', 'Trigger', 'Entry', 'Exit', 'Dist %', 'Net'];
    const body = this.rows().map((row) => [
      row.symbol,
      row.stockName || '',
      this.displayAction(row.action),
      row.cmp ? this.csvPrice(row.cmp) : '',
      this.csvPrice(row.targetPrice),
      this.csvPrice(this.entryFor(row)),
      this.exitFor(row) != null ? this.csvPrice(this.exitFor(row) as number) : '',
      row.diffPct != null ? row.diffPct.toFixed(2) : '',
      row.economics ? this.csvPrice(row.economics.netPnL) : '',
    ]);
    return [header, ...body];
  }

  private historyCsv(): string[][] {
    const header = ['Symbol', 'Name', 'Side', 'Entry', 'Exit', 'Win %', 'Net', 'Closed'];
    const body = this.historyRows().map((row) => [
      row.symbol,
      row.stockName || '',
      this.displayAction(row.action),
      this.csvPrice(row.entry),
      this.csvPrice(row.exit),
      row.winPct.toFixed(2),
      this.csvPrice(row.netPnL),
      row.executedAt ? new Date(row.executedAt).toLocaleDateString('en-IN') : '',
    ]);
    return [header, ...body];
  }

  private csvPrice(value: number): string {
    return Number.isFinite(value) ? value.toFixed(2) : '';
  }

  async refreshAll(opts: { silent?: boolean } = {}): Promise<void> {
    const symbols = this.refreshCandidates()
      .filter((row) => row.ageMs == null || row.ageMs >= CMP_STALE_MS)
      .map((row) => row.symbol);
    if (!symbols.length) {
      if (!opts.silent) this.toast.success('All CMPs are fresh (updated within 30 minutes).');
      return;
    }
    await this.refreshSymbols(symbols, opts);
  }

  private async refreshSymbols(symbols: string[], opts: { silent?: boolean } = {}): Promise<void> {
    if (!symbols.length) {
      if (!opts.silent) this.toast.success('Select at least one stock to refresh.');
      return;
    }

    this.refreshBusy.set(true);
    const failed: string[] = [];
    let updated = 0;
    try {
      this.refreshTotal.set(symbols.length);
      for (const [index, symbol] of symbols.entries()) {
        this.refreshDone.set(index);
        const plan = this.openPlans().find((row) => row.symbol.trim().toUpperCase() === symbol);
        const registry = this.registryFor(plan ?? { symbol });
        if (!registry) {
          failed.push(symbol);
          continue;
        }
        try {
          const quote = await this.quotes.quote(symbol, {
            isin: plan?.isin || registry.isin,
            name: plan?.stockName || registry.name,
          });
          const next: RegistryStock = {
            ...registry,
            currentPrice: quote.price,
            updatedAt: quote.fetchedAt || Date.now(),
          };
          await this.registrySvc.save(next);
          this.refreshedRegistry.update((rows) => [...rows.filter((row) => row.symbol !== next.symbol), next]);
          updated++;
        } catch {
          failed.push(symbol);
        }
      }
      this.registrySvc.reload();
      this.planRegistryTick.update((n) => n + 1);
      const failNote = failed.length
        ? ` ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}.`
        : '';
      const message = `Refreshed CMP for ${updated} stock${updated === 1 ? '' : 's'}.${failNote}`;
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

  private openPlans(): PriceTracker[] {
    return this.lockedSymbol().trim()
      ? this.trackers().filter((row) => this.matchesLocked(row))
      : this.trackers();
  }

  registryPool(): RegistryStock[] {
    const bySymbol = new Map<string, RegistryStock>();
    for (const stock of [...this.pickedRegistry(), ...this.planRegistry(), ...this.refreshedRegistry()]) {
      bySymbol.set(stock.symbol.toUpperCase(), stock);
    }
    return [...bySymbol.values()];
  }

  private findRegistry(value: string): RegistryStock | undefined {
    const q = value.trim().toUpperCase();
    if (!q) return undefined;
    return this.registryPool().find((s) => s.symbol === q);
  }

  private registryFor(plan: { symbol: string; isin?: string }): RegistryStock | undefined {
    const symbol = plan.symbol.trim().toUpperCase();
    const pool = this.registryPool();
    const bySymbol = pool.find((s) => s.symbol === symbol);
    if (bySymbol) return bySymbol;
    const isin = normalizeIsin(plan.isin);
    if (!isin) return undefined;
    return pool.find((s) => normalizeIsin(s.isin) === isin);
  }

  private liveCmp(plan: { symbol: string; isin?: string }): number | undefined {
    const price = this.registryFor(plan)?.currentPrice;
    return price != null && price > 0 ? price : undefined;
  }

  private liveCmpAt(plan: { symbol: string; isin?: string }): number | undefined {
    const at = this.registryFor(plan)?.updatedAt;
    return at != null && at > 0 ? at : undefined;
  }

  private matchesLocked(row: { symbol: string; isin?: string }): boolean {
    const locked = this.lockedSymbol().trim().toUpperCase();
    if (!locked) return true;
    if (row.symbol.trim().toUpperCase() === locked) return true;
    const isin = normalizeIsin(this.lockedIsin());
    return !!isin && normalizeIsin(row.isin) === isin;
  }

  private rememberRegistry(stock: RegistryStock): void {
    this.pickedRegistry.update((rows) => {
      const next = rows.filter((row) => row.symbol !== stock.symbol);
      next.push(stock);
      return next;
    });
  }

  private applyRegistry(stock: RegistryStock): void {
    this.form.symbol = stock.symbol;
    this.form.name = stock.name;
    this.form.isin = stock.isin ?? '';
    this.form.exchange = stock.exchange || 'NSE';
    this.symbolQuery.set(stock.symbol);
    this.rememberRegistry(stock);
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

function csvCell(value: string | number): string {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

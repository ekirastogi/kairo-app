import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { combineLatest, distinctUntilChanged, from, map, switchMap } from 'rxjs';
import { ExecutionLeg, RegistryStock, TradeSegment } from '../../models/trading-journal.models';
import { ChargesService } from '../../services/charges.service';
import { MarketQuoteService } from '../../services/market-quote.service';
import { PriceTracker, PriceTrackerService } from '../../services/price-tracker.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { TradePlanService } from '../../services/trade-plan.service';
import { ScreenerService, ScreenerSnapshot } from '../../services/screener.service';
import { ToastService } from '../../services/toast.service';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';
import { formatDataAge } from '../../utils/data-age.utils';
import { formatCurrency, formatPctSigned, formatPrice, pnlClass } from '../../utils/format.utils';
import {
  allocateTrackerSlices,
  trackerAbsDiffPct,
  trackerDiffPct,
  trackerDirection,
  trackerEntryPrice,
  trackerIsSell,
  trackerIsSized,
  trackerMoveKind,
  trackerProximity,
  trackerSegment,
  trackerTriggerHit,
  trackerTriggerToTargetPct,
} from '../../utils/price-tracker.utils';

const DEFAULT_QTY = 1000;
const TARGET_PCT = 0.01;
const CMP_STALE_MS = 30 * 60 * 1000;
const REFRESH_WINDOWS = [
  { id: '30m', label: '30 min', ms: 30 * 60 * 1000 },
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '4h', label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { id: '1d', label: '1 day', ms: 24 * 60 * 60 * 1000 },
] as const;

interface RefreshCandidate {
  symbol: string;
  name: string;
  isin?: string;
  ageMs: number | null;
  ageLabel: string;
}

type Side = 'Long' | 'Short';
type SideKey = 'short' | 'long';

interface DraftSide {
  prices: string;
  quantity: string;
  target: string;
  segment: TradeSegment;
}

interface DraftCard {
  key: number;
  query: string;
  stock: RegistryStock | null;
  short: DraftSide;
  long: DraftSide;
}

interface ParsedLine {
  action: Side;
  trigger: number;
  nextTargets: number[];
  quantity: number;
  target: number;
  segment: TradeSegment;
}

interface CloseLeg {
  key: number;
  label: string;
  quantity: string;
  price: string;
}

interface BookRow extends PriceTracker {
  cmp?: number;
  diffPct: number | null;
  absDiffPct: number | null;
  proximity: ReturnType<typeof trackerProximity>;
  triggerHit: boolean;
  triggerMovePct: number | null;
  moveKind: 'drop' | 'up';
  targetProfit: number | null;
}

@Component({
  selector: 'app-trade-book',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, StockSearchInputComponent],
  templateUrl: './trade-book.component.html',
  host: { class: 'block' },
  styles: `
    :host { display: block; width: 100%; font-family: Inter, system-ui, -apple-system, sans-serif; }
    .tb-input {
      font-family: Inter, system-ui, -apple-system, sans-serif;
      font-variant-numeric: tabular-nums;
    }
    .tb-drawer { position: fixed; inset: 0; z-index: 50; display: flex; justify-content: flex-end; }
    .tb-drawer-scrim { position: absolute; inset: 0; background: rgb(15 23 42 / 0.4); }
    .tb-drawer-panel {
      position: relative; height: 100%; width: min(28rem, 100%); overflow-y: auto;
      background: #fff; box-shadow: -12px 0 40px rgb(15 23 42 / 0.18);
      font-family: Inter, system-ui, -apple-system, sans-serif;
    }
  `,
})
export class TradeBookComponent {
  private trackerSvc = inject(PriceTrackerService);
  private registrySvc = inject(RegistryStockService);
  private screener = inject(ScreenerService);
  private quotes = inject(MarketQuoteService);
  private toast = inject(ToastService);
  private charges = inject(ChargesService);

  readonly formatPrice = formatPrice;
  readonly formatCurrency = formatCurrency;
  readonly formatPctSigned = formatPctSigned;
  readonly pnlClass = pnlClass;
  readonly defaultQty = DEFAULT_QTY;
  readonly targetPctLabel = '1%';

  private nextKey = 1;
  cards = signal<DraftCard[]>([]);
  plans = toSignal(this.trackerSvc.watchAll(), { initialValue: [] as PriceTracker[] });
  private planRegistryTick = signal(0);
  private refreshedRegistry = signal<RegistryStock[]>([]);
  planRegistry = toSignal(
    combineLatest([
      toObservable(this.plans).pipe(
        map((rows) => [...new Set(rows.map((row) => row.symbol.toUpperCase()))].sort().join('\0')),
        distinctUntilChanged()
      ),
      toObservable(this.planRegistryTick),
    ]).pipe(switchMap(([key]) => from(this.registrySvc.listBySymbols(key ? key.split('\0') : [])))),
    { initialValue: [] as RegistryStock[] }
  );
  selectedIds = signal<Set<string>>(new Set());
  bulkOpen = signal(false);
  busy = signal(false);
  screenerBusy = signal(false);
  refreshBusy = signal(false);
  refreshPickerOpen = signal(false);
  refreshPreset = signal('30m');
  refreshSelection = signal<string[]>([]);
  readonly refreshWindows = REFRESH_WINDOWS;
  searchQuery = signal('');
  editingId = signal<string | null>(null);
  closingRow = signal<BookRow | null>(null);
  closeEntries: CloseLeg[] = [];
  closeExits: CloseLeg[] = [];
  private closeLegKey = 1;
  editForm = {
    action: 'Long' as Side,
    prices: '',
    quantity: '',
    target: '',
    segment: 'intraday' as TradeSegment,
  };

  rows = computed((): BookRow[] => {
    this.charges.rates();
    this.refreshedRegistry();
    this.planRegistry();
    const q = this.searchQuery().trim().toUpperCase();
    const mapped = this.plans().map((plan) => {
      const cmp = this.liveCmp(plan);
      const exit = plan.targets?.[0]?.price;
      return {
        ...plan,
        cmp,
        diffPct: trackerDiffPct(cmp, plan.targetPrice),
        absDiffPct: trackerAbsDiffPct(cmp, plan.targetPrice),
        proximity: trackerProximity(cmp, plan.targetPrice),
        triggerHit: trackerTriggerHit(plan.action, cmp, plan.targetPrice),
        triggerMovePct: trackerTriggerToTargetPct(plan.targetPrice, exit, plan.action),
        moveKind: trackerMoveKind(plan.action),
        targetProfit: this.targetProfitFor(plan),
      };
    });
    const filtered = q
      ? mapped.filter(
          (row) =>
            row.symbol.toUpperCase().includes(q) ||
            (row.stockName || '').toUpperCase().includes(q) ||
            row.action.toUpperCase().includes(q)
        )
      : mapped;
    return [...filtered].sort((a, b) => {
      if (a.triggerHit !== b.triggerHit) return a.triggerHit ? -1 : 1;
      return (a.absDiffPct ?? Number.POSITIVE_INFINITY) - (b.absDiffPct ?? Number.POSITIVE_INFINITY);
    });
  });

  selectedCount = computed(() => this.selectedIds().size);
  allVisibleSelected = computed(() => {
    const rows = this.rows();
    if (!rows.length) return false;
    const selected = this.selectedIds();
    return rows.every((row) => selected.has(row.id));
  });
  triggerCount = computed(() => this.rows().filter((row) => row.triggerHit).length);

  refreshCandidates = computed((): RefreshCandidate[] => {
    const now = Date.now();
    const bySymbol = new Map<string, { symbol: string; name: string; isin?: string }>();
    for (const plan of this.plans()) {
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

  cardReady(card: DraftCard): boolean {
    return this.parsedLines(card).length > 0;
  }

  onQuery(card: DraftCard, value: string): void {
    this.patchCard(card.key, { query: value.toUpperCase() });
  }

  onPicked(card: DraftCard, stock: RegistryStock): void {
    this.patchCard(card.key, { stock, query: stock.symbol });
  }

  addCard(): void {
    this.cards.update((rows) => [...rows, this.emptyCard()]);
  }

  startEdit(row: PriceTracker): void {
    const prices = [row.targetPrice, ...(row.nextTargets ?? [])].filter((price) => price > 0);
    this.editingId.set(row.id);
    this.editForm = {
      action: this.displayAction(row.action),
      prices: prices.join(', '),
      quantity: String(row.quantity && row.quantity > 0 ? row.quantity : DEFAULT_QTY),
      target: row.targets?.[0]?.price ? String(row.targets[0].price) : '',
      segment: row.segment === 'delivery' ? 'delivery' : 'intraday',
    };
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.editForm = {
      action: 'Long',
      prices: '',
      quantity: String(DEFAULT_QTY),
      target: '',
      segment: 'intraday',
    };
  }

  async saveEdit(row: PriceTracker): Promise<void> {
    if (this.busy()) return;
    const parsed = this.parseSide(this.editForm.action, {
      prices: this.editForm.prices,
      quantity: this.editForm.quantity,
      target: this.editForm.target,
      segment: this.editForm.segment,
    });
    if (!parsed) {
      this.toast.error('Enter at least one trigger price');
      return;
    }
    this.busy.set(true);
    try {
      await this.trackerSvc.save(
        {
          symbol: row.symbol,
          stockName: row.stockName,
          isin: row.isin,
          action: parsed.action,
          targetPrice: parsed.trigger,
          nextTargets: parsed.nextTargets,
          targets: [{ price: parsed.target, quantity: parsed.quantity }],
          quantity: parsed.quantity,
          segment: parsed.segment,
          entryPrice: parsed.trigger,
          stopLoss: row.stopLoss,
          notes: row.notes,
        },
        row.id
      );
      this.cancelEdit();
      this.toast.success(`Updated ${row.symbol}`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to update plan');
    } finally {
      this.busy.set(false);
    }
  }

  removeCard(key: number): void {
    this.cards.update((rows) => rows.filter((card) => card.key !== key));
  }

  setSide(card: DraftCard, side: SideKey, patch: Partial<DraftSide>): void {
    this.patchCard(card.key, { [side]: { ...card[side], ...patch } });
  }

  parsedLines(card: DraftCard): ParsedLine[] {
    return [this.parseSide('Short', card.short), this.parseSide('Long', card.long)].filter(
      (line): line is ParsedLine => line != null
    );
  }

  shortPlan(card: DraftCard): ParsedLine | null {
    return this.parseSide('Short', card.short);
  }

  longPlan(card: DraftCard): ParsedLine | null {
    return this.parseSide('Long', card.long);
  }

  levelChips(side: DraftSide, action: Side): Array<{ label: string; price: number; kind: 'trigger' | 'next' }> {
    const parsed = this.parseSide(action, side);
    if (!parsed) return [];
    return [
      { label: 'Trigger', price: parsed.trigger, kind: 'trigger' as const },
      ...parsed.nextTargets.map((price, index) => ({
        label: `L${index + 2}`,
        price,
        kind: 'next' as const,
      })),
    ];
  }

  displayAction(action: string): Side {
    return trackerIsSell(action) ? 'Short' : 'Long';
  }

  sideClass(action: string): string {
    return this.displayAction(action) === 'Short' ? 'side-short' : 'side-long';
  }

  rowClass(row: BookRow): string {
    if (row.triggerHit) return 'plan-row-trigger';
    if (row.proximity === 'hot') return 'plan-row-hot';
    if (row.proximity === 'near') return 'plan-row-near';
    return '';
  }

  isLong(action: string): boolean {
    return this.displayAction(action) === 'Long';
  }

  sideBookLabel(row: Pick<PriceTracker, 'action' | 'segment'>): string {
    const side = this.isLong(row.action) ? 'Buy' : 'Sell';
    const book = row.segment === 'delivery' ? 'Delivery' : 'Intraday';
    return `${side} ${book}`;
  }

  proximityClass(row: BookRow): string {
    if (row.triggerHit) return 'text-cyan-700';
    if (row.proximity === 'hot') return 'text-emerald-700';
    if (row.proximity === 'near') return 'text-amber-700';
    return this.pnlClass(row.diffPct ?? 0);
  }

  defaultTarget(trigger: number, action: Side): number {
    if (!(trigger > 0)) return 0;
    const raw = action === 'Short' ? trigger * (1 - TARGET_PCT) : trigger * (1 + TARGET_PCT);
    return Math.round(raw * 100) / 100;
  }

  previewTarget(side: DraftSide, action: Side): number {
    return this.parseSide(action, side)?.target ?? 0;
  }

  async saveCard(card: DraftCard): Promise<void> {
    await this.commitCard(card, 'open');
  }

  openClose(row: BookRow): void {
    this.cancelEdit();
    this.refreshPickerOpen.set(false);
    this.closingRow.set(row);
    const qty = row.quantity && row.quantity > 0 ? row.quantity : DEFAULT_QTY;
    const trigger = trackerEntryPrice(row) ?? row.targetPrice;
    const followUps = (row.nextTargets ?? []).filter((price) => price > 0);
    this.closeEntries = [
      this.newCloseLeg('First entry', String(qty), this.priceField(trigger)),
      ...followUps.map((price, index) => this.newCloseLeg(`Follow-up ${index + 1}`, '', this.priceField(price))),
    ];
    const slices = allocateTrackerSlices(row);
    if (slices.length) {
      this.closeExits = slices.map((slice, index) =>
        this.newCloseLeg(
          slices.length === 1 ? 'Exit' : `Exit ${index + 1}`,
          String(slice.quantity),
          this.priceField(slice.price)
        )
      );
    } else {
      const exit = this.defaultTarget(trigger, trackerIsSell(row.action) ? 'Short' : 'Long');
      this.closeExits = [this.newCloseLeg('Exit', String(qty), this.priceField(exit))];
    }
  }

  cancelClose(): void {
    this.closingRow.set(null);
    this.closeEntries = [];
    this.closeExits = [];
  }

  addCloseLeg(kind: 'entry' | 'exit'): void {
    const blank = this.newCloseLeg(kind === 'entry' ? 'Follow-up' : 'Exit', '', '');
    if (kind === 'entry') this.closeEntries = [...this.closeEntries, blank];
    else this.closeExits = [...this.closeExits, blank];
  }

  removeCloseLeg(kind: 'entry' | 'exit', index: number): void {
    if (kind === 'entry') {
      if (this.closeEntries.length <= 1) return;
      this.closeEntries = this.closeEntries.filter((_, i) => i !== index);
    } else if (this.closeExits.length > 1) {
      this.closeExits = this.closeExits.filter((_, i) => i !== index);
    }
  }

  closePreview(): { qty: number; gross: number; charges: number; net: number } | null {
    const row = this.closingRow();
    if (!row) return null;
    const { buyLegs, sellLegs } = this.closeLegsFor(row);
    if (TradePlanService.validateExecutionLegs(buyLegs, sellLegs)) return null;
    const qty = TradePlanService.legTotalQty(buyLegs);
    const avgBuy = TradePlanService.weightedAvgPrice(buyLegs);
    const avgSell = TradePlanService.weightedAvgPrice(sellLegs);
    const short = trackerIsSell(row.action);
    const trip = this.charges.roundTrip({
      segment: trackerSegment(row),
      direction: trackerDirection(row.action),
      quantity: qty,
      entryPrice: short ? avgSell : avgBuy,
      exitPrice: short ? avgBuy : avgSell,
    });
    return { qty, gross: trip.grossPnL, charges: trip.charges, net: trip.netPnL };
  }

  closeEntryQty(): number {
    return TradePlanService.legTotalQty(this.parseCloseLegs(this.closeEntries));
  }

  closeExitQty(): number {
    return TradePlanService.legTotalQty(this.parseCloseLegs(this.closeExits));
  }

  async confirmClose(): Promise<void> {
    const row = this.closingRow();
    if (!row || this.busy()) return;
    const { buyLegs, sellLegs } = this.closeLegsFor(row);
    if (!buyLegs.length || !sellLegs.length) {
      this.toast.error('Enter quantity and price for at least one entry and one exit');
      return;
    }
    const invalid = TradePlanService.validateExecutionLegs(buyLegs, sellLegs);
    if (invalid) {
      this.toast.error(invalid);
      return;
    }
    this.busy.set(true);
    try {
      await this.trackerSvc.execute(row.id, buyLegs, sellLegs);
      this.selectedIds.update((ids) => {
        const next = new Set(ids);
        next.delete(row.id);
        return next;
      });
      this.cancelClose();
      this.toast.success(`Moved ${row.symbol} to trade history`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to close trade');
    } finally {
      this.busy.set(false);
    }
  }

  toggleBulk(): void {
    this.refreshPickerOpen.set(false);
    this.bulkOpen.update((open) => !open);
    if (!this.bulkOpen()) this.selectedIds.set(new Set());
  }

  openRefreshPicker(): void {
    if (this.refreshBusy() || this.screenerBusy()) return;
    if (this.refreshPickerOpen()) {
      this.refreshPickerOpen.set(false);
      return;
    }
    this.bulkOpen.set(false);
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
    void this.refreshCmp(symbols);
  }

  toggleSelect(id: string): void {
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  toggleSelectAllVisible(): void {
    const rows = this.rows();
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      const all = rows.every((row) => next.has(row.id));
      if (all) {
        for (const row of rows) next.delete(row.id);
      } else {
        for (const row of rows) next.add(row.id);
      }
      return next;
    });
  }

  async deleteSelected(): Promise<void> {
    const ids = [...this.selectedIds()];
    if (!ids.length || this.busy()) return;
    if (!confirm(`Remove ${ids.length} ${ids.length === 1 ? 'plan' : 'plans'}? This cannot be undone.`)) return;
    this.busy.set(true);
    try {
      const removed = await this.trackerSvc.removeMany(ids);
      this.selectedIds.set(new Set());
      this.toast.success(`Removed ${removed} ${removed === 1 ? 'plan' : 'plans'}`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to delete selected plans');
    } finally {
      this.busy.set(false);
    }
  }

  async deleteAllVisible(): Promise<void> {
    const ids = this.rows().map((row) => row.id);
    if (!ids.length || this.busy()) return;
    if (!confirm(`Remove all ${ids.length} visible plans? This cannot be undone.`)) return;
    this.busy.set(true);
    try {
      const removed = await this.trackerSvc.removeMany(ids);
      this.selectedIds.set(new Set());
      this.bulkOpen.set(false);
      this.toast.success(`Removed ${removed} ${removed === 1 ? 'plan' : 'plans'}`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to delete plans');
    } finally {
      this.busy.set(false);
    }
  }

  async refreshCardScreener(card: DraftCard): Promise<void> {
    const stock = await this.resolveStock(card);
    if (!stock) {
      this.toast.error('Pick a stock first');
      return;
    }
    await this.refreshScreenerStocks([stock.symbol]);
  }

  nextLevelsLabel(prices: number[]): string {
    return prices.map((price) => formatPrice(price)).join(' · ') || '—';
  }

  exitLabel(row: PriceTracker): string {
    const price = row.targets?.[0]?.price;
    return price && price > 0 ? formatPrice(price) : '—';
  }

  private async commitCard(card: DraftCard, mode: 'open' | 'history'): Promise<void> {
    if (this.busy()) return;
    const lines = this.parsedLines(card);
    if (!lines.length) {
      this.toast.error('Add at least one long or short price');
      return;
    }
    this.busy.set(true);
    let saved = 0;
    try {
      const stock = await this.resolveStock(card);
      if (!stock) {
        this.toast.error('Pick a stock from the registry');
        return;
      }
      for (const line of lines) {
        const payload = {
          symbol: stock.symbol,
          stockName: stock.name,
          isin: stock.isin,
          action: line.action,
          targetPrice: line.trigger,
          nextTargets: line.nextTargets,
          targets: [{ price: line.target, quantity: line.quantity }],
          quantity: line.quantity,
          segment: line.segment,
          entryPrice: line.trigger,
        };
        if (mode === 'history') {
          const { buyLegs, sellLegs } = this.legsFor(line.action, line.quantity, line.trigger, line.target);
          await this.trackerSvc.saveExecuted({ ...payload, buyLegs, sellLegs });
        } else {
          await this.trackerSvc.save(payload);
        }
        saved += 1;
      }
      this.removeCard(card.key);
      this.toast.success(`Created ${saved} ${saved === 1 ? 'trade plan' : 'trade plans'}`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to save trade book');
    } finally {
      this.busy.set(false);
    }
  }

  private async resolveStock(card: DraftCard): Promise<RegistryStock | null> {
    if (card.stock) return card.stock;
    const symbol = card.query.trim().toUpperCase();
    if (!symbol) return null;
    const listed = await this.registrySvc.ensureListed(symbol, { name: symbol });
    this.patchCard(card.key, { stock: listed, query: listed.symbol });
    return listed;
  }

  private async refreshCmp(symbols: string[]): Promise<void> {
    if (!symbols.length || this.refreshBusy()) return;
    this.refreshBusy.set(true);
    const failed: string[] = [];
    let updated = 0;
    try {
      for (const symbol of symbols) {
        const plan = this.plans().find((row) => row.symbol.trim().toUpperCase() === symbol);
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
          updated += 1;
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
      else this.toast.success(message);
    } finally {
      this.refreshBusy.set(false);
    }
  }

  private async refreshScreenerStocks(symbols: string[]): Promise<void> {
    if (this.screenerBusy()) return;
    this.screenerBusy.set(true);
    const failed: string[] = [];
    let updated = 0;
    try {
      for (const symbol of symbols) {
        try {
          const existing = await this.registrySvc.getBySymbol(symbol);
          const data = await this.screener.fetchStock(symbol, {
            isin: existing?.isin,
            name: existing?.name,
            pageUrl: existing?.screenerUrl,
          });
          const next = this.applyScreener(existing, data, symbol);
          await this.registrySvc.save(next);
          this.refreshedRegistry.update((rows) => [...rows.filter((row) => row.symbol !== next.symbol), next]);
          this.patchCardsForSymbol(symbol, data);
          updated += 1;
        } catch {
          failed.push(symbol);
        }
      }
      this.registrySvc.reload();
      this.planRegistryTick.update((n) => n + 1);
      const failNote = failed.length
        ? ` ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}.`
        : '';
      const message = `Refreshed Screener data for ${updated} stock${updated === 1 ? '' : 's'}.${failNote}`;
      if (failed.length) this.toast.error(message);
      else this.toast.success(message);
    } finally {
      this.screenerBusy.set(false);
    }
  }

  private patchCardsForSymbol(symbol: string, data: ScreenerSnapshot): void {
    this.cards.update((cards) =>
      cards.map((card) => {
        if (card.stock?.symbol !== symbol && card.query.trim().toUpperCase() !== symbol) return card;
        const stock: RegistryStock = this.applyScreener(card.stock, data, symbol);
        return { ...card, stock, query: stock.symbol };
      })
    );
  }

  private applyScreener(
    stock: RegistryStock | null,
    data: ScreenerSnapshot,
    fallbackSymbol: string
  ): RegistryStock {
    const base: RegistryStock = stock ?? {
      symbol: data.symbol || fallbackSymbol,
      name: data.name || fallbackSymbol,
      currentPrice: 0,
      supports: [],
      resistances: [],
      updatedAt: Date.now(),
    };
    return {
      ...base,
      symbol: data.symbol || base.symbol,
      name: data.name || base.name,
      currentPrice: data.currentPrice ?? base.currentPrice,
      marketCap: data.marketCap ?? base.marketCap,
      pe: data.pe ?? base.pe,
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
      updatedAt: Date.now(),
    };
  }

  private parseSide(action: Side, side: DraftSide): ParsedLine | null {
    const prices = this.parsePriceList(side.prices);
    if (!prices.length) return null;
    const trigger = prices[0];
    const quantity = parseFloat(side.quantity);
    const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : DEFAULT_QTY;
    const typedTarget = parseFloat(side.target);
    const target =
      Number.isFinite(typedTarget) && typedTarget > 0
        ? Math.round(typedTarget * 100) / 100
        : this.defaultTarget(trigger, action);
    return {
      action,
      trigger,
      nextTargets: prices.slice(1),
      quantity: qty,
      target,
      segment: side.segment === 'delivery' ? 'delivery' : 'intraday',
    };
  }

  private parsePriceList(raw: string): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const part of raw.split(/[,;@\s]+/)) {
      const n = parseFloat(part.replace(/,/g, ''));
      if (!Number.isFinite(n) || n <= 0) continue;
      const rounded = Math.round(n * 100) / 100;
      if (seen.has(rounded)) continue;
      seen.add(rounded);
      out.push(rounded);
    }
    return out;
  }

  private newCloseLeg(label: string, quantity: string, price: string): CloseLeg {
    return { key: this.closeLegKey++, label, quantity, price };
  }

  private priceField(value: number): string {
    return value > 0 ? String(value) : '';
  }

  private parseCloseLegs(legs: CloseLeg[]): ExecutionLeg[] {
    return legs
      .map((leg) => ({ quantity: parseFloat(leg.quantity), price: parseFloat(leg.price) }))
      .filter((leg) => leg.quantity > 0 && leg.price > 0);
  }

  private closeLegsFor(row: PriceTracker): { buyLegs: ExecutionLeg[]; sellLegs: ExecutionLeg[] } {
    const entries = this.parseCloseLegs(this.closeEntries);
    const exits = this.parseCloseLegs(this.closeExits);
    if (trackerIsSell(row.action)) return { buyLegs: exits, sellLegs: entries };
    return { buyLegs: entries, sellLegs: exits };
  }

  private legsFor(
    action: string,
    quantity: number,
    trigger: number,
    exit: number
  ): { buyLegs: ExecutionLeg[]; sellLegs: ExecutionLeg[] } {
    const qty = quantity > 0 ? quantity : DEFAULT_QTY;
    if (trackerIsSell(action)) {
      return {
        buyLegs: [{ quantity: qty, price: exit }],
        sellLegs: [{ quantity: qty, price: trigger }],
      };
    }
    return {
      buyLegs: [{ quantity: qty, price: trigger }],
      sellLegs: [{ quantity: qty, price: exit }],
    };
  }

  private targetProfitFor(plan: PriceTracker): number | null {
    if (!trackerIsSized(plan)) return null;
    const entry = trackerEntryPrice(plan);
    const slices = allocateTrackerSlices(plan);
    if (entry == null || !slices.length || !(plan.quantity ?? 0)) return null;
    return this.charges.ladder({
      segment: trackerSegment(plan),
      direction: trackerDirection(plan.action),
      entryPrice: entry,
      totalQuantity: plan.quantity as number,
      slices,
    }).netPnL;
  }

  private registryFor(plan: { symbol: string; isin?: string }): RegistryStock | undefined {
    const symbol = plan.symbol.trim().toUpperCase();
    return (
      this.refreshedRegistry().find((row) => row.symbol.toUpperCase() === symbol) ??
      this.planRegistry().find((row) => row.symbol.toUpperCase() === symbol)
    );
  }

  private liveCmp(plan: { symbol: string; isin?: string }): number | undefined {
    const price = this.registryFor(plan)?.currentPrice;
    return price != null && price > 0 ? price : undefined;
  }

  private liveCmpAt(plan: { symbol: string; isin?: string }): number | undefined {
    const at = this.registryFor(plan)?.updatedAt;
    return at != null && at > 0 ? at : undefined;
  }

  private patchCard(key: number, patch: Partial<DraftCard>): void {
    this.cards.update((rows) => rows.map((card) => (card.key === key ? { ...card, ...patch } : card)));
  }

  private emptyCard(): DraftCard {
    return {
      key: this.nextKey++,
      query: '',
      stock: null,
      short: this.emptySide(),
      long: this.emptySide(),
    };
  }

  private emptySide(): DraftSide {
    return {
      prices: '',
      quantity: String(DEFAULT_QTY),
      target: '',
      segment: 'intraday',
    };
  }
}

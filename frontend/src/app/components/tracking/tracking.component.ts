import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { RegistryStock } from '../../models/trading-journal.models';
import { MarketQuoteService } from '../../services/market-quote.service';
import { PriceTracker, PriceTrackerService } from '../../services/price-tracker.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { formatDataAge } from '../../utils/data-age.utils';
import { formatPrice, formatPctSigned } from '../../utils/format.utils';
import {
  parsePositivePrices,
  trackerAbsDiffPct,
  trackerDiffPct,
  trackerProximity,
} from '../../utils/price-tracker.utils';
import { TableSortState } from '../../utils/table-sort.utils';

type TrackerColumn =
  | 'symbol'
  | 'action'
  | 'targetPrice'
  | 'cmp'
  | 'diff'
  | 'nextTargets'
  | 'updatedAt';

const ACTION_PRESETS = ['Buy', 'Sell'] as const;

interface TrackerRow extends PriceTracker {
  diffPct: number | null;
  absDiffPct: number | null;
  proximity: ReturnType<typeof trackerProximity>;
}

@Component({
  selector: 'app-tracking',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './tracking.component.html',
})
export class TrackingComponent implements OnInit {
  private trackerSvc = inject(PriceTrackerService);
  private registrySvc = inject(RegistryStockService);
  private quotes = inject(MarketQuoteService);

  trackers = toSignal(this.trackerSvc.watchAll(), { initialValue: [] as PriceTracker[] });
  registry = signal<RegistryStock[]>([]);

  formOpen = signal(false);
  editingId = signal<string | null>(null);
  searchQuery = signal('');
  symbolQuery = signal('');
  busy = signal(false);
  refreshBusy = signal(false);
  refreshDone = signal(0);
  refreshTotal = signal(0);
  error = signal<string | null>(null);
  success = signal<string | null>(null);

  tableSort = new TableSortState('diff', 'asc');
  readonly actionPresets = ACTION_PRESETS;
  readonly formatPrice = formatPrice;
  readonly formatPctSigned = formatPctSigned;
  readonly formatDataAge = formatDataAge;

  form = {
    symbol: '',
    name: '',
    isin: '',
    action: 'Buy',
    targetPrice: '',
    nextTargets: [''] as string[],
    notes: '',
  };

  symbolOptions = computed(() => {
    const q = this.symbolQuery().trim().toLowerCase();
    const rows = this.registry();
    if (!q) return rows.slice(0, 30);
    return rows
      .filter(
        (s) =>
          s.symbol.toLowerCase().includes(q) || (s.name ?? '').toLowerCase().includes(q)
      )
      .slice(0, 30);
  });

  rows = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const mapped: TrackerRow[] = this.trackers().map((t) => ({
      ...t,
      diffPct: trackerDiffPct(t.cmp, t.targetPrice),
      absDiffPct: trackerAbsDiffPct(t.cmp, t.targetPrice),
      proximity: trackerProximity(t.cmp, t.targetPrice),
    }));
    const filtered = q
      ? mapped.filter(
          (t) =>
            t.symbol.toLowerCase().includes(q) ||
            (t.stockName ?? '').toLowerCase().includes(q) ||
            t.action.toLowerCase().includes(q)
        )
      : mapped;
    return this.tableSort.sort(filtered, (row, column) => this.sortValue(row, column as TrackerColumn));
  });

  nearCount = computed(() => this.rows().filter((r) => r.proximity === 'near').length);
  hotCount = computed(() => this.rows().filter((r) => r.proximity === 'hot').length);

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
  }

  openAddForm(): void {
    this.resetForm();
    this.editingId.set(null);
    this.formOpen.set(true);
    this.error.set(null);
    this.success.set(null);
  }

  onAddClick(): void {
    if (this.formOpen() && !this.editingId()) {
      this.cancelForm();
      return;
    }
    this.openAddForm();
  }

  toggleForm(): void {
    if (this.formOpen()) {
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
    this.form.action = tracker.action;
    this.form.targetPrice = String(tracker.targetPrice);
    this.form.nextTargets = tracker.nextTargets.length ? tracker.nextTargets.map(String) : [''];
    this.form.notes = tracker.notes ?? '';
    this.symbolQuery.set(tracker.symbol);
    this.formOpen.set(true);
    this.error.set(null);
    this.success.set(null);
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

  setAction(action: string): void {
    this.form.action = action;
  }

  addNextTarget(): void {
    this.form.nextTargets = [...this.form.nextTargets, ''];
  }

  removeNextTarget(index: number): void {
    const next = this.form.nextTargets.filter((_, i) => i !== index);
    this.form.nextTargets = next.length ? next : [''];
  }

  trackNextTarget(index: number): number {
    return index;
  }

  rowClass(row: TrackerRow): string {
    if (row.proximity === 'hot') return 'bg-emerald-100/80';
    if (row.proximity === 'near') return 'bg-yellow-100/80';
    return '';
  }

  toggleSort(column: TrackerColumn, event?: Event): void {
    this.tableSort.toggle(column, event);
  }

  async save(): Promise<void> {
    const picked = this.findRegistry(this.form.symbol || this.symbolQuery());
    if (!picked) {
      this.error.set('Pick a stock from the registry');
      return;
    }
    const action = this.form.action.trim();
    if (!action) {
      this.error.set('Say what you want to do at this price (Buy, Sell, …)');
      return;
    }
    const targetPrice = parseFloat(this.form.targetPrice);
    if (!(targetPrice > 0)) {
      this.error.set('Enter a target price');
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    this.success.set(null);
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
          nextTargets: this.form.nextTargets,
          cmp: existing?.cmp ?? (picked.currentPrice > 0 ? picked.currentPrice : undefined),
          cmpSource: existing?.cmpSource ?? this.quotes.source,
          cmpFetchedAt: existing?.cmpFetchedAt,
          notes: this.form.notes,
        },
        this.editingId() ?? undefined
      );
      this.success.set(this.editingId() ? `Updated ${picked.symbol}` : `Tracking ${picked.symbol}`);
      this.cancelForm();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Failed to save tracker');
    } finally {
      this.busy.set(false);
    }
  }

  async remove(tracker: PriceTracker): Promise<void> {
    if (!confirm(`Stop tracking ${tracker.symbol} at ${formatPrice(tracker.targetPrice)}?`)) return;
    this.error.set(null);
    try {
      await this.trackerSvc.remove(tracker.id);
      if (this.editingId() === tracker.id) this.cancelForm();
      this.success.set(`Removed ${tracker.symbol}`);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Failed to remove tracker');
    }
  }

  async refreshAll(): Promise<void> {
    const symbols = [...new Set(this.trackers().map((t) => t.symbol))];
    if (!symbols.length) {
      this.success.set('Nothing to refresh yet. Add a tracker first.');
      return;
    }

    this.refreshBusy.set(true);
    this.error.set(null);
    this.success.set(null);
    const failed: string[] = [];
    let updated = 0;
    try {
      this.refreshTotal.set(symbols.length);
      for (const [index, symbol] of symbols.entries()) {
        this.refreshDone.set(index);
        const name = this.trackers().find((t) => t.symbol === symbol)?.stockName;
        try {
          const quote = await this.quotes.quote(symbol, name);
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
      this.success.set(`Refreshed CMP for ${updated} stock${updated === 1 ? '' : 's'} from ${this.quotes.source}.${failNote}`);
    } finally {
      this.refreshBusy.set(false);
      this.refreshDone.set(0);
      this.refreshTotal.set(0);
    }
  }

  nextLevelsLabel(targets: number[]): string {
    return parsePositivePrices(targets).map((n) => formatPrice(n)).join(' · ') || '—';
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
    this.symbolQuery.set(stock.symbol);
  }

  private resetForm(): void {
    this.form.symbol = '';
    this.form.name = '';
    this.form.isin = '';
    this.form.action = 'Buy';
    this.form.targetPrice = '';
    this.form.nextTargets = [''];
    this.form.notes = '';
    this.symbolQuery.set('');
  }
}

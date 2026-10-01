import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CustomStockListService } from '../../services/custom-stock-list.service';
import { FilteredStockService } from '../../services/filtered-stock.service';
import { LazyTradeLoaderService } from '../../services/lazy-trade-loader.service';
import { PageShellService } from '../../services/page-shell.service';
import { ReportStateService } from '../../services/report-state.service';
import { StockSummary } from '../../models/trade.models';
import { formatCurrency, pnlClass } from '../../utils/format.utils';
import { stockIdentityKey } from '../../utils/stock-identity.utils';

@Component({
  selector: 'app-custom-stock-list-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './custom-stock-list-editor.component.html',
})
export class CustomStockListEditorComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private pageShell = inject(PageShellService);
  readonly state = inject(ReportStateService);
  readonly filteredStocks = inject(FilteredStockService);
  readonly customLists = inject(CustomStockListService);
  private lazyTrades = inject(LazyTradeLoaderService);

  readonly formatCurrency = formatCurrency;
  readonly pnlClass = pnlClass;

  readonly editingId = signal<string | null>(null);
  readonly name = signal('');
  readonly searchQuery = signal('');
  readonly showMode = signal<'selected' | 'all'>('all');
  readonly selectedSymbols = signal<Set<string>>(new Set());
  readonly makeDefault = signal(false);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly isEditing = computed(() => this.editingId() != null);
  readonly replacingDefaultName = computed(() => {
    if (!this.makeDefault()) return null;
    const currentDefault = this.customLists.lists().find((list) => this.customLists.isDefault(list.id));
    if (!currentDefault) return null;
    if (currentDefault.id === this.editingId()) return null;
    return currentDefault.name;
  });

  private originalName = '';
  private originalSymbols = new Set<string>();
  private originalDefault = false;

  readonly allStocks = computed(() => {
    const report = this.state.report();
    if (report?.stockSummary?.length) return report.stockSummary;
    return this.filteredStocks.stocks();
  });

  readonly visibleStocks = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const stocks =
      this.showMode() === 'selected' ? this.selectedStockRows() : this.sortedAllStocks();
    if (!q) return stocks;
    return stocks.filter((stock) => this.stockHaystack(stock).includes(q));
  });

  readonly selectedCount = computed(() => this.selectedSymbols().size);

  readonly orphanSymbols = computed(() => {
    const known = new Set(this.allStocks().map((stock) => this.stockSymbol(stock)));
    return [...this.selectedSymbols()].filter((symbol) => !known.has(symbol)).sort();
  });

  private readonly _syncPageHeader = effect((onCleanup) => {
    const editing = this.isEditing();
    this.pageShell.setHeader(
      editing ? 'Edit custom list' : 'New custom list',
      'Choose stocks to show on the Dashboard Custom tab'
    );
    onCleanup(() => this.pageShell.clearOverride());
  }, { allowSignalWrites: true });

  async ngOnInit(): Promise<void> {
    await this.state.ensureLoadedFromFirebase();
    await this.customLists.ensureLoaded();
    const id = this.route.snapshot.paramMap.get('id');
    this.editingId.set(id);
    if (!id) {
      this.captureOriginal();
      this.loading.set(false);
      return;
    }

    const list = await this.customLists.getById(id);
    if (!list) {
      this.error.set('This list was not found.');
      this.loading.set(false);
      return;
    }
    this.name.set(list.name);
    this.selectedSymbols.set(new Set(list.stockSymbols.map((symbol) => symbol.toUpperCase())));
    this.makeDefault.set(this.customLists.isDefault(list.id));
    this.showMode.set('selected');
    this.captureOriginal();
    this.loading.set(false);
  }

  stockSymbol(stock: StockSummary): string {
    return this.lazyTrades.stockSymbol(stock);
  }

  stockRowKey(stock: StockSummary): string {
    return stockIdentityKey(stock);
  }

  isSelected(stock: StockSummary): boolean {
    return this.selectedSymbols().has(this.stockSymbol(stock));
  }

  toggleStock(stock: StockSummary): void {
    this.removeOrAddSymbol(this.stockSymbol(stock));
  }

  removeStock(stock: StockSummary, event?: Event): void {
    event?.stopPropagation();
    this.removeSymbol(this.stockSymbol(stock));
  }

  removeSymbol(symbol: string, event?: Event): void {
    event?.stopPropagation();
    const key = symbol.trim().toUpperCase();
    if (!key) return;
    this.selectedSymbols.update((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  private removeOrAddSymbol(symbol: string): void {
    this.selectedSymbols.update((current) => {
      const next = new Set(current);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  }

  selectVisible(): void {
    this.selectedSymbols.update((current) => {
      const next = new Set(current);
      for (const stock of this.visibleStocks()) next.add(this.stockSymbol(stock));
      return next;
    });
  }

  clearVisible(): void {
    const visible = new Set(this.visibleStocks().map((stock) => this.stockSymbol(stock)));
    this.selectedSymbols.update((current) => {
      const next = new Set(current);
      for (const symbol of visible) next.delete(symbol);
      return next;
    });
  }

  clearAll(): void {
    this.selectedSymbols.set(new Set());
  }

  cancelEdits(): void {
    this.name.set(this.originalName);
    this.selectedSymbols.set(new Set(this.originalSymbols));
    this.makeDefault.set(this.originalDefault);
    this.searchQuery.set('');
    this.showMode.set(this.isEditing() ? 'selected' : 'all');
    void this.leaveEditor();
  }

  async save(): Promise<void> {
    const name = this.name().trim();
    if (!name || !this.selectedCount()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const symbols = [...this.selectedSymbols()];
      const id = this.editingId();
      const options = { isDefault: this.makeDefault() };
      if (id) await this.customLists.update(id, name, symbols, options);
      else await this.customLists.create(name, symbols, options);
      await this.leaveEditor();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not save this list');
    } finally {
      this.saving.set(false);
    }
  }

  private captureOriginal(): void {
    this.originalName = this.name();
    this.originalSymbols = new Set(this.selectedSymbols());
    this.originalDefault = this.makeDefault();
  }

  leaveEditor(): Promise<boolean> {
    return this.router.navigate(['/analytics'], {
      queryParams: { tab: 'custom' },
      queryParamsHandling: 'merge',
    });
  }

  private stockHaystack(stock: StockSummary): string {
    return [stock.stockName, stock.isin, this.stockSymbol(stock)].filter(Boolean).join(' ').toLowerCase();
  }

  private sortedAllStocks(): StockSummary[] {
    return [...this.allStocks()].sort((a, b) => a.stockName.localeCompare(b.stockName));
  }

  private selectedStockRows(): StockSummary[] {
    const selected = this.selectedSymbols();
    return this.sortedAllStocks().filter((stock) => selected.has(this.stockSymbol(stock)));
  }
}

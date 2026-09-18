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
  readonly selectedSymbols = signal<Set<string>>(new Set());
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly isEditing = computed(() => this.editingId() != null);

  readonly allStocks = computed(() => {
    const report = this.state.report();
    if (report?.stockSummary?.length) return report.stockSummary;
    return this.filteredStocks.stocks();
  });

  readonly visibleStocks = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const stocks = [...this.allStocks()].sort((a, b) => a.stockName.localeCompare(b.stockName));
    if (!q) return stocks;
    return stocks.filter((stock) => this.stockHaystack(stock).includes(q));
  });

  readonly selectedCount = computed(() => this.selectedSymbols().size);

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
    const id = this.route.snapshot.paramMap.get('id');
    this.editingId.set(id);
    if (!id) {
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
    const symbol = this.stockSymbol(stock);
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

  async save(): Promise<void> {
    const name = this.name().trim();
    if (!name || !this.selectedCount()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const symbols = [...this.selectedSymbols()];
      const id = this.editingId();
      if (id) await this.customLists.update(id, name, symbols);
      else await this.customLists.create(name, symbols);
      await this.router.navigate(['/analytics'], { queryParams: { tab: 'custom' }, queryParamsHandling: 'merge' });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not save this list');
    } finally {
      this.saving.set(false);
    }
  }

  private stockHaystack(stock: StockSummary): string {
    return [stock.stockName, stock.isin, this.stockSymbol(stock)].filter(Boolean).join(' ').toLowerCase();
  }
}

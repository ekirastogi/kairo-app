import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { RegistryStock } from '../../../models/trading-journal.models';
import { STOCK_SEARCH_MIN_CHARS, StockSearchService } from '../../../services/stock-search.service';

function norm(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

@Component({
  selector: 'app-stock-search-input',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './stock-search-input.component.html',
  host: { class: 'relative block' },
  styles: `
    .stock-search-hint {
      @apply mt-1 block text-[11px] not-italic text-slate-400;
    }
  `,
})
export class StockSearchInputComponent {
  private stockSearch = inject(StockSearchService);

  query = input('');
  extraStocks = input<RegistryStock[]>([]);
  selectedName = input('');
  selectedExchange = input('');
  disabled = input(false);
  placeholder = input('Type at least 2 letters to search…');

  queryChange = output<string>();
  picked = output<RegistryStock>();

  readonly listId = `stock-search-${crypto.randomUUID()}`;
  readonly minChars = STOCK_SEARCH_MIN_CHARS;

  private search = this.stockSearch.bindQuery(this.query);
  options = this.search.results;
  busy = this.search.busy;
  open = signal(false);
  activeIndex = signal(0);
  private lastEmitted = '';

  showResults = computed(() => {
    if (!this.open()) return false;
    const q = norm(this.query());
    if (q.length < this.minChars) return false;
    if (!this.options().length) return false;
    const selected = this.extraStocks().some((stock) => stock.symbol.toUpperCase() === q);
    return !selected;
  });

  constructor() {
    effect(() => {
      const q = this.query();
      const rows = this.options();
      const match = this.matchIn(rows, q);
      if (match) this.emitPick(match);
    });
  }

  onQuery(value: string): void {
    this.open.set(true);
    this.activeIndex.set(0);
    if (norm(value) !== this.lastEmitted) this.lastEmitted = '';
    this.queryChange.emit(value);
    const match = this.findMatch(value);
    if (match) this.emitPick(match);
  }

  onKey(event: KeyboardEvent): void {
    if (!this.showResults()) {
      if (event.key === 'Enter') {
        const match = this.findMatch(this.query()) ?? this.singleOption();
        if (match) {
          event.preventDefault();
          this.pick(match);
        }
      }
      return;
    }
    const rows = this.options();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex.update((i) => (i + 1) % rows.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex.update((i) => (i - 1 + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const match = this.findMatch(this.query()) ?? rows[this.activeIndex()] ?? this.singleOption();
      if (match) this.pick(match);
    } else if (event.key === 'Escape') {
      this.open.set(false);
    }
  }

  pick(stock: RegistryStock, event?: Event): void {
    event?.preventDefault();
    this.open.set(false);
    this.emitPick(stock);
  }

  private singleOption(): RegistryStock | undefined {
    const rows = this.options();
    return rows.length === 1 ? rows[0] : undefined;
  }

  private emitPick(stock: RegistryStock): void {
    if (this.lastEmitted === stock.symbol.toUpperCase()) return;
    this.lastEmitted = stock.symbol.toUpperCase();
    this.picked.emit(stock);
  }

  private findMatch(value: string): RegistryStock | undefined {
    return this.matchIn(this.options(), value) ?? this.matchIn(this.extraStocks(), value);
  }

  private matchIn(stocks: RegistryStock[], value: string): RegistryStock | undefined {
    const q = norm(value);
    if (!q) return undefined;
    return (
      stocks.find((stock) => stock.symbol.toUpperCase() === q) ??
      stocks.find((stock) => norm(stock.name) === q)
    );
  }
}

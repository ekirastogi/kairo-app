import { Component, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { RegistryStock } from '../../../models/trading-journal.models';
import { STOCK_SEARCH_MIN_CHARS, StockSearchService } from '../../../services/stock-search.service';

@Component({
  selector: 'app-stock-search-input',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './stock-search-input.component.html',
  host: { class: 'block' },
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

  onQuery(value: string): void {
    this.queryChange.emit(value);
    const match = this.matchStock(value);
    if (match) this.picked.emit(match);
  }

  private matchStock(value: string): RegistryStock | undefined {
    const q = value.trim().toUpperCase();
    if (!q) return undefined;
    return (
      this.options().find((stock) => stock.symbol.toUpperCase() === q) ??
      this.extraStocks().find((stock) => stock.symbol.toUpperCase() === q)
    );
  }
}

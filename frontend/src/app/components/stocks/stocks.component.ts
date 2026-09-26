import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { StockFirestoreService } from '../../services/stock-firestore.service';
import { StockSnapshot } from '../../models/market.models';
import { formatPrice, pnlClass } from '../../utils/format.utils';
import { TableSortState } from '../../utils/table-sort.utils';

@Component({
  selector: 'app-stocks',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './stocks.component.html',
})
export class StocksComponent {
  private stockSvc = inject(StockFirestoreService);

  readonly stocks = toSignal(this.stockSvc.watchMarketCatalog(), { initialValue: [] as StockSnapshot[] });
  search = signal('');
  readonly tableSort = new TableSortState('symbol', 'asc');

  readonly fmtPrice = formatPrice;
  readonly pnlClass = pnlClass;

  readonly columns = [
    { key: 'symbol', label: 'Symbol', align: 'left' as const },
    { key: 'name', label: 'Name', align: 'left' as const },
    { key: 'ltp', label: 'LTP', align: 'right' as const },
    { key: 'changePct', label: 'Change', align: 'right' as const },
    { key: 'marketCap', label: 'Mkt cap', align: 'right' as const },
    { key: 'pe', label: 'P/E', align: 'right' as const },
    { key: 'sector', label: 'Sector', align: 'left' as const },
    { key: 'lastUpdated', label: 'Updated', align: 'left' as const },
  ];

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    let rows = this.stocks();
    if (q) {
      rows = rows.filter(
        (s) =>
          s.symbol.toLowerCase().includes(q) ||
          (s.name ?? '').toLowerCase().includes(q) ||
          (s.sector ?? '').toLowerCase().includes(q)
      );
    }
    return this.tableSort.sort(rows, (stock, col) => this.sortValue(stock, col));
  });

  readonly summary = computed(() => {
    const rows = this.stocks();
    const withCap = rows.filter((s) => s.marketCap > 0).length;
    const gainers = rows.filter((s) => s.changePct > 0).length;
    const losers = rows.filter((s) => s.changePct < 0).length;
    return { total: rows.length, withCap, gainers, losers };
  });

  onSearch(value: string): void {
    this.search.set(value);
  }

  formatMarketCap(value: number | undefined): string {
    if (!value || value <= 0) return '—';
    return `${(value / 1e7).toFixed(0)} Cr`;
  }

  formatPe(value: number | undefined): string {
    if (value == null || value <= 0) return '—';
    return value.toFixed(1);
  }

  formatUpdated(iso: string | undefined): string {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '—';
    const diffMin = Math.floor((Date.now() - t) / 60_000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  private sortValue(stock: StockSnapshot, col: string): string | number {
    switch (col) {
      case 'symbol':
        return stock.symbol;
      case 'name':
        return stock.name ?? '';
      case 'ltp':
        return stock.ltp ?? 0;
      case 'changePct':
        return stock.changePct ?? 0;
      case 'marketCap':
        return stock.marketCap ?? 0;
      case 'pe':
        return stock.pe ?? 0;
      case 'sector':
        return stock.sector ?? '';
      case 'lastUpdated':
        return stock.lastUpdated ? new Date(stock.lastUpdated).getTime() : 0;
      default:
        return 0;
    }
  }
}

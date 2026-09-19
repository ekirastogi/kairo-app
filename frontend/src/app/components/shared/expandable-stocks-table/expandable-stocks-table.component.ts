import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { StockSummary, TRADE_TYPE_LABELS, Trade, TradeType } from '../../../models/trade.models';
import { ReportStateService } from '../../../services/report-state.service';
import { LazyTradeLoaderService } from '../../../services/lazy-trade-loader.service';
import { formatCurrency, formatDate, formatPct, pnlClass } from '../../../utils/format.utils';
import { normalizeSymbol } from '../../../utils/upload-merge.utils';
import { stockIdentityKey } from '../../../utils/stock-identity.utils';
import { summariseTradesByDay, TradeDaySummary } from '../../../utils/trade-day-summary.utils';
import {
  tradeAllocatedCharge,
  tradeChargeFns,
  tradeNetPnL,
} from '../../../utils/trade-charges.utils';

export type ExpandableStockColumn =
  | 'stockName'
  | 'tradeCount'
  | 'quantity'
  | 'buyValue'
  | 'sellValue'
  | 'realisedPnL'
  | 'realisedPnLPct'
  | 'allocatedCharges'
  | 'netPnL'
  | 'winRate';

type SortDir = 'asc' | 'desc';

const ALL_COLUMNS: { key: ExpandableStockColumn; label: string }[] = [
  { key: 'stockName', label: 'Stock' },
  { key: 'tradeCount', label: 'Trades' },
  { key: 'quantity', label: 'Qty' },
  { key: 'buyValue', label: 'Buy Value' },
  { key: 'sellValue', label: 'Sell Value' },
  { key: 'realisedPnL', label: 'P&L' },
  { key: 'realisedPnLPct', label: 'P&L %' },
  { key: 'allocatedCharges', label: 'Charges' },
  { key: 'netPnL', label: 'Net P&L' },
  { key: 'winRate', label: 'Win %' },
];

/**
 * Analytics-style stock columns with dashboard/watchlist day→trades accordion.
 * Expanded rows stay compact on mobile (no metric-card grids).
 */
@Component({
  selector: 'app-expandable-stocks-table',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './expandable-stocks-table.component.html',
})
export class ExpandableStocksTableComponent {
  private state = inject(ReportStateService);
  private lazyTrades = inject(LazyTradeLoaderService);

  stocks = input.required<StockSummary[]>();
  emptyMessage = input('No stock data for current filters');
  showFooter = input(true);
  expandable = input(true);
  /** Subset of columns to show; defaults to the analytics set. */
  columns = input<ExpandableStockColumn[] | null>(null);
  /**
   * When set with periodKey, expanded stock trades are clipped to that
   * daily / weekly / monthly / weekday bucket — never the full filter window.
   */
  periodTab = input<'daily' | 'weekly' | 'monthly' | 'weekday' | 'dayOfMonth' | 'monthOfYear' | null>(
    null
  );
  periodKey = input<string | null>(null);

  sortColumn = signal<ExpandableStockColumn>('netPnL');
  sortDirection = signal<SortDir>('desc');
  expandedStockKey = signal<string | null>(null);
  expandedDayKey = signal<string | null>(null);

  readonly formatCurrency = formatCurrency;
  readonly formatPct = formatPct;
  readonly formatDate = formatDate;
  readonly pnlClass = pnlClass;

  visibleColumns = computed(() => {
    const keys = this.columns();
    if (!keys?.length) return ALL_COLUMNS;
    const set = new Set(keys);
    return ALL_COLUMNS.filter((col) => set.has(col.key));
  });

  chargeRatio = computed(() => this.state.analysis()?.summary.chargeRatio ?? 0);

  rows = computed(() => {
    const key = this.sortColumn();
    const dir = this.sortDirection() === 'asc' ? 1 : -1;
    return [...this.stocks()].sort((a, b) => {
      if (key === 'stockName') return a.stockName.localeCompare(b.stockName) * dir;
      return (this.metric(a, key) - this.metric(b, key)) * dir;
    });
  });

  totals = computed(() => {
    if (!this.showFooter()) return null;
    const stocks = this.rows();
    if (!stocks.length) return null;

    const sum = (pick: (s: StockSummary) => number) =>
      stocks.reduce((acc, stock) => acc + pick(stock), 0);
    const buyValue = sum((s) => s.buyValue);
    const realisedPnL = sum((s) => s.realisedPnL);

    return {
      stockCount: stocks.length,
      tradeCount: sum((s) => s.tradeCount),
      quantity: sum((s) => s.quantity),
      buyValue,
      sellValue: sum((s) => s.sellValue),
      realisedPnL,
      realisedPnLPct: buyValue > 0 ? realisedPnL / buyValue : 0,
      allocatedCharges: sum((s) => s.allocatedCharges),
      netPnL: sum((s) => s.netPnL),
    };
  });

  expandedDays = computed((): TradeDaySummary[] => {
    const key = this.expandedStockKey();
    if (!key) return [];
    const stock = this.rows().find((s) => this.stockRowKey(s) === key);
    if (!stock) return [];
    const trades = this.tradesForStock(stock);
    const { chargeForTrade, netPnLForTrade } = tradeChargeFns(this.chargeRatio());
    return summariseTradesByDay(trades, chargeForTrade, netPnLForTrade);
  });

  expandedTradeCount = computed(() =>
    this.expandedDays().reduce((sum, day) => sum + day.tradeCount, 0)
  );

  private metric(stock: StockSummary, key: ExpandableStockColumn): number {
    switch (key) {
      case 'tradeCount':
        return stock.tradeCount;
      case 'quantity':
        return stock.quantity;
      case 'buyValue':
        return stock.buyValue;
      case 'sellValue':
        return stock.sellValue;
      case 'realisedPnL':
        return stock.realisedPnL;
      case 'realisedPnLPct':
        return stock.realisedPnLPct;
      case 'allocatedCharges':
        return stock.allocatedCharges;
      case 'winRate':
        return stock.winRate ?? -1;
      default:
        return stock.netPnL;
    }
  }

  toggleSort(column: ExpandableStockColumn, event?: Event): void {
    event?.stopPropagation();
    if (this.sortColumn() === column) {
      this.sortDirection.update((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    this.sortColumn.set(column);
    this.sortDirection.set(column === 'stockName' ? 'asc' : 'desc');
  }

  sortIndicator(column: ExpandableStockColumn): string {
    if (this.sortColumn() !== column) return '';
    return this.sortDirection() === 'asc' ? '↑' : '↓';
  }

  isSortedColumn(column: ExpandableStockColumn): boolean {
    return this.sortColumn() === column;
  }

  stockSymbol(stock: StockSummary): string {
    return (stock.symbol || normalizeSymbol(stock.stockName)).toUpperCase();
  }

  stockRowKey(stock: StockSummary): string {
    return stockIdentityKey(stock);
  }

  responsiveClass(key: ExpandableStockColumn): string {
    if (key === 'stockName' || key === 'netPnL') return '';
    if (key === 'tradeCount' || key === 'realisedPnL') return 'hidden sm:table-cell';
    return 'hidden lg:table-cell';
  }

  cellClass(key: ExpandableStockColumn, stock: StockSummary): string {
    const base = 'text-right tabular-nums';
    switch (key) {
      case 'realisedPnL':
      case 'realisedPnLPct':
        return `${base} ${pnlClass(stock.realisedPnL)}`;
      case 'allocatedCharges':
        return `${base} text-red-600`;
      case 'netPnL':
        return `${base} font-semibold ${pnlClass(stock.netPnL)}`;
      default:
        return base;
    }
  }

  totalsCellClass(key: ExpandableStockColumn): string {
    const totals = this.totals();
    const base = 'text-right tabular-nums font-semibold';
    if (!totals) return base;
    switch (key) {
      case 'realisedPnL':
      case 'realisedPnLPct':
        return `${base} ${pnlClass(totals.realisedPnL)}`;
      case 'allocatedCharges':
        return `${base} text-red-600`;
      case 'netPnL':
        return `${base} ${pnlClass(totals.netPnL)}`;
      default:
        return base;
    }
  }

  isStockExpanded(stock: StockSummary): boolean {
    return this.expandedStockKey() === this.stockRowKey(stock);
  }

  async toggleStockExpand(stock: StockSummary): Promise<void> {
    if (!this.expandable()) return;
    const key = this.stockRowKey(stock);
    const expanding = this.expandedStockKey() !== key;
    this.expandedStockKey.set(expanding ? key : null);
    this.expandedDayKey.set(null);
    if (expanding) {
      await this.ensureStockTradesLoaded(stock);
    }
  }

  /** Drop open rows when the parent switches day/week/month. */
  private readonly _resetOnPeriodChange = effect(() => {
    this.periodTab();
    this.periodKey();
    untracked(() => {
      this.expandedStockKey.set(null);
      this.expandedDayKey.set(null);
    });
  });

  isStockTradesLoading(stock: StockSummary): boolean {
    return this.lazyTrades.isLoading(this.tradesCacheKey(stock));
  }

  tradesForStock(stock: StockSummary): Trade[] {
    return this.lazyTrades.tradesForKey(this.tradesCacheKey(stock));
  }

  dayRowKey(stock: StockSummary, date: string): string {
    return `${this.stockRowKey(stock)}:${date}`;
  }

  isDayExpanded(stock: StockSummary, date: string): boolean {
    return this.expandedDayKey() === this.dayRowKey(stock, date);
  }

  toggleDayExpand(stock: StockSummary, date: string, event: Event): void {
    event.stopPropagation();
    const key = this.dayRowKey(stock, date);
    this.expandedDayKey.set(this.expandedDayKey() === key ? null : key);
  }

  tradeTypeLabel(type: TradeType): string {
    return TRADE_TYPE_LABELS[type] || type;
  }

  tradeAllocatedCharge(trade: Trade): number {
    return tradeAllocatedCharge(trade, this.chargeRatio());
  }

  tradeNetPnL(trade: Trade): number {
    return tradeNetPnL(trade, this.chargeRatio());
  }

  colSpan(): number {
    return this.visibleColumns().length + (this.expandable() ? 2 : 1);
  }

  private tradesCacheKey(stock: StockSummary): string {
    const tab = this.periodTab();
    const period = this.periodKey();
    if (tab && period) {
      return this.lazyTrades.cacheKeyForStockInPeriod(stock, tab, period);
    }
    return this.lazyTrades.cacheKeyForStock(stock);
  }

  private clientCode(): string | null {
    return this.state.activeClientCode() ?? this.state.report()?.summary.clientCode ?? null;
  }

  private async ensureStockTradesLoaded(stock: StockSummary): Promise<void> {
    const clientCode = this.clientCode();
    if (!clientCode) return;
    const tab = this.periodTab();
    const period = this.periodKey();
    if (tab && period) {
      await this.lazyTrades.loadForStockInPeriod(
        clientCode,
        stock,
        tab,
        period,
        this.state.report(),
        this.state.analysisOptions()
      );
      return;
    }
    await this.lazyTrades.loadForStock(
      clientCode,
      stock,
      this.state.report(),
      this.state.analysisOptions()
    );
  }
}

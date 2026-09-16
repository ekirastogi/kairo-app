import { Component, inject, signal, effect, output, input, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReportStateService } from '../../../services/report-state.service';
import { FilterUrlService } from '../../../services/filter-url.service';
import { TRADE_TYPE_LABELS, TradeType } from '../../../models/trade.models';
import { DateRangeFilterComponent } from '../date-range-filter/date-range-filter.component';

@Component({
  selector: 'app-filter-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DateRangeFilterComponent],
  templateUrl: './filter-panel.component.html',
})
export class FilterPanelComponent {
  readonly state = inject(ReportStateService);
  private filterUrl = inject(FilterUrlService);
  readonly tradeTypeLabels = TRADE_TYPE_LABELS;

  collapsible = input(false);
  showChartFilters = input(false);
  showDateRange = input(true);
  showTradeTypes = input(true);
  filtersChanged = output<void>();

  localTradeTypes = signal<TradeType[]>(['all']);
  chartPeriod = signal<'daily' | 'weekly' | 'monthly'>('daily');
  topStocksCount = signal(10);
  filtersExpanded = signal(false);

  availableTradeTypes = () => {
    const types = this.state.report()?.tradeTypes ?? ['all', 'intraday', 'delivery'];
    const visible = types.filter((t) => t !== 'mtf');
    return visible.length > 1 ? visible : ['all', 'intraday', 'delivery'];
  };

  constructor() {
    effect(() => {
      if (!this.state.hasReport()) return;
      const types = [...this.state.selectedTradeTypes()];
      const period = this.state.chartPeriod();
      const top = this.state.topStocksCount();
      untracked(() => {
        this.localTradeTypes.set(types);
        this.chartPeriod.set(period);
        this.topStocksCount.set(top);
      });
    });
  }

  toggleExpanded(): void {
    this.filtersExpanded.update((v) => !v);
  }

  applyFilters(): void {
    this.filterUrl.updateDateRange(
      this.state.startDate(),
      this.state.endDate(),
      this.localTradeTypes(),
      this.showChartFilters() ? this.chartPeriod() : undefined,
      this.showChartFilters() ? this.topStocksCount() : undefined,
      this.state.datePeriod()
    );
    this.filtersChanged.emit();
  }

  resetFilters(): void {
    this.filterUrl.resetFilters();
    this.filtersChanged.emit();
  }

  toggleTradeType(type: string): void {
    const tt = type as TradeType;
    if (tt === 'all') {
      this.localTradeTypes.set(['all']);
      return;
    }
    const current = this.localTradeTypes().filter((t) => t !== 'all');
    const idx = current.indexOf(tt);
    if (idx >= 0) {
      const next = current.filter((t) => t !== tt);
      this.localTradeTypes.set(next.length ? next : ['all']);
    } else {
      this.localTradeTypes.set([...current, tt]);
    }
  }

  isTradeTypeSelected(type: string): boolean {
    const tt = type as TradeType;
    const selected = this.localTradeTypes();
    return tt === 'all' ? selected.includes('all') : selected.includes(tt);
  }

  activeFilterCount(): number {
    let count = 0;
    const report = this.state.report();
    if (!report) return 0;
    if (this.state.startDate() !== report.dateRange.min || this.state.endDate() !== report.dateRange.max) count++;
    if (!this.state.selectedTradeTypes().includes('all')) count += this.state.selectedTradeTypes().length;
    if (this.showChartFilters()) {
      if (this.state.chartPeriod() !== 'daily') count++;
      if (this.state.topStocksCount() !== 10) count++;
    }
    return count;
  }
}

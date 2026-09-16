import { Component, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ReportStateService } from '../../../services/report-state.service';
import { FilterUrlService } from '../../../services/filter-url.service';
import { formatDate } from '../../../utils/format.utils';
import {
  DATE_RANGE_PRESETS,
  DateRangePresetId,
  rangeForPreset,
} from '../../../utils/date-range-preset.utils';

@Component({
  selector: 'app-date-range-filter',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './date-range-filter.component.html',
})
export class DateRangeFilterComponent {
  readonly state = inject(ReportStateService);
  private filterUrl = inject(FilterUrlService);

  variant = input<'toolbar' | 'panel'>('toolbar');

  readonly presets = DATE_RANGE_PRESETS;
  readonly formatDate = formatDate;
  customOpen = signal(false);

  bounds = computed(() => {
    const range = this.state.report()?.dateRange;
    return { min: range?.min ?? '', max: range?.max ?? '' };
  });

  /** Prefer explicit user period from state/URL — never guess All vs Last from dates. */
  activePreset = computed(() => this.state.datePeriod());

  rangeCaption = computed(() => {
    const start = this.state.startDate();
    const end = this.state.endDate();
    if (!start || !end) return '';
    return `${formatDate(start)} – ${formatDate(end)}`;
  });

  showCustomDates = computed(() => this.customOpen() || this.activePreset() === 'custom');

  isPresetActive(id: DateRangePresetId): boolean {
    return !this.showCustomDates() && this.activePreset() === id;
  }

  selectPreset(id: DateRangePresetId): void {
    const report = this.state.report();
    if (!report) return;
    this.customOpen.set(false);
    const range = rangeForPreset(id, this.bounds());
    this.filterUrl.updateDateRange(
      range.start,
      range.end,
      this.state.selectedTradeTypes(),
      undefined,
      undefined,
      id
    );
  }

  toggleCustom(): void {
    this.customOpen.update((open) => !open);
  }

  onCustomDateChange(which: 'start' | 'end', value: string): void {
    const report = this.state.report();
    if (!report || !value) return;
    let start = which === 'start' ? value : this.state.startDate();
    let end = which === 'end' ? value : this.state.endDate();
    if (start && end && start > end) {
      if (which === 'start') end = start;
      else start = end;
    }
    this.filterUrl.updateDateRange(
      start,
      end,
      this.state.selectedTradeTypes(),
      undefined,
      undefined,
      'custom'
    );
  }
}

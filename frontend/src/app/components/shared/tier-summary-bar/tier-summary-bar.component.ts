import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { formatCurrency, pnlClass } from '../../../utils/format.utils';

export interface TierSummaryBarData {
  realisedPnL: number;
  allocatedCharges: number;
  netPnL: number;
  stockCount: number;
  tradeCount: number;
  winRate?: number | null;
  pnlLabel?: string;
  countLabel?: string;
  volumeLabel?: string;
  showCharges?: boolean;
  chargesLink?: boolean;
}

@Component({
  selector: 'app-tier-summary-bar',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './tier-summary-bar.component.html',
})
export class TierSummaryBarComponent {
  label = input.required<string>();
  summary = input.required<TierSummaryBarData>();

  readonly formatCurrency = formatCurrency;
  readonly pnlClass = pnlClass;
}

import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RegistryStock } from '../../../models/trading-journal.models';
import { MarketQuoteService } from '../../../services/market-quote.service';
import { RegistryStockService } from '../../../services/registry-stock.service';
import { ToastService } from '../../../services/toast.service';
import { formatDataAge } from '../../../utils/data-age.utils';

export interface CmpRefreshStock {
  symbol: string;
  name?: string;
  isin?: string;
  updatedAt?: number;
}

interface CmpCandidate extends CmpRefreshStock {
  ageMs: number | null;
  ageLabel: string;
}

const STALE_MS = 30 * 60 * 1000;
const WINDOWS = [
  { id: '30m', label: '30 min', ms: 30 * 60 * 1000 },
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '4h', label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { id: '1d', label: '1 day', ms: 24 * 60 * 60 * 1000 },
] as const;

@Component({
  selector: 'app-cmp-refresh-button',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './cmp-refresh-button.component.html',
  host: { class: 'relative inline-flex' },
})
export class CmpRefreshButtonComponent {
  private quotes = inject(MarketQuoteService);
  private registrySvc = inject(RegistryStockService);
  private toast = inject(ToastService);

  stocks = input<CmpRefreshStock[]>([]);
  label = input('Refresh');
  buttonClass = input('btn-secondary !py-1.5 !text-xs');

  refreshed = output<RegistryStock[]>();

  readonly windows = WINDOWS;
  open = signal(false);
  busy = signal(false);
  preset = signal('30m');
  selection = signal<string[]>([]);

  candidates = computed((): CmpCandidate[] => {
    const now = Date.now();
    const seen = new Set<string>();
    const rows: CmpCandidate[] = [];
    for (const stock of this.stocks()) {
      const symbol = stock.symbol.trim().toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const at = stock.updatedAt && stock.updatedAt > 0 ? stock.updatedAt : null;
      rows.push({
        symbol,
        name: stock.name || symbol,
        isin: stock.isin,
        updatedAt: stock.updatedAt,
        ageMs: at != null ? Math.max(0, now - at) : null,
        ageLabel: formatDataAge(at),
      });
    }
    return rows.sort((a, b) => (b.ageMs ?? Number.POSITIVE_INFINITY) - (a.ageMs ?? Number.POSITIVE_INFINITY));
  });

  toggleOpen(): void {
    if (this.busy() || !this.candidates().length) return;
    if (this.open()) {
      this.open.set(false);
      return;
    }
    this.selectOlderThan(STALE_MS, '30m');
    this.open.set(true);
  }

  selectAll(): void {
    this.preset.set('all');
    this.selection.set(this.candidates().map((row) => row.symbol));
  }

  selectNone(): void {
    this.preset.set('none');
    this.selection.set([]);
  }

  selectOlderThan(ms: number, preset: string): void {
    this.preset.set(preset);
    this.selection.set(
      this.candidates()
        .filter((row) => row.ageMs == null || row.ageMs >= ms)
        .map((row) => row.symbol)
    );
  }

  isSelected(symbol: string): boolean {
    return this.selection().includes(symbol);
  }

  toggleSymbol(symbol: string): void {
    this.preset.set('custom');
    this.selection.update((current) =>
      current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol]
    );
  }

  async confirm(): Promise<void> {
    const symbols = this.selection();
    if (!symbols.length || this.busy()) return;
    this.open.set(false);
    this.busy.set(true);
    const failed: string[] = [];
    const updated: RegistryStock[] = [];
    try {
      for (const symbol of symbols) {
        const candidate = this.candidates().find((row) => row.symbol === symbol);
        try {
          const registry = await this.registrySvc.ensureListed(symbol, {
            name: candidate?.name,
            isin: candidate?.isin,
          });
          const quote = await this.quotes.quote(symbol, {
            isin: candidate?.isin || registry.isin,
            name: candidate?.name || registry.name,
          });
          const next: RegistryStock = {
            ...registry,
            currentPrice: quote.price,
            updatedAt: quote.fetchedAt || Date.now(),
          };
          await this.registrySvc.save(next);
          updated.push(next);
        } catch {
          failed.push(symbol);
        }
      }
      this.registrySvc.reload();
      this.refreshed.emit(updated);
      const failNote = failed.length
        ? ` ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}.`
        : '';
      const message = `Refreshed CMP for ${updated.length} stock${updated.length === 1 ? '' : 's'}.${failNote}`;
      if (failed.length) this.toast.error(message);
      else this.toast.success(message);
    } finally {
      this.busy.set(false);
    }
  }
}

import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { PageShellService } from './page-shell.service';
import { ReportStateService } from './report-state.service';

export interface ViewContext {
  page: string;
  title: string;
  route: string;
  capturedAt: number;
  data: Record<string, unknown>;
}

const MAX_CONTEXT_CHARS = 24_000;

@Injectable({ providedIn: 'root' })
export class ViewContextService {
  private router = inject(Router);
  private pageShell = inject(PageShellService);
  private state = inject(ReportStateService);

  private readonly published = signal<ViewContext | null>(null);
  /** User-edited JSON overlay; null means use the live published context. */
  readonly editedJson = signal<string | null>(null);
  private lastPath = '';

  readonly live = computed(() => this.published() ?? this.fallbackContext());

  readonly displayJson = computed(() => {
    const edited = this.editedJson();
    if (edited != null) return edited;
    return this.stringify(this.live());
  });

  readonly usingEdited = computed(() => this.editedJson() != null);
  /** Free-text notes the user adds on top of the page snapshot. */
  readonly extraNotes = signal('');

  publish(partial: Partial<ViewContext> & { data: Record<string, unknown> }): void {
    this.published.set({
      page: partial.page || this.pageShell.title() || 'Kairo',
      title: partial.title || this.pageShell.title() || 'Current view',
      route: partial.route || this.router.url,
      capturedAt: Date.now(),
      data: this.shrink(partial.data),
    });
  }

  /** Default snapshot from the shell + report — used until a page publishes richer data. */
  captureRoute(): void {
    const path = this.router.url.split('?')[0];
    if (path === this.lastPath && this.published()) return;
    this.lastPath = path;
    this.editedJson.set(null);
    this.extraNotes.set('');
    const analysis = this.state.analysis();
    const report = this.state.report();
    this.publish({
      page: this.pageShell.title() || 'Kairo',
      title: [this.pageShell.title(), this.pageShell.subtitle()].filter(Boolean).join(' — '),
      route: this.router.url,
      data: {
        filters: {
          startDate: this.state.startDate(),
          endDate: this.state.endDate(),
          tradeTypes: this.state.selectedTradeTypes(),
          chartPeriod: this.state.chartPeriod(),
        },
        summary: analysis?.summary ?? report?.summary ?? null,
        stockCount: analysis?.stocks?.length ?? report?.stockSummary?.length ?? 0,
        topStocks: (analysis?.stocks ?? report?.stockSummary ?? [])
          .slice()
          .sort((a, b) => Math.abs(b.netPnL) - Math.abs(a.netPnL))
          .slice(0, 40)
          .map((stock) => ({
            symbol: stock.symbol || stock.stockName,
            name: stock.stockName,
            netPnL: stock.netPnL,
            trades: stock.tradeCount,
            winRate: stock.winRate,
          })),
      },
    });
  }

  applyEditedJson(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) {
      this.editedJson.set(null);
      return;
    }
    JSON.parse(trimmed);
    this.editedJson.set(trimmed);
  }

  resetEdited(): void {
    this.editedJson.set(null);
    this.extraNotes.set('');
  }

  /** Payload the model actually sees. */
  forModel(): string {
    const json = this.displayJson();
    const notes = this.extraNotes().trim();
    if (!notes) return json;
    return `USER NOTES:\n${notes}\n\nVIEW CONTEXT JSON:\n${json}`;
  }

  private fallbackContext(): ViewContext {
    return {
      page: this.pageShell.title() || 'Kairo',
      title: this.pageShell.title() || 'Current view',
      route: this.router.url,
      capturedAt: Date.now(),
      data: {},
    };
  }

  private shrink(data: Record<string, unknown>): Record<string, unknown> {
    let json = this.stringify({ page: '', title: '', route: '', capturedAt: 0, data });
    if (json.length <= MAX_CONTEXT_CHARS) return data;
    return { ...data, truncated: true, note: 'Context trimmed for the model' };
  }

  private stringify(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }
}

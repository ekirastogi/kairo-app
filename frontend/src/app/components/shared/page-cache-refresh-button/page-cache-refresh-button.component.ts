import { Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ANALYTICS_PAGE_ID, UiPageCacheService } from '../../../services/ui-page-cache.service';
import { ToastService } from '../../../services/toast.service';

/**
 * Reusable control for the top of a page: clears that page’s UI cache and
 * reloads underlying data so every tab is powered by fresh calls.
 */
@Component({
  selector: 'app-page-cache-refresh-button',
  standalone: true,
  imports: [CommonModule],
  template: `
    <button
      type="button"
      class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-wait disabled:opacity-60"
      [disabled]="busy()"
      [attr.aria-busy]="busy()"
      [attr.aria-label]="busy() ? 'Refreshing data' : 'Refresh data'"
      [title]="busy() ? 'Refreshing…' : 'Refresh data'"
      (click)="refresh()"
    >
      <svg
        class="h-5 w-5 shrink-0"
        [class.animate-spin]="busy()"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
    </button>
  `,
})
export class PageCacheRefreshButtonComponent {
  private cache = inject(UiPageCacheService);
  private toast = inject(ToastService);

  /** Page cache namespace — defaults to the home Performance page. */
  pageId = input<string>(ANALYTICS_PAGE_ID);

  readonly busy = computed(() => this.cache.refreshing() === this.pageId());

  async refresh(): Promise<void> {
    const id = this.pageId();
    if (this.cache.refreshing()) return;
    try {
      await this.cache.refreshPage(id);
      this.toast.success('Page cache cleared — data reloaded');
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Could not refresh page data');
    }
  }
}

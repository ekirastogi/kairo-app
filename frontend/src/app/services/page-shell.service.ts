import { Injectable, computed, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class PageShellService {
  private readonly routeTitle = signal('');
  private readonly routeSubtitle = signal<string | null>(null);
  private readonly overrideTitle = signal<string | null>(null);
  private readonly overrideSubtitle = signal<string | null>(null);
  /** When set, the top bar shows the reusable page-cache refresh control. */
  readonly cachePageId = signal<string | null>(null);

  readonly title = computed(() => this.overrideTitle() ?? this.routeTitle());
  readonly subtitle = computed(() => this.overrideSubtitle() ?? this.routeSubtitle());

  setCachePage(pageId: string | null): void {
    this.cachePageId.set(pageId);
  }

  setRouteHeader(title: string, subtitle?: string | null): void {
    this.routeTitle.set(title);
    this.routeSubtitle.set(subtitle ?? null);
    this.clearOverride();
  }

  setHeader(title: string, subtitle?: string | null): void {
    this.overrideTitle.set(title);
    this.overrideSubtitle.set(subtitle ?? null);
  }

  clearOverride(): void {
    this.overrideTitle.set(null);
    this.overrideSubtitle.set(null);
  }
}

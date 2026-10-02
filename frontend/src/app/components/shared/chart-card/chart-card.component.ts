import {
  Component,
  ElementRef,
  input,
  output,
  viewChild,
  AfterViewInit,
  OnDestroy,
  effect,
  HostListener,
  computed,
} from '@angular/core';
import { ActiveElement, Chart, ChartConfiguration, ChartEvent, registerables } from 'chart.js';
import { rangeAnchorPlugin } from '../../../utils/chart-range.utils';
import { stockCountBarLabelPlugin } from '../../../utils/chart-theme';

Chart.register(...registerables, stockCountBarLabelPlugin, rangeAnchorPlugin);

@Component({
  selector: 'app-chart-card',
  standalone: true,
  host: { class: 'block min-w-0 max-w-full' },
  template: `
    <div
      class="flex w-full min-w-0 max-w-full flex-col overflow-hidden"
      [class.rounded-xl]="!compact()"
      [class.border]="!compact()"
      [class.border-slate-200]="!compact()"
      [class.bg-white]="!compact()"
      [class.shadow-sm]="!compact()"
      [class.h-full]="!compact() && heightPx() == null"
      [style.height.px]="compact() ? null : heightPx()"
    >
      @if (title()) {
        <div class="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5 sm:py-3.5">
          <div class="min-w-0">
            <h3 class="truncate text-sm font-semibold tracking-tight text-slate-900">{{ title() }}</h3>
            @if (subtitle()) {
              <p class="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-500">{{ subtitle() }}</p>
            }
          </div>
          <ng-content select="[chartHeader]" />
        </div>
      }

      <div
        class="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        [class.px-1]="compact()"
        [class.px-3]="!compact()"
        [class.py-3]="!compact()"
        [class.sm:px-4]="!compact()"
        [class.sm:py-4]="!compact()"
        [style.height.px]="compact() ? compactHeight() : null"
        [style.max-height.px]="compact() ? compactHeight() : null"
      >
        @if (config()) {
          <canvas #canvas class="block h-full w-full" [class.cursor-crosshair]="interactive()"></canvas>
        } @else {
          <div class="flex h-full flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 text-center">
            <svg class="mb-2 h-8 w-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
            </svg>
            <p class="text-sm text-slate-500">{{ emptyMessage() }}</p>
          </div>
        }
      </div>
    </div>
  `,
})
export class ChartCardComponent implements AfterViewInit, OnDestroy {
  config = input.required<ChartConfiguration<any, any, any> | null>();
  title = input('');
  subtitle = input('');
  emptyMessage = input('No data for current filters');
  size = input<'xs' | 'sm' | 'md' | 'lg'>('md');
  compact = input(false);
  heightPx = input<number | null>(null);
  interactive = input(false);
  pointClick = output<number>();

  compactHeight = computed(() => {
    const mobile = typeof window !== 'undefined' && window.innerWidth < 640;
    return mobile ? 44 : 48;
  });

  canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  private chart: Chart | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private ready = false;

  constructor() {
    effect(() => {
      const cfg = this.config();
      if (!this.ready) return;
      if (cfg) this.render(cfg);
      else this.destroyChart();
    });
  }

  @HostListener('window:resize')
  onResize(): void {
    this.chart?.resize();
  }

  ngAfterViewInit(): void {
    this.ready = true;
    const el = this.canvasRef()?.nativeElement?.parentElement;
    if (el) {
      this.resizeObserver = new ResizeObserver(() => this.chart?.resize());
      this.resizeObserver.observe(el);
    }
    const cfg = this.config();
    if (cfg) this.render(cfg);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.destroyChart();
  }

  resolveHeight(): number {
    if (this.heightPx() != null) return this.heightPx()!;
    const mobile = typeof window !== 'undefined' && window.innerWidth < 640;
    switch (this.size()) {
      case 'xs': return mobile ? 120 : 140;
      case 'sm': return mobile ? 220 : 260;
      case 'lg': return mobile ? 280 : 360;
      default: return mobile ? 240 : 300;
    }
  }

  private destroyChart(): void {
    this.chart?.destroy();
    this.chart = null;
  }

  private render(config: ChartConfiguration<any, any, any>): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    const options = {
      ...config.options,
      responsive: true,
      maintainAspectRatio: false,
      onClick: (event: ChartEvent, elements: ActiveElement[], chart: Chart) => {
        config.options?.onClick?.(event, elements, chart);
        this.emitPointClick(event, chart);
      },
    };
    const nextType = config.type;
    const currentType = (this.chart?.config as ChartConfiguration | undefined)?.type;
    const canReuse =
      this.chart != null &&
      currentType === nextType &&
      !config.plugins?.length;
    if (canReuse && this.chart) {
      this.chart.data = config.data;
      this.chart.options = options;
      this.chart.update('none');
      return;
    }
    this.destroyChart();
    this.chart = new Chart(canvas, {
      ...config,
      options,
    });
  }

  private emitPointClick(event: ChartEvent, chart: Chart): void {
    if (!this.interactive()) return;
    const native = event.native;
    if (!native) return;
    const points = chart.getElementsAtEventForMode(native, 'index', { intersect: false }, true);
    const index = points[0]?.index;
    if (index == null) return;
    this.pointClick.emit(index);
  }
}

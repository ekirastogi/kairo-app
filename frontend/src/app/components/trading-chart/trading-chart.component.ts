import { Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  createChart,
  IChartApi,
  CandlestickData,
  LineData,
  Time,
  CandlestickSeries,
  LineSeries,
} from 'lightweight-charts';
import { Candle, ChartView } from '../../models/market.models';
import { UserLevel } from '../../services/stock-levels.service';

@Component({
  selector: 'app-trading-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="min-w-0 max-w-full space-y-2 overflow-hidden">
      <div #chartContainer class="h-64 w-full max-w-full overflow-hidden rounded-lg border border-slate-200 bg-white sm:h-80"></div>
      @if (showMacd || showRsi) {
        <div #macdContainer class="h-24 w-full max-w-full overflow-hidden rounded-lg border border-slate-200 bg-white"></div>
      }
    </div>
  `,
})
export class TradingChartComponent implements OnChanges, OnDestroy {
  @ViewChild('chartContainer', { static: true }) container!: ElementRef<HTMLDivElement>;
  @ViewChild('macdContainer') macdContainer?: ElementRef<HTMLDivElement>;

  @Input() candles: Candle[] = [];
  @Input() chartView?: ChartView;
  @Input() supportLevels: number[] = [];
  @Input() resistanceLevels: number[] = [];
  @Input() userSupports: UserLevel[] = [];
  @Input() userResistances: UserLevel[] = [];
  @Input() showSma = true;
  @Input() showMacd = false;
  @Input() showRsi = false;

  private chart?: IChartApi;
  private macdChart?: IChartApi;
  private candleSeries?: ReturnType<IChartApi['addSeries']>;
  private priceLines: ReturnType<NonNullable<typeof this.candleSeries>['createPriceLine']>[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['candles'] || changes['chartView'] || changes['supportLevels'] || changes['resistanceLevels']) {
      this.render();
    }
  }

  ngOnDestroy(): void {
    this.chart?.remove();
    this.macdChart?.remove();
  }

  private effectiveCandles(): Candle[] {
    if (this.chartView?.candles?.length) return this.chartView.candles;
    return this.candles;
  }

  private render(): void {
    const candles = this.effectiveCandles();
    if (!candles.length || !this.container?.nativeElement) return;

    if (!this.chart) {
      this.chart = createChart(this.container.nativeElement, {
        autoSize: true,
        layout: { background: { color: '#ffffff' }, textColor: '#334155' },
        grid: { vertLines: { color: '#f1f5f9' }, horzLines: { color: '#f1f5f9' } },
        rightPriceScale: { borderColor: '#e2e8f0' },
        timeScale: { borderColor: '#e2e8f0' },
      });
      this.candleSeries = this.chart.addSeries(CandlestickSeries, {
        upColor: '#10b981', downColor: '#ef4444', borderVisible: false,
        wickUpColor: '#10b981', wickDownColor: '#ef4444',
      });
    }

    const data: CandlestickData[] = candles.map((c) => ({
      time: c.time as Time,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    this.candleSeries!.setData(data);

    if (this.showSma && this.chartView) {
      this.addLineSeries(this.chartView.sma20, '#3b82f6', candles);
      this.addLineSeries(this.chartView.sma50, '#f59e0b', candles);
      this.addLineSeries(this.chartView.sma200, '#8b5cf6', candles);
    }

    this.drawPriceLines();
    this.chart.timeScale().fitContent();
  }

  private addLineSeries(values: number[] | undefined, color: string, candles: Candle[]) {
    if (!values?.length || !this.chart) return;
    const series = this.chart.addSeries(LineSeries, { color, lineWidth: 1 });
    const lineData: LineData[] = [];
    for (let i = 0; i < candles.length && i < values.length; i++) {
      if (values[i] > 0) {
        lineData.push({ time: candles[i].time as Time, value: values[i] });
      }
    }
    series.setData(lineData);
  }

  private drawPriceLines(): void {
    if (!this.candleSeries) return;
    const addLine = (price: number, color: string, title: string) => {
      if (price > 0) {
        this.candleSeries!.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
      }
    };
    this.supportLevels.slice(0, 3).forEach((p, i) => addLine(p, '#10b981', `S${i + 1}`));
    this.resistanceLevels.slice(0, 3).forEach((p, i) => addLine(p, '#ef4444', `R${i + 1}`));
    this.userSupports.forEach((l) => addLine(l.price, '#059669', l.label || 'US'));
    this.userResistances.forEach((l) => addLine(l.price, '#dc2626', l.label || 'UR'));
  }
}

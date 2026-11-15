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

export interface ChartPriceLevel {
  price: number;
  label: string;
  color: string;
}

@Component({
  selector: 'app-trading-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="min-w-0 max-w-full space-y-2 overflow-hidden">
      <div #chartContainer class="h-[22rem] w-full max-w-full overflow-hidden rounded-lg border border-slate-200 bg-white sm:h-[28rem]"></div>
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
  @Input() extraLevels: ChartPriceLevel[] = [];
  @Input() cmp: number | null = null;
  @Input() showSma = true;
  @Input() showMacd = false;
  @Input() showRsi = false;

  private chart?: IChartApi;
  private macdChart?: IChartApi;
  private candleSeries?: ReturnType<IChartApi['addSeries']>;
  private overlaySeries: ReturnType<IChartApi['addSeries']>[] = [];
  private priceLines: ReturnType<NonNullable<typeof this.candleSeries>['createPriceLine']>[] = [];

  ngOnChanges(_changes: SimpleChanges): void {
    this.render();
  }

  ngOnDestroy(): void {
    this.chart?.remove();
    this.macdChart?.remove();
  }

  private effectiveCandles(): Candle[] {
    if (this.candles?.length) return this.candles;
    if (this.chartView?.candles?.length) return this.chartView.candles;
    return [];
  }

  private render(): void {
    const candles = this.effectiveCandles();
    if (!candles.length || !this.container?.nativeElement) return;

    if (!this.chart) {
      this.chart = createChart(this.container.nativeElement, {
        autoSize: true,
        layout: { background: { color: '#0b1220' }, textColor: '#cbd5e1' },
        grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
        rightPriceScale: { borderColor: '#334155' },
        timeScale: { borderColor: '#334155', timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
      });
      this.candleSeries = this.chart.addSeries(CandlestickSeries, {
        upColor: '#10b981',
        downColor: '#ef4444',
        borderVisible: false,
        wickUpColor: '#34d399',
        wickDownColor: '#f87171',
      });
    }

    const data: CandlestickData[] = candles.map((c) => ({
      time: (Number(c.time) ? Number(c.time) : c.time) as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    this.candleSeries!.setData(data);

    for (const series of this.overlaySeries) {
      try {
        this.chart.removeSeries(series);
      } catch {
        /* already gone */
      }
    }
    this.overlaySeries = [];

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
    this.overlaySeries.push(series);
    const lineData: LineData[] = [];
    for (let i = 0; i < candles.length && i < values.length; i++) {
      if (values[i] > 0) {
        const time = (Number(candles[i].time) ? Number(candles[i].time) : candles[i].time) as Time;
        lineData.push({ time, value: values[i] });
      }
    }
    series.setData(lineData);
  }

  private drawPriceLines(): void {
    if (!this.candleSeries) return;
    for (const line of this.priceLines) {
      try {
        this.candleSeries.removePriceLine(line);
      } catch {
        /* ignore */
      }
    }
    this.priceLines = [];
    const addLine = (price: number, color: string, title: string, solid = false) => {
      if (!(price > 0)) return;
      const line = this.candleSeries!.createPriceLine({
        price,
        color,
        lineWidth: solid ? 2 : 1,
        lineStyle: solid ? 0 : 2,
        axisLabelVisible: true,
        title,
      });
      this.priceLines.push(line);
    };
    this.supportLevels.slice(0, 3).forEach((p, i) => addLine(p, '#10b981', `S${i + 1}`));
    this.resistanceLevels.slice(0, 3).forEach((p, i) => addLine(p, '#ef4444', `R${i + 1}`));
    this.userSupports.forEach((l) => addLine(l.price, '#059669', l.label || 'US'));
    this.userResistances.forEach((l) => addLine(l.price, '#dc2626', l.label || 'UR'));
    this.extraLevels.forEach((l) => addLine(l.price, l.color, l.label));
    if (this.cmp && this.cmp > 0) addLine(this.cmp, '#f8fafc', 'CMP', true);
  }
}

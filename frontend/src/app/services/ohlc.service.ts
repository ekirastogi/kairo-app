import { Injectable, inject } from '@angular/core';
import { Candle } from '../models/market.models';
import { SupabaseService } from './supabase.service';

export type CandleInterval = '5minute' | '30minute' | '1hour' | '1day' | '1week';

export const CANDLE_INTERVALS: { id: CandleInterval; label: string }[] = [
  { id: '5minute', label: '5m' },
  { id: '30minute', label: '30m' },
  { id: '1hour', label: '1h' },
  { id: '1day', label: '1D' },
  { id: '1week', label: '1W' },
];

@Injectable({ providedIn: 'root' })
export class OhlcService {
  private supabase = inject(SupabaseService);

  async list(symbol: string, interval: CandleInterval, limit = 4000): Promise<Candle[]> {
    const { data, error } = await this.supabase.client
      .from('ohlc_candles')
      .select('ts, open, high, low, close, volume')
      .eq('symbol', symbol.trim().toUpperCase())
      .eq('interval', interval)
      .order('ts', { ascending: true })
      .limit(limit);
    if (error) throw error;
    const daily = interval === '1day' || interval === '1week';
    return (data ?? []).map((row) => {
      const ts = new Date(row.ts as string);
      const time = daily
        ? ts.toISOString().slice(0, 10)
        : String(Math.floor(ts.getTime() / 1000));
      return {
        time,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume ?? 0),
      };
    });
  }
}

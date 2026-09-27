import { Injectable, Signal, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, debounceTime, distinctUntilChanged, from, map, of, switchMap, tap } from 'rxjs';
import { RegistryStock } from '../models/trading-journal.models';
import { RegistryStockService } from './registry-stock.service';

export interface StockSearchOptions {
  minChars?: number;
  limit?: number;
  debounceMs?: number;
}

export interface StockSearchBinding {
  results: Signal<RegistryStock[]>;
  busy: Signal<boolean>;
}

export const STOCK_SEARCH_MIN_CHARS = 2;
export const STOCK_SEARCH_LIMIT = 25;

@Injectable({ providedIn: 'root' })
export class StockSearchService {
  private registry = inject(RegistryStockService);

  async search(raw: string, opts: StockSearchOptions = {}): Promise<RegistryStock[]> {
    const minChars = opts.minChars ?? STOCK_SEARCH_MIN_CHARS;
    const limit = opts.limit ?? STOCK_SEARCH_LIMIT;
    const query = raw.trim();
    if (query.length < minChars) return [];
    return this.registry.search(query, limit);
  }

  /** Debounced live search for a query signal. Call from a component injection context. */
  bindQuery(query: Signal<string>, opts: StockSearchOptions = {}): StockSearchBinding {
    const minChars = opts.minChars ?? STOCK_SEARCH_MIN_CHARS;
    const limit = opts.limit ?? STOCK_SEARCH_LIMIT;
    const busy = signal(false);
    const results = toSignal(
      toObservable(query).pipe(
        debounceTime(opts.debounceMs ?? 300),
        map((value) => value.trim()),
        distinctUntilChanged(),
        switchMap((value) => {
          if (value.length < minChars) {
            busy.set(false);
            return of([] as RegistryStock[]);
          }
          busy.set(true);
          return from(this.search(value, { minChars, limit })).pipe(
            tap(() => busy.set(false)),
            catchError(() => {
              busy.set(false);
              return of([] as RegistryStock[]);
            })
          );
        })
      ),
      { initialValue: [] as RegistryStock[] }
    );
    return { results, busy };
  }
}

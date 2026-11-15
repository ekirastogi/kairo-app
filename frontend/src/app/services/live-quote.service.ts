import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Firestore, collection, collectionData, doc, docData } from '@angular/fire/firestore';
import { map, of, switchMap } from 'rxjs';

export interface LiveQuote {
  symbol: string;
  name?: string;
  ltp: number;
  change?: number;
  changePct?: number;
  updatedAt?: unknown;
}

const STORAGE_KEY = 'kairo-live-tracker';

@Injectable({ providedIn: 'root' })
export class LiveQuoteService {
  private firestore = inject(Firestore);
  readonly enabled = signal(localStorage.getItem(STORAGE_KEY) === '1');

  readonly tracker = toSignal(
    docData(doc(this.firestore, 'worker/liveTracker')).pipe(
      map((row) => (row ?? null) as { running?: boolean; lastTick?: unknown; note?: string; count?: number } | null)
    ),
    { initialValue: null }
  );

  readonly quotes = toSignal(
    collectionData(collection(this.firestore, 'liveQuotes'), { idField: 'symbol' }).pipe(
      map((rows) => {
        const mapRows = new Map<string, LiveQuote>();
        for (const row of rows as LiveQuote[]) {
          const symbol = String(row.symbol || '').toUpperCase();
          if (!symbol || !(row.ltp > 0)) continue;
          mapRows.set(symbol, { ...row, symbol });
        }
        return mapRows;
      })
    ),
    { initialValue: new Map<string, LiveQuote>() }
  );

  readonly live = computed(() => this.enabled() && !!this.tracker()?.running);

  toggle(): void {
    const next = !this.enabled();
    this.enabled.set(next);
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  }

  quote(symbol: string): LiveQuote | undefined {
    return this.quotes().get(symbol.trim().toUpperCase());
  }

  watchSymbol(symbol: string) {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return of(undefined);
    return docData(doc(this.firestore, `liveQuotes/${sym}`)).pipe(
      map((row) => (row ? ({ ...(row as LiveQuote), symbol: sym } as LiveQuote) : undefined)),
      switchMap((row) => of(row))
    );
  }
}

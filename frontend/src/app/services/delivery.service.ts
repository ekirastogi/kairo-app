import { Injectable, inject } from '@angular/core';
import { Observable, of, switchMap } from 'rxjs';
import { AuthService } from './auth.service';
import { objectToSnake, rowToCamel, SupabaseService } from './supabase.service';
import { readJson } from '../utils/local-store.utils';

const LOCAL_STORE_KEY = 'kairo-delivery-buys-v1';

export interface DeliveryFill {
  id: string;
  quantity: number;
  boughtOn: string;
  createdAt: number;
}

export interface DeliveryPlan {
  id: string;
  symbol: string;
  name: string;
  isin?: string;
  quantity: number;
  targetPrice: number;
  boughtQty: number;
  fills: DeliveryFill[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export const DELIVERY_SEED: ReadonlyArray<{
  symbol: string;
  name: string;
  quantity: number;
  targetPrice: number;
}> = [
  { symbol: 'SOTL', name: 'Savita Oil Technologies Ltd', quantity: 5000, targetPrice: 720 },
  { symbol: 'JUSTDIAL', name: 'JUSTDIAL LTD.', quantity: 5000, targetPrice: 700 },
  { symbol: 'KPITTECH', name: 'KPIT Technologies Limited', quantity: 5000, targetPrice: 530 },
  { symbol: 'WAAREERTL', name: 'Waaree Renewable Technologies Ltd', quantity: 1000, targetPrice: 650 },
  { symbol: 'PAYTM', name: 'One 97 Communications Limited', quantity: 200, targetPrice: 1600 },
  { symbol: 'ETERNAL', name: 'Eternal Ltd', quantity: 5000, targetPrice: 300 },
  { symbol: 'POLYCAB', name: 'Polycab India Limited', quantity: 100, targetPrice: 7750 },
  { symbol: 'KEI', name: 'KEI INDUSTRIES LTD.', quantity: 100, targetPrice: 3500 },
  { symbol: 'HAL', name: 'Hindustan Aeronautics Ltd', quantity: 100, targetPrice: 4600 },
  { symbol: 'MAZDOCK', name: 'Mazagon Dock Shipbuilders Limited', quantity: 100, targetPrice: 1800 },
  { symbol: 'IKIOTECHNOLOGIES', name: 'IKIO TECHNOLOGIES LIMITED', quantity: 1001, targetPrice: 146 },
  { symbol: 'GROWW', name: 'BILLIONBRAINS GARAGE VN L', quantity: 2000, targetPrice: 180 },
  { symbol: 'TARIL', name: 'Transformers & Rectifiers India Ltd', quantity: 2000, targetPrice: 300 },
  { symbol: 'EMIL', name: 'Electronics Mart India Limited', quantity: 3000, targetPrice: 140 },
];

function fillTotal(fills: DeliveryFill[]): number {
  return fills.reduce((sum, fill) => sum + (fill.quantity > 0 ? fill.quantity : 0), 0);
}

function isoFromMs(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function normalizeFill(fill: Partial<DeliveryFill> & { quantity: number; createdAt: number }): DeliveryFill {
  return {
    id: fill.id || crypto.randomUUID(),
    quantity: fill.quantity,
    boughtOn: fill.boughtOn || isoFromMs(fill.createdAt),
    createdAt: fill.createdAt,
  };
}

@Injectable({ providedIn: 'root' })
export class DeliveryService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private seededFor = new Set<string>();

  watchAll(): Observable<DeliveryPlan[]> {
    return this.auth.user$.pipe(
      switchMap((user) => {
        if (!user) return of([]);
        return this.supabase.watchTable('delivery_plans', () => this.listAll(), undefined, 'delivery_plans');
      })
    );
  }

  async listAll(): Promise<DeliveryPlan[]> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];
    await this.ensureDefaults(uid);
    return this.fetchAll(uid);
  }

  async create(input: {
    symbol: string;
    name: string;
    isin?: string;
    quantity: number;
    targetPrice: number;
  }): Promise<string> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to save delivery buys');
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) throw new Error('Symbol is required');
    const existing = await this.fetchAll(uid);
    const sortOrder = existing.reduce((min, row) => Math.min(min, row.sortOrder), 0) - 1;
    const now = Date.now();
    const id = crypto.randomUUID();
    const { error } = await this.supabase.client.from('delivery_plans').insert(
      objectToSnake({
        id,
        userId: uid,
        symbol,
        name: input.name.trim() || symbol,
        isin: input.isin ?? null,
        quantity: input.quantity,
        targetPrice: input.targetPrice,
        boughtQty: 0,
        fills: [],
        sortOrder,
        createdAt: now,
        updatedAt: now,
      })
    );
    if (error) {
      if (error.code === '23505') throw new Error(`${symbol} is already on the delivery list`);
      throw error;
    }
    return id;
  }

  async update(
    id: string,
    patch: Partial<Pick<DeliveryPlan, 'quantity' | 'targetPrice' | 'fills' | 'name' | 'isin'>>
  ): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to update delivery buys');
    const fills = patch.fills?.map((fill) => normalizeFill(fill));
    const body: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.quantity != null) body['quantity'] = patch.quantity;
    if (patch.targetPrice != null) body['targetPrice'] = patch.targetPrice;
    if (patch.name != null) body['name'] = patch.name;
    if (patch.isin !== undefined) body['isin'] = patch.isin;
    if (fills) {
      body['fills'] = fills;
      body['boughtQty'] = fillTotal(fills);
    }
    const { error } = await this.supabase.client
      .from('delivery_plans')
      .update(objectToSnake(body))
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
  }

  async remove(id: string): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to remove delivery buys');
    const { error } = await this.supabase.client
      .from('delivery_plans')
      .delete()
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
  }

  private async fetchAll(uid: string): Promise<DeliveryPlan[]> {
    const { data, error } = await this.supabase.client
      .from('delivery_plans')
      .select('*')
      .eq('user_id', uid)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => rowToPlan(row));
  }

  private async ensureDefaults(uid: string): Promise<void> {
    if (this.seededFor.has(uid)) return;
    const existing = await this.fetchAll(uid);
    const have = new Set(existing.map((row) => row.symbol.toUpperCase()));
    const local = readLocalPlans();
    const toInsert: Array<Record<string, unknown>> = [];
    const now = Date.now();

    for (const row of local) {
      const symbol = row.symbol.trim().toUpperCase();
      if (!symbol || have.has(symbol)) continue;
      have.add(symbol);
      toInsert.push(
        objectToSnake({
          id: row.id || crypto.randomUUID(),
          userId: uid,
          symbol,
          name: row.name || symbol,
          isin: row.isin ?? null,
          quantity: row.quantity,
          targetPrice: row.targetPrice,
          fills: row.fills,
          boughtQty: fillTotal(row.fills),
          sortOrder: 100 + toInsert.length,
          createdAt: row.createdAt || now,
          updatedAt: now,
        })
      );
    }

    DELIVERY_SEED.forEach((seed, index) => {
      if (have.has(seed.symbol)) return;
      have.add(seed.symbol);
      toInsert.push(
        objectToSnake({
          id: crypto.randomUUID(),
          userId: uid,
          symbol: seed.symbol,
          name: seed.name,
          quantity: seed.quantity,
          targetPrice: seed.targetPrice,
          fills: [],
          boughtQty: 0,
          sortOrder: index + 1,
          createdAt: now + index,
          updatedAt: now,
        })
      );
    });

    if (toInsert.length) {
      const { error } = await this.supabase.client.from('delivery_plans').insert(toInsert);
      if (error && error.code !== '23505') throw error;
    }

    if (local.length && typeof localStorage !== 'undefined') {
      localStorage.removeItem(LOCAL_STORE_KEY);
    }
    this.seededFor.add(uid);
  }
}

function rowToPlan(row: Record<string, unknown>): DeliveryPlan {
  const camel = rowToCamel<Record<string, unknown>>(row);
  const rawFills = Array.isArray(camel['fills']) ? (camel['fills'] as Array<Partial<DeliveryFill>>) : [];
  const fills = rawFills
    .filter((fill) => fill && Number(fill.quantity) > 0)
    .map((fill) =>
      normalizeFill({
        id: fill.id,
        quantity: Number(fill.quantity),
        boughtOn: fill.boughtOn,
        createdAt: Number(fill.createdAt ?? 0),
      })
    );
  return {
    id: String(camel['id'] ?? ''),
    symbol: String(camel['symbol'] ?? ''),
    name: String(camel['name'] ?? camel['symbol'] ?? ''),
    isin: (camel['isin'] as string | undefined) || undefined,
    quantity: Number(camel['quantity'] ?? 0),
    targetPrice: Number(camel['targetPrice'] ?? 0),
    fills,
    boughtQty: fillTotal(fills),
    sortOrder: Number(camel['sortOrder'] ?? 0),
    createdAt: Number(camel['createdAt'] ?? 0),
    updatedAt: Number(camel['updatedAt'] ?? 0),
  };
}

function readLocalPlans(): DeliveryPlan[] {
  const rows = readJson<Array<Partial<DeliveryPlan>> | null>(LOCAL_STORE_KEY, null);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && row.symbol && Number(row.quantity) > 0)
    .map((row) => {
      const rawFills = Array.isArray(row.fills)
        ? row.fills
        : row.boughtQty && row.boughtQty > 0
          ? [
              {
                id: crypto.randomUUID(),
                quantity: row.boughtQty,
                createdAt: row.createdAt ?? Date.now(),
                boughtOn: isoFromMs(row.createdAt ?? Date.now()),
              },
            ]
          : [];
      const fills = rawFills.map((fill) => normalizeFill(fill));
      return {
        id: row.id || crypto.randomUUID(),
        symbol: String(row.symbol),
        name: String(row.name || row.symbol),
        isin: row.isin,
        quantity: Number(row.quantity),
        targetPrice: Number(row.targetPrice),
        fills,
        boughtQty: fillTotal(fills),
        sortOrder: Number(row.sortOrder ?? 0),
        createdAt: Number(row.createdAt ?? Date.now()),
        updatedAt: Number(row.updatedAt ?? row.createdAt ?? Date.now()),
      } satisfies DeliveryPlan;
    });
}

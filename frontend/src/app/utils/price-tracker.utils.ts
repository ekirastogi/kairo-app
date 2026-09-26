import { TradeDirection, TradeSegment } from '../models/trading-journal.models';

export type TrackerProximity = 'hot' | 'near' | null;

export interface TrackerTarget {
  price: number;
  quantity?: number;
}

export interface TrackerPlanSnapshot {
  action: string;
  targetPrice: number;
  nextTargets: number[];
  quantity?: number;
  segment?: TradeSegment;
  entryPrice?: number;
  stopLoss?: number;
  targets?: TrackerTarget[];
}

/** Signed % distance of target from CMP: (target - cmp) / cmp * 100. */
export function trackerDiffPct(cmp: number | undefined | null, target: number): number | null {
  if (cmp == null || cmp <= 0 || !Number.isFinite(target)) return null;
  return ((target - cmp) / cmp) * 100;
}

export function trackerAbsDiffPct(cmp: number | undefined | null, target: number): number | null {
  const diff = trackerDiffPct(cmp, target);
  return diff == null ? null : Math.abs(diff);
}

/** Green ≤ 5% of CMP, yellow ≤ 10%. */
export function trackerProximity(cmp: number | undefined | null, target: number): TrackerProximity {
  const abs = trackerAbsDiffPct(cmp, target);
  if (abs == null) return null;
  if (abs <= 5) return 'hot';
  if (abs <= 10) return 'near';
  return null;
}

export function parsePositivePrices(values: Array<string | number>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of values) {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    const rounded = Math.round(n * 100) / 100;
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    out.push(rounded);
  }
  return out.sort((a, b) => a - b);
}

export function parseTrackerTargets(raw: unknown): TrackerTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackerTarget[] = [];
  for (const item of raw) {
    if (typeof item === 'number' || typeof item === 'string') {
      const price = typeof item === 'number' ? item : parseFloat(String(item).replace(/,/g, ''));
      if (Number.isFinite(price) && price > 0) {
        out.push({ price: Math.round(price * 100) / 100 });
      }
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const price = Number(rec['price']);
    const quantity = Number(rec['quantity']);
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({
      price: Math.round(price * 100) / 100,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
    });
  }
  return out;
}

export function trackerIsSell(action: string): boolean {
  const value = action.trim().toLowerCase();
  return value === 'sell' || value === 'short';
}

export function trackerDirection(action: string): TradeDirection {
  return trackerIsSell(action) ? 'short' : 'long';
}

export function trackerEntryPrice(plan: TrackerPlanSnapshot): number | null {
  if (plan.entryPrice != null && plan.entryPrice > 0) return plan.entryPrice;
  if (plan.targetPrice > 0) return plan.targetPrice;
  return null;
}

/** Planned exits only — next levels are add-on prices, not exits. */
export function trackerExitLevels(plan: TrackerPlanSnapshot): TrackerTarget[] {
  return (plan.targets ?? []).filter((t) => t.price > 0);
}

export function trackerIsSized(plan: TrackerPlanSnapshot): boolean {
  return (plan.quantity ?? 0) > 0 && trackerExitLevels(plan).length > 0 && (trackerEntryPrice(plan) ?? 0) > 0;
}

/** Split total qty across exits; keep any per-exit qty the user typed. */
export function allocateTrackerSlices(
  plan: TrackerPlanSnapshot
): Array<{ price: number; quantity: number }> {
  const qty = plan.quantity ?? 0;
  const exits = trackerExitLevels(plan);
  if (!(qty > 0) || !exits.length) return [];
  const allSpecified = exits.every((exit) => (exit.quantity ?? 0) > 0);
  if (allSpecified) {
    return exits.map((exit) => ({ price: exit.price, quantity: exit.quantity as number }));
  }
  const n = exits.length;
  const base = qty / n;
  return exits.map((exit) => ({
    price: exit.price,
    quantity: (exit.quantity ?? 0) > 0 ? (exit.quantity as number) : base,
  }));
}

export function trackerSegment(plan: Pick<TrackerPlanSnapshot, 'segment'>): TradeSegment {
  return plan.segment === 'delivery' ? 'delivery' : 'intraday';
}

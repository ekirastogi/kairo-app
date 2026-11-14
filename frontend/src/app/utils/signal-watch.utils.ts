export interface SignalBrokerTarget {
  broker: string;
  price: number;
}

export interface SignalLadderPoint {
  id: string;
  label: string;
  price: number;
  pctFromCmp: number | null;
  kind: 'level' | 'cmp';
  position: number;
}

/** Comma / space / semicolon price list, kept in typed order (P1, P2, …). */
export function parsePriceListText(raw: string | null | undefined): number[] {
  if (!raw?.trim()) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const part of raw.split(/[,;@\s]+/)) {
    const n = parseFloat(part.replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    const rounded = Math.round(n * 100) / 100;
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    out.push(rounded);
  }
  return out;
}

export function formatPriceListText(prices: number[]): string {
  return prices
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')))
    .join(', ');
}

export function parseBrokerTargets(raw: unknown): SignalBrokerTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: SignalBrokerTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const broker = String(rec['broker'] ?? rec['name'] ?? '').trim();
    const price = Number(rec['price']);
    if (!broker || !Number.isFinite(price) || price <= 0) continue;
    out.push({ broker, price: Math.round(price * 100) / 100 });
  }
  return out;
}

export function avgPrice(prices: number[]): number | null {
  const valid = prices.filter((n) => Number.isFinite(n) && n > 0);
  if (!valid.length) return null;
  return valid.reduce((sum, n) => sum + n, 0) / valid.length;
}

export function pctFromCmp(cmp: number | null | undefined, price: number): number | null {
  if (cmp == null || cmp <= 0 || !Number.isFinite(price)) return null;
  return ((price - cmp) / cmp) * 100;
}

export function buildPriceLadder(prices: number[], cmp: number | null | undefined): SignalLadderPoint[] {
  const levels = prices
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((price, i) => ({
      id: `p${i + 1}`,
      label: `P${i + 1}`,
      price,
      pctFromCmp: pctFromCmp(cmp, price),
      kind: 'level' as const,
    }));

  const cmpPoint =
    cmp != null && cmp > 0
      ? {
          id: 'cmp',
          label: 'CMP',
          price: cmp,
          pctFromCmp: 0,
          kind: 'cmp' as const,
        }
      : null;

  const points = cmpPoint ? [...levels, cmpPoint] : levels;
  if (!points.length) return [];

  const min = Math.min(...points.map((p) => p.price));
  const max = Math.max(...points.map((p) => p.price));
  const span = max - min;

  return points
    .map((p) => ({
      ...p,
      position: span <= 0 ? 50 : ((p.price - min) / span) * 100,
    }))
    .sort((a, b) => a.price - b.price || (a.kind === 'cmp' ? 1 : -1));
}

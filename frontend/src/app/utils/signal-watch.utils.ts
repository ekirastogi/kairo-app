export interface SignalBrokerTarget {
  broker: string;
  price: number;
}

export interface SignalLadderPoint {
  id: string;
  label: string;
  price: number;
  pctFromCmp: number | null;
  kind: 'level' | 'cmp' | 'both';
  position: number;
}

const LADDER_MIN_GAP = 16;

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

export type OverallSignal = 'positive' | 'negative' | 'neutral';

export interface SignalNewsItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  summary: string;
}

export function parseOverallSignal(raw: unknown): OverallSignal {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'positive' || value === 'negative' || value === 'neutral') return value;
  return 'neutral';
}

export interface SignalAiAnalysis {
  id: string;
  createdAt: number;
  overallSignal: OverallSignal;
  title: string;
  body: string;
}

export function parseAiAnalyses(raw: unknown): SignalAiAnalysis[] {
  if (!Array.isArray(raw)) return [];
  const out: SignalAiAnalysis[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const body = String(rec['body'] ?? rec['text'] ?? '').trim();
    const title = String(rec['title'] ?? '').trim() || 'AI analysis';
    if (!body && !title) continue;
    const createdAt = Number(rec['createdAt'] ?? rec['created_at'] ?? 0);
    out.push({
      id: String(rec['id'] ?? `${createdAt}-${out.length}`),
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      overallSignal: parseOverallSignal(rec['overallSignal'] ?? rec['overall_signal']),
      title,
      body,
    });
    if (out.length >= 10) break;
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
}

export function parseNewsItems(raw: unknown): SignalNewsItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SignalNewsItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const title = String(rec['title'] ?? '').trim();
    if (!title) continue;
    out.push({
      title,
      source: String(rec['source'] ?? '').trim(),
      url: String(rec['url'] ?? '').trim(),
      publishedAt: String(rec['publishedAt'] ?? rec['published_at'] ?? '').trim(),
      summary: String(rec['summary'] ?? '').trim(),
    });
    if (out.length >= 10) break;
  }
  return out;
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

export interface SignalBracket {
  label: string;
  price: number;
  pctFromCmp: number | null;
}

function asBrackets(raw: SignalBracket[] | null | undefined): SignalBracket[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p) => p && Number.isFinite(p.price) && p.price > 0);
}

/** Up to two user levels strictly below CMP (nearest first) and two strictly above. */
export function levelsAroundCmp(prices: number[] | null | undefined, cmp: number | null | undefined): {
  below: SignalBracket[];
  above: SignalBracket[];
} {
  const levels = (Array.isArray(prices) ? prices : [])
    .map((price, i) => ({ label: `P${i + 1}`, price }))
    .filter((p) => Number.isFinite(p.price) && p.price > 0);
  if (cmp == null || !Number.isFinite(cmp) || cmp <= 0) return { below: [], above: [] };
  const below = levels
    .filter((p) => p.price < cmp)
    .sort((a, b) => b.price - a.price)
    .slice(0, 2)
    .map((p) => ({ ...p, pctFromCmp: pctFromCmp(cmp, p.price) }));
  const above = levels
    .filter((p) => p.price > cmp)
    .sort((a, b) => a.price - b.price)
    .slice(0, 2)
    .map((p) => ({ ...p, pctFromCmp: pctFromCmp(cmp, p.price) }));
  return { below, above };
}

/** Compact two-below–CMP–two-above strip. Missing CMP or missing sides are omitted. */
export function buildQuoteStrip(
  below: SignalBracket[] | null | undefined,
  cmp: number | null | undefined,
  above: SignalBracket[] | null | undefined
): SignalLadderPoint[] {
  const pts: SignalLadderPoint[] = [];
  asBrackets(below)
    .slice()
    .reverse()
    .forEach((level, i) => {
      pts.push({
        id: `below-${i}`,
        label: '',
        price: level.price,
        pctFromCmp: level.pctFromCmp ?? null,
        kind: 'level',
        position: 0,
      });
    });
  if (cmp != null && Number.isFinite(cmp) && cmp > 0) {
    pts.push({
      id: 'cmp',
      label: '',
      price: cmp,
      pctFromCmp: 0,
      kind: 'cmp',
      position: 50,
    });
  }
  asBrackets(above).forEach((level, i) => {
    pts.push({
      id: `above-${i}`,
      label: '',
      price: level.price,
      pctFromCmp: level.pctFromCmp ?? null,
      kind: 'level',
      position: 100,
    });
  });
  if (!pts.length) return [];
  const min = Math.min(...pts.map((p) => p.price));
  const max = Math.max(...pts.map((p) => p.price));
  const span = max - min;
  const placed = pts.map((p) => ({ ...p, position: rawPosition(p.price, min, span) }));
  placed.sort((a, b) => a.position - b.position);
  const spaced = spreadLadderPositions(
    placed.map((p) => p.position),
    placed.length > 3 ? 18 : 28
  );
  return placed.map((p, i) => ({ ...p, position: spaced[i] }));
}

function rawPosition(price: number, min: number, span: number): number {
  return span <= 0 ? 50 : ((price - min) / span) * 100;
}

/** Push clustered markers apart so labels do not sit on top of each other. */
export function spreadLadderPositions(positions: number[], minGap = LADDER_MIN_GAP): number[] {
  const n = positions.length;
  if (n <= 1) return positions;
  const gap = Math.min(minGap, 100 / Math.max(1, n - 1));
  const out = [...positions];
  for (let i = 1; i < n; i++) {
    if (out[i] < out[i - 1] + gap) out[i] = out[i - 1] + gap;
  }
  if (out[n - 1] > 100) {
    out[n - 1] = 100;
    for (let i = n - 2; i >= 0; i--) {
      if (out[i] > out[i + 1] - gap) out[i] = out[i + 1] - gap;
    }
  }
  if (out[0] < 0) {
    return out.map((_, i) => (i * 100) / (n - 1));
  }
  return out;
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

  const hasCmp = cmp != null && cmp > 0;
  const anchors = hasCmp ? [...levels.map((p) => p.price), cmp as number] : levels.map((p) => p.price);
  if (!anchors.length) return [];

  const min = Math.min(...anchors);
  const max = Math.max(...anchors);
  const span = max - min;

  let points: SignalLadderPoint[] = levels.map((p) => ({
    ...p,
    position: rawPosition(p.price, min, span),
  }));

  if (hasCmp) {
    const cmpPos = rawPosition(cmp as number, min, span);
    const nearest = points.reduce(
      (best, p) => (Math.abs(p.position - cmpPos) < Math.abs(best.position - cmpPos) ? p : best),
      points[0]
    );
    if (nearest && Math.abs(nearest.position - cmpPos) < LADDER_MIN_GAP) {
      points = points.map((p) =>
        p.id === nearest.id ? { ...p, kind: 'both', label: `${p.label} · CMP` } : p
      );
    } else {
      points.push({
        id: 'cmp',
        label: 'CMP',
        price: cmp as number,
        pctFromCmp: 0,
        kind: 'cmp',
        position: cmpPos,
      });
    }
  }

  points.sort((a, b) => a.position - b.position || a.price - b.price);
  const spaced = spreadLadderPositions(points.map((p) => p.position));
  return points.map((p, i) => ({ ...p, position: spaced[i] }));
}

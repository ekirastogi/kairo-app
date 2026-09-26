export type TrackerProximity = 'hot' | 'near' | null;

/** Signed % distance of target from CMP: (target - cmp) / cmp * 100. */
export function trackerDiffPct(cmp: number | undefined | null, target: number): number | null {
  if (cmp == null || cmp <= 0 || !Number.isFinite(target)) return null;
  return ((target - cmp) / cmp) * 100;
}

export function trackerAbsDiffPct(cmp: number | undefined | null, target: number): number | null {
  const diff = trackerDiffPct(cmp, target);
  return diff == null ? null : Math.abs(diff);
}

/** Green ≤ 1% of CMP, yellow ≤ 2%. */
export function trackerProximity(cmp: number | undefined | null, target: number): TrackerProximity {
  const abs = trackerAbsDiffPct(cmp, target);
  if (abs == null) return null;
  if (abs <= 1) return 'hot';
  if (abs <= 2) return 'near';
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

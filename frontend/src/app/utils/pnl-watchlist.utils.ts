import { StockProfile, StockSummary } from '../models/trade.models';

export type PnlTierMode = 'cumulative' | 'band';

export interface PnlWatchlistTier {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  side: 'loss' | 'profit';
  /** Inclusive upper bound for matching stock net PnL */
  threshold: number;
  /** Matches stocks above threshold (open-ended top tier). */
  minOnly?: boolean;
}

export const PNL_WATCHLIST_TIERS: PnlWatchlistTier[] = [
  { id: 'loss-upto-5k', name: 'Loss up to ₹5K', color: '#fca5a5', sortOrder: 0, side: 'loss', threshold: 5_000 },
  { id: 'loss-upto-10k', name: 'Loss up to ₹10K', color: '#f87171', sortOrder: 1, side: 'loss', threshold: 10_000 },
  { id: 'loss-upto-25k', name: 'Loss up to ₹25K', color: '#f87171', sortOrder: 2, side: 'loss', threshold: 25_000 },
  { id: 'loss-upto-50k', name: 'Loss up to ₹50K', color: '#ef4444', sortOrder: 3, side: 'loss', threshold: 50_000 },
  { id: 'loss-upto-100k', name: 'Loss up to ₹100K', color: '#dc2626', sortOrder: 4, side: 'loss', threshold: 100_000 },
  { id: 'loss-upto-200k', name: 'Loss up to ₹200K', color: '#b91c1c', sortOrder: 5, side: 'loss', threshold: 200_000 },
  { id: 'loss-above-200k', name: 'Loss above ₹200K', color: '#991b1b', sortOrder: 6, side: 'loss', threshold: 200_000, minOnly: true },
  { id: 'profit-upto-5k', name: 'Profit up to ₹5K', color: '#86efac', sortOrder: 10, side: 'profit', threshold: 5_000 },
  { id: 'profit-upto-10k', name: 'Profit up to ₹10K', color: '#4ade80', sortOrder: 11, side: 'profit', threshold: 10_000 },
  { id: 'profit-upto-25k', name: 'Profit up to ₹25K', color: '#4ade80', sortOrder: 12, side: 'profit', threshold: 25_000 },
  { id: 'profit-upto-50k', name: 'Profit up to ₹50K', color: '#22c55e', sortOrder: 13, side: 'profit', threshold: 50_000 },
  { id: 'profit-upto-100k', name: 'Profit up to ₹100K', color: '#16a34a', sortOrder: 14, side: 'profit', threshold: 100_000 },
  { id: 'profit-upto-200k', name: 'Profit up to ₹200K', color: '#15803d', sortOrder: 15, side: 'profit', threshold: 200_000 },
  { id: 'profit-above-200k', name: 'Profit above ₹200K', color: '#14532d', sortOrder: 16, side: 'profit', threshold: 200_000, minOnly: true },
];

const TIER_MODE_STORAGE_KEY = 'kairo-pnl-tier-mode';

export function loadPnlTierMode(): PnlTierMode {
  if (typeof localStorage === 'undefined') return 'band';
  const stored = localStorage.getItem(TIER_MODE_STORAGE_KEY);
  if (stored === 'cumulative') return 'cumulative';
  return 'band';
}

export function savePnlTierMode(mode: PnlTierMode): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(TIER_MODE_STORAGE_KEY, mode);
}

export function getPnlWatchlistTier(id: string): PnlWatchlistTier | undefined {
  return PNL_WATCHLIST_TIERS.find((tier) => tier.id === id);
}

export function previousTierThreshold(tier: PnlWatchlistTier): number {
  const sameSide = PNL_WATCHLIST_TIERS.filter(
    (item) => item.side === tier.side && !item.minOnly
  ).sort((a, b) => a.threshold - b.threshold);
  const index = sameSide.findIndex((item) => item.id === tier.id);
  return index > 0 ? sameSide[index - 1].threshold : 0;
}

export function formatTierAmount(amount: number): string {
  if (amount >= 100_000) return `₹${amount / 100_000}L`;
  if (amount >= 1_000) return `₹${amount / 1_000}K`;
  return `₹${amount}`;
}

export function formatTierAmountShort(amount: number): string {
  if (amount >= 100_000) return `${amount / 100_000}L`;
  if (amount >= 1_000) return `${amount / 1_000}k`;
  return String(amount);
}

export function tierShortLabel(tier: PnlWatchlistTier, mode: PnlTierMode): string {
  const ceiling = formatTierAmountShort(tier.threshold);
  const prefix = tier.side === 'loss' ? 'Loss' : 'Profit';

  if (tier.minOnly) {
    return `${prefix}${ceiling}+`;
  }

  if (mode === 'band') {
    const floor = previousTierThreshold(tier);
    if (floor === 0) return `${prefix}${ceiling}`;
    return `${prefix}${formatTierAmountShort(floor)}-${ceiling}`;
  }

  return `${prefix}${ceiling}`;
}

export function tierDisplayName(tier: PnlWatchlistTier, mode: PnlTierMode): string {
  if (tier.minOnly) {
    const amount = formatTierAmount(tier.threshold);
    return tier.side === 'loss' ? `Loss above ${amount}` : `Profit above ${amount}`;
  }

  if (mode === 'cumulative') return tier.name;

  const floor = previousTierThreshold(tier);
  const ceiling = formatTierAmount(tier.threshold);
  if (tier.side === 'loss') {
    return floor === 0 ? `Loss up to ${ceiling}` : `Loss ${formatTierAmount(floor)}–${ceiling}`;
  }
  return floor === 0 ? `Profit up to ${ceiling}` : `Profit ${formatTierAmount(floor)}–${ceiling}`;
}

export function netPnLMatchesPnlTier(
  netPnL: number,
  tier: PnlWatchlistTier,
  mode: PnlTierMode = 'band'
): boolean {
  if (tier.minOnly) {
    if (tier.side === 'loss') return netPnL < 0 && Math.abs(netPnL) > tier.threshold;
    return netPnL > tier.threshold;
  }

  if (tier.side === 'loss') {
    if (netPnL >= 0) return false;
    const magnitude = Math.abs(netPnL);
    if (mode === 'cumulative') return magnitude <= tier.threshold;
    const floor = previousTierThreshold(tier);
    return magnitude > floor && magnitude <= tier.threshold;
  }

  if (netPnL <= 0) return false;
  if (mode === 'cumulative') return netPnL <= tier.threshold;
  const floor = previousTierThreshold(tier);
  return netPnL > floor && netPnL <= tier.threshold;
}

export function symbolsForPnlTier(
  profiles: StockProfile[],
  tier: PnlWatchlistTier,
  mode: PnlTierMode = 'band'
): string[] {
  return profiles
    .filter((profile) => netPnLMatchesPnlTier(profile.netPnL, tier, mode))
    .map((profile) => profile.symbol)
    .sort();
}

export function stockSummariesForPnlTier(
  summaries: StockSummary[],
  tier: PnlWatchlistTier,
  mode: PnlTierMode = 'band'
): StockSummary[] {
  return summaries
    .filter((summary) => netPnLMatchesPnlTier(summary.netPnL, tier, mode))
    .sort((a, b) => b.netPnL - a.netPnL);
}

/** Histogram ceilings for the Analyse tab: 0–1k, 1–5k, 5–10k, … 200k+. */
const ANALYSE_PNL_CEILINGS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 200_000];

const ANALYSE_PROFIT_COLORS = [
  '#bbf7d0', '#86efac', '#4ade80', '#22c55e', '#16a34a', '#15803d', '#166534', '#14532d',
];
const ANALYSE_LOSS_COLORS = [
  '#fecaca', '#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d',
];

export interface PnlAnalyseBucket {
  label: string;
  count: number;
  color: string;
}

export function analysePnlStockBuckets(
  summaries: StockSummary[],
  side: 'profit' | 'loss'
): PnlAnalyseBucket[] {
  const magnitudes = summaries
    .map((stock) => stock.netPnL)
    .filter((value) => (side === 'profit' ? value > 0 : value < 0))
    .map((value) => Math.abs(value));
  const colors = side === 'profit' ? ANALYSE_PROFIT_COLORS : ANALYSE_LOSS_COLORS;

  const buckets: PnlAnalyseBucket[] = [];
  let floor = 0;
  for (let i = 0; i < ANALYSE_PNL_CEILINGS.length; i++) {
    const ceiling = ANALYSE_PNL_CEILINGS[i];
    buckets.push({
      label: `${formatTierAmountShort(floor)}–${formatTierAmountShort(ceiling)}`,
      count: magnitudes.filter((value) => value > floor && value <= ceiling).length,
      color: colors[i],
    });
    floor = ceiling;
  }
  buckets.push({
    label: `${formatTierAmountShort(floor)}+`,
    count: magnitudes.filter((value) => value > floor).length,
    color: colors[ANALYSE_PNL_CEILINGS.length],
  });
  return buckets;
}

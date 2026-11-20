/** Whole shares of this stock that |net P&L| could buy at CMP. */
export function sharesBuyableWithPnl(netPnl: number, cmp: number | null | undefined): number | null {
  if (cmp == null || !(cmp > 0) || !Number.isFinite(netPnl)) return null;
  return Math.floor(Math.abs(netPnl) / cmp);
}

/** Fields we can identify a stock from. Display names stay as-is; identity is ISIN. */
export interface StockIdentityFields {
  isin?: string | null;
  symbol?: string | null;
  stockName?: string | null;
  name?: string | null;
  exchange?: string | null;
}

export type IdentityHint = {
  symbol: string;
  name?: string;
  isin?: string;
  exchange?: string;
};

/** Canonical ISIN: letters and digits only. Empty when the source had no ISIN. */
export function normalizeIsin(isin?: string | null): string {
  return (isin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 12-character ISIN, e.g. INE022Q01020. */
export function looksLikeIsin(value?: string | null): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(normalizeIsin(value));
}

/** Display/routing ticker derived from a company name when no exchange symbol is known yet. */
export function normalizeSymbol(stockName: string): string {
  return stockName
    .trim()
    .toUpperCase()
    .replace(/\s+(LTD|LIMITED|INC|CORP|CO)\.?$/i, '')
    .replace(/[^A-Z0-9&-]/g, '')
    .slice(0, 32) || stockName.trim().toUpperCase();
}

/**
 * Stable identity for grouping, matching, and persistence.
 * ISIN wins. Symbol/name are fallbacks only when a row has no ISIN (F&O, manual).
 */
export function stockIdentityKey(stock: StockIdentityFields): string {
  const isin = normalizeIsin(stock.isin);
  if (isin) return isin;
  const symbol = (stock.symbol ?? '').trim().toUpperCase();
  if (symbol) return `SYM:${symbol}`;
  const name = (stock.stockName ?? stock.name ?? '').trim();
  return `NAME:${normalizeSymbol(name)}`;
}

export function stocksMatch(a: StockIdentityFields, b: StockIdentityFields): boolean {
  return stockIdentityKey(a) === stockIdentityKey(b);
}

/** Ticker plus the name-derived fallback, so rows identified either way still line up. */
function symbolAliases(row: StockIdentityFields): Set<string> {
  const aliases = new Set<string>();
  const symbol = (row.symbol ?? '').trim().toUpperCase();
  if (symbol) aliases.add(symbol);
  const name = (row.stockName ?? row.name ?? '').trim();
  if (name) aliases.add(normalizeSymbol(name));
  return aliases;
}

/**
 * Whether a trade belongs to a stock row. Stock rows are merged by display symbol, so one row
 * can span several ISINs — a split or face-value change issues a new one, and Groww then files
 * the same scrip under both. Matching on ISIN alone hides every trade booked under the others.
 */
export function tradeBelongsToStock(
  trade: StockIdentityFields,
  stock: StockIdentityFields
): boolean {
  if (stocksMatch(trade, stock)) return true;
  const stockAliases = symbolAliases(stock);
  return [...symbolAliases(trade)].some((alias) => stockAliases.has(alias));
}

export function collectIsinsByName(rows: Iterable<StockIdentityFields>): Map<string, string> {
  const isinByName = new Map<string, string>();
  for (const row of rows) {
    const isin = normalizeIsin(row.isin);
    const nameKey = normalizeSymbol((row.stockName ?? row.name ?? '').trim());
    if (isin && nameKey && !isinByName.has(nameKey)) isinByName.set(nameKey, isin);
  }
  return isinByName;
}

export function applyKnownIsins<T extends { isin: string; stockName: string }>(
  rows: T[],
  isinByName: Map<string, string>
): T[] {
  return rows.map((row) => {
    const isin = normalizeIsin(row.isin) || isinByName.get(normalizeSymbol(row.stockName)) || '';
    return isin === row.isin ? row : { ...row, isin };
  });
}

/**
 * Copy a known ISIN onto rows of the same scrip that arrived without one
 * (e.g. a trade line missing column 1 while the scrip sheet had it).
 */
export function fillMissingIsins<T extends { isin: string; stockName: string }>(rows: T[]): T[] {
  return applyKnownIsins(rows, collectIsinsByName(rows));
}

/** Collapse rows that are the same stock (same ISIN, else same symbol/name). */
export function mergeByStockIdentity<T extends StockIdentityFields>(
  rows: T[],
  merge: (a: T, b: T) => T
): T[] {
  const map = new Map<string, T>();
  for (const row of rows) {
    const key = stockIdentityKey(row);
    const existing = map.get(key);
    map.set(key, existing ? merge(existing, row) : row);
  }
  return [...map.values()];
}

/**
 * Collapse rows that share a ticker. Needed because several tables still key on
 * `(user_id, symbol)` — two ISIN groups that resolved to VBL would 21000 on upsert.
 */
export function mergeByDisplaySymbol<T extends { symbol?: string | null }>(
  rows: T[],
  merge: (a: T, b: T) => T
): T[] {
  const map = new Map<string, T>();
  const blanks: T[] = [];
  for (const row of rows) {
    const key = (row.symbol ?? '').trim().toUpperCase();
    if (!key) {
      blanks.push(row);
      continue;
    }
    const existing = map.get(key);
    map.set(key, existing ? merge(existing, row) : row);
  }
  return [...map.values(), ...blanks];
}

/** Keep the first row for each key so a batch upsert cannot hit the same conflict twice. */
export function uniqueByKey<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function preferStockSymbol(existing?: string | null, candidate?: string | null): string {
  const left = (existing ?? '').trim().toUpperCase();
  const right = (candidate ?? '').trim().toUpperCase();
  if (!left) return right;
  if (!right) return left;
  if (right.length < left.length) return right;
  return left;
}

/**
 * Maps an ISIN to one canonical ticker for routing, labels, and a future Groww live feed.
 * NSE / shorter tickers (VBL) win over name-derived symbols (VARUNBEVERAGES).
 */
export class StockIdentityResolver {
  private symbolByIsin = new Map<string, string>();
  private isinBySymbol = new Map<string, string>();

  static fromHints(hints: IdentityHint[]): StockIdentityResolver {
    const resolver = new StockIdentityResolver();
    for (const hint of hints) resolver.addKnown(hint);
    return resolver;
  }

  addKnown(hint: IdentityHint): void {
    const symbol = hint.symbol.trim().toUpperCase();
    if (!symbol) return;
    const isin = normalizeIsin(hint.isin);
    if (!isin) return;
    const existing = this.symbolByIsin.get(isin);
    if (!existing || preferTicker(existing, symbol, hint.exchange)) {
      this.symbolByIsin.set(isin, symbol);
    }
    const canonical = this.symbolByIsin.get(isin);
    if (canonical) this.isinBySymbol.set(canonical, isin);
  }

  resolve(isinRaw: string, name: string, symbolHint = ''): { isin: string; symbol: string } {
    const isin = normalizeIsin(isinRaw);
    if (isin) {
      const mapped = this.symbolByIsin.get(isin);
      if (mapped) return { isin, symbol: mapped };
    }

    const hinted = symbolHint.trim().toUpperCase();
    const symbol = hinted || normalizeSymbol(name);
    if (isin) {
      /**
       * Groww issues a new ISIN on a split/face-value change while the company name stays the
       * same. Those rows must share one ticker so stock profiles, day lists, and FYTD totals
       * stay one stock — suffixing (`BAJAJFINANCE-A01032`) was splitting them apart and
       * dropping post-split trades from the day breakdown while the header still summed both.
       */
      this.symbolByIsin.set(isin, symbol);
      if (!this.isinBySymbol.has(symbol)) this.isinBySymbol.set(symbol, isin);
    }
    return { isin, symbol };
  }
}

function preferTicker(existing: string, candidate: string, exchange?: string): boolean {
  if (candidate === existing) return false;
  const candidateNse = exchange === 'NSE';
  if (candidateNse && candidate.length < existing.length) return true;
  if (candidate.length < existing.length) return true;
  return false;
}

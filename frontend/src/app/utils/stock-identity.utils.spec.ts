import { normalizeSymbol } from './upload-merge.utils';
import {
  applyKnownIsins,
  collectIsinsByName,
  fillMissingIsins,
  looksLikeIsin,
  mergeByDisplaySymbol,
  normalizeIsin,
  StockIdentityResolver,
  stockIdentityKey,
  stocksMatch,
  tradeBelongsToStock,
  uniqueByKey,
} from './stock-identity.utils';

describe('stock identity', () => {
  it('normalizes ISIN by trimming and uppercasing', () => {
    expect(normalizeIsin(' ine200m01013 ')).toBe('INE200M01013');
    expect(normalizeIsin('')).toBe('');
    expect(normalizeIsin(null)).toBe('');
  });

  it('recognizes a 12-character ISIN and rejects tickers or names', () => {
    expect(looksLikeIsin('INE022Q01020')).toBe(true);
    expect(looksLikeIsin(' ine022q01020 ')).toBe(true);
    expect(looksLikeIsin('IEX')).toBe(false);
    expect(looksLikeIsin('Indian Energy Exchange Ltd')).toBe(false);
  });

  it('uses ISIN as the identity even when names differ', () => {
    expect(
      stockIdentityKey({ isin: 'INE200M01013', stockName: 'VARUN BEVERAGES LIMITED' })
    ).toBe(
      stockIdentityKey({ isin: ' ine200m01013 ', stockName: 'VARUN BEVERAGES LTD' })
    );
  });

  it('does not treat the same name with different ISINs as one stock', () => {
    expect(stockIdentityKey({ isin: 'INE000000001', stockName: 'ACME' })).not.toBe(
      stockIdentityKey({ isin: 'INE000000002', stockName: 'ACME' })
    );
  });

  it('copies a known ISIN onto name-matched rows that arrived without one', () => {
    const rows = fillMissingIsins([
      { isin: 'INE200M01013', stockName: 'VARUN BEVERAGES LIMITED' },
      { isin: '', stockName: 'VARUN BEVERAGES LIMITED' },
    ]);
    expect(rows[1].isin).toBe('INE200M01013');
  });

  it('maps every row of an ISIN onto the NSE ticker, not a name-derived symbol', () => {
    const resolver = StockIdentityResolver.fromHints([
      { symbol: 'VARUNBEVERAGES', name: 'VARUN BEVERAGES LIMITED', isin: 'INE200M01013' },
      { symbol: 'VBL', name: 'Varun Beverages Ltd', isin: 'INE200M01013', exchange: 'NSE' },
    ]);
    expect(resolver.resolve('INE200M01013', 'VARUN BEVERAGES LIMITED').symbol).toBe('VBL');
    expect(resolver.resolve(' ine200m01013 ', 'VARUN BEVERAGES LTD').symbol).toBe('VBL');
  });

  it('strips junk so the same ISIN still matches', () => {
    expect(normalizeIsin('INE200M01013\u200b')).toBe('INE200M01013');
    expect(normalizeIsin('INE-200M-01013')).toBe('INE200M01013');
  });

  it('copies an ISIN from a scrip-sheet name onto trades of that scrip', () => {
    const known = collectIsinsByName([
      { isin: 'INE200M01013', stockName: 'VARUN BEVERAGES LIMITED' },
    ]);
    const trades = applyKnownIsins(
      [{ isin: '', stockName: 'VARUN BEVERAGES LTD' }],
      known
    );
    expect(trades[0].isin).toBe('INE200M01013');
  });

  it('keeps one ticker across split ISINs so Bajaj Finance stays a single stock', () => {
    const resolver = new StockIdentityResolver();
    const pre = resolver.resolve('INE296A01024', 'BAJAJ FINANCE LIMITED');
    const post = resolver.resolve('INE296A01032', 'BAJAJ FINANCE LIMITED');
    expect(pre.symbol).toBe(post.symbol);
    expect(pre.isin).not.toBe(post.isin);
  });

  it('merges rows that share a display ticker', () => {
    const merged = mergeByDisplaySymbol(
      [
        { symbol: 'VBL', qty: 2 },
        { symbol: 'vbl', qty: 3 },
      ],
      (a, b) => ({ symbol: 'VBL', qty: a.qty + b.qty })
    );
    expect(merged).toEqual([{ symbol: 'VBL', qty: 5 }]);
  });

  it('keeps a post-split ISIN with the stock row its trades are displayed under', () => {
    const stock = { isin: 'INE296A01024', symbol: 'BAJFINANCE', stockName: 'BAJAJ FINANCE LIMITED' };
    // Groww files post-split trades under a fresh ISIN while the name stays the same.
    const splitTrade = { isin: 'INE296A01032', stockName: 'BAJAJ FINANCE LIMITED' };

    expect(stocksMatch(splitTrade, stock)).toBe(false);
    expect(tradeBelongsToStock(splitTrade, stock)).toBe(true);
  });

  it('does not pull a different scrip into a stock row', () => {
    expect(
      tradeBelongsToStock(
        { isin: 'INE918I01018', stockName: 'BAJAJ FINSERV LTD.' },
        { isin: 'INE296A01024', symbol: 'BAJFINANCE', stockName: 'BAJAJ FINANCE LIMITED' }
      )
    ).toBe(false);
  });

  it('drops later upsert rows that share a conflict key', () => {
    expect(uniqueByKey([{ id: 'a' }, { id: 'a' }, { id: 'b' }], (row) => row.id)).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
  });
});

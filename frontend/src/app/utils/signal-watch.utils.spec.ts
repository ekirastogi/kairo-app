import {
  avgPrice,
  buildPriceLadder,
  formatPriceListText,
  parseBrokerTargets,
  parsePriceListText,
  pctFromCmp,
} from './signal-watch.utils';

describe('signal watch utils', () => {
  it('parses a comma list in typed order and drops duplicates', () => {
    expect(parsePriceListText('245, 250, 245, 260')).toEqual([245, 250, 260]);
    expect(parsePriceListText('800 790; 810')).toEqual([800, 790, 810]);
    expect(formatPriceListText([245, 250.5])).toBe('245, 250.5');
  });

  it('builds a CMP ladder with percent distance and 0–100 positions', () => {
    const ladder = buildPriceLadder([90, 110], 100);
    expect(ladder.map((p) => p.label)).toEqual(['P1', 'CMP', 'P2']);
    expect(ladder[0].pctFromCmp).toBe(-10);
    expect(ladder[1].kind).toBe('cmp');
    expect(ladder[2].pctFromCmp).toBe(10);
    expect(ladder[0].position).toBe(0);
    expect(ladder[2].position).toBe(100);
  });

  it('averages prices and parses broker targets', () => {
    expect(avgPrice([100, 200])).toBe(150);
    expect(pctFromCmp(100, 115)).toBe(15);
    expect(parseBrokerTargets([{ broker: 'Motilal', price: 240 }])).toEqual([{ broker: 'Motilal', price: 240 }]);
  });
});

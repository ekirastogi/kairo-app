import {
  avgPrice,
  buildPriceLadder,
  formatPriceListText,
  levelsAroundCmp,
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

  it('merges CMP into a nearby level instead of overlapping labels', () => {
    const ladder = buildPriceLadder([1580, 1650, 1730, 1850, 1950], 1940);
    expect(ladder.some((p) => p.kind === 'both' && p.label.includes('P5'))).toBeTrue();
    expect(ladder.some((p) => p.id === 'cmp')).toBeFalse();
    const gaps = ladder.slice(1).map((p, i) => p.position - ladder[i].position);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(16 - 0.001);
  });

  it('picks the level just below CMP and just above CMP', () => {
    const around = levelsAroundCmp([1080, 1196, 1245, 1310], 1224);
    expect(around.below).toEqual(jasmine.objectContaining({ label: 'P2', price: 1196 }));
    expect(around.above).toEqual(jasmine.objectContaining({ label: 'P3', price: 1245 }));
  });

  it('averages prices and parses broker targets', () => {
    expect(avgPrice([100, 200])).toBe(150);
    expect(pctFromCmp(100, 115)).toBe(15);
    expect(parseBrokerTargets([{ broker: 'Motilal', price: 240 }])).toEqual([{ broker: 'Motilal', price: 240 }]);
  });
});

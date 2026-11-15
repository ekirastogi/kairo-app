import {
  avgPrice,
  buildPriceLadder,
  formatPriceListText,
  buildQuoteStrip,
  levelsAroundCmp,
  parseBrokerTargets,
  parseAiAnalyses,
  parseNewsItems,
  parseOverallSignal,
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

  it('picks two levels below CMP and two above', () => {
    const around = levelsAroundCmp([1080, 1196, 1245, 1310], 1224);
    expect(around.below.map((p) => p.price)).toEqual([1196, 1080]);
    expect(around.above.map((p) => p.price)).toEqual([1245, 1310]);
    const strip = buildQuoteStrip(around.below, 1224, around.above);
    expect(strip.map((p) => p.price)).toEqual([1080, 1196, 1224, 1245, 1310]);
    expect(strip.filter((p) => p.kind === 'cmp').length).toBe(1);
  });

  it('does not throw when CMP or neighbouring prices are missing', () => {
    expect(levelsAroundCmp(undefined, null)).toEqual({ below: [], above: [] });
    expect(levelsAroundCmp([], 100)).toEqual({ below: [], above: [] });
    expect(levelsAroundCmp([90], 100).below.map((p) => p.price)).toEqual([90]);
    expect(levelsAroundCmp([90], 100).above).toEqual([]);
    expect(buildQuoteStrip(null, null, undefined)).toEqual([]);
    expect(buildQuoteStrip([{ label: 'P1', price: 90, pctFromCmp: -10 }], 100, []).map((p) => p.kind)).toEqual([
      'level',
      'cmp',
    ]);
  });

  it('averages prices and parses broker targets', () => {
    expect(avgPrice([100, 200])).toBe(150);
    expect(pctFromCmp(100, 115)).toBe(15);
    expect(parseBrokerTargets([{ broker: 'Motilal', price: 240 }])).toEqual([{ broker: 'Motilal', price: 240 }]);
    expect(parseOverallSignal('Positive')).toBe('positive');
    expect(parseNewsItems([{ title: 'Beat', source: 'ET' }, { title: '' }])).toEqual([
      { title: 'Beat', source: 'ET', url: '', publishedAt: '', summary: '' },
    ]);
    const reports = parseAiAnalyses([
      { id: 'old', createdAt: 1, title: 'Old', body: 'a', overallSignal: 'negative' },
      { id: 'new', createdAt: 9, title: 'New', body: 'b', overallSignal: 'positive' },
    ]);
    expect(reports[0].id).toBe('new');
    expect(reports.length).toBe(2);
  });
});

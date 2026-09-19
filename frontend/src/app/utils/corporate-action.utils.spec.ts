import {
  applyCorporateActionToTrade,
  applyCorporateActionsToTrades,
} from './corporate-action.utils';
import { CorporateAction } from '../models/corporate-action.models';
import { Trade } from '../models/trade.models';

function baseTrade(overrides: Partial<Trade & { symbol?: string }> = {}): Trade & {
  symbol?: string;
} {
  return {
    stockName: 'Example',
    isin: '',
    quantity: 100,
    buyDate: '2024-01-01',
    buyPrice: 10,
    buyValue: 1000,
    sellDate: '2024-02-01',
    sellPrice: 11,
    sellValue: 1100,
    realisedPnL: 100,
    remark: '',
    tradeType: 'delivery',
    holdingDays: 30,
    ...overrides,
  };
}

const mindtreeMerge: CorporateAction = {
  id: 'ca-mindtree',
  actionType: 'merge',
  fromSymbol: 'MINDTREE',
  fromName: 'Mindtree Ltd',
  fromIsin: 'INE018I01017',
  toSymbol: 'LTIM',
  toName: 'LTIMindtree Ltd',
  toIsin: 'INE214T01019',
  ratioFrom: 100,
  ratioTo: 73,
  effectiveDate: '2022-11-14',
  notes: '',
  sourceUrl: '',
  createdAt: 0,
  updatedAt: 0,
};

const tv18Merge: CorporateAction = {
  id: 'ca-tv18',
  actionType: 'merge',
  fromSymbol: 'TV18BRDCST',
  fromName: 'TV18 Broadcast Ltd',
  fromIsin: 'INE886H01027',
  toSymbol: 'NETWORK18',
  toName: 'Network18 Media & Investments Ltd',
  toIsin: 'INE870H01013',
  ratioFrom: 172,
  ratioTo: 100,
  effectiveDate: '2024-10-03',
  notes: '',
  sourceUrl: '',
  createdAt: 0,
  updatedAt: 0,
};

describe('corporate action remap', () => {
  it('remaps Mindtree ISIN onto surviving LTIM ISIN', () => {
    const remapped = applyCorporateActionToTrade(
      baseTrade({
        symbol: 'MINDTREE',
        stockName: 'Mindtree Ltd',
        isin: 'INE018I01017',
      }),
      [mindtreeMerge]
    );
    expect(remapped.symbol).toBe('LTIM');
    expect(remapped.isin).toBe('INE214T01019');
    expect(remapped.originalIsin).toBe('INE018I01017');
    expect(remapped.corporateActionId).toBe('ca-mindtree');
  });

  it('normalizes surviving LTM LIMITED onto LTIM identity', () => {
    const remapped = applyCorporateActionToTrade(
      baseTrade({
        symbol: 'LTM-T01019',
        stockName: 'LTM LIMITED',
        isin: 'INE214T01019',
      }),
      [mindtreeMerge]
    );
    expect(remapped.symbol).toBe('LTIM');
    expect(remapped.stockName).toBe('LTIMindtree Ltd');
    expect(remapped.isin).toBe('INE214T01019');
  });

  it('refreshes toIsin on already-linked remapped trades', () => {
    const remapped = applyCorporateActionToTrade(
      baseTrade({
        symbol: 'NETWORK18',
        stockName: 'Network18 Media & Investments Ltd',
        isin: 'INE886H01027',
        originalSymbol: 'TV18BROADCAST',
        originalIsin: 'INE886H01027',
        corporateActionId: 'ca-tv18',
      } as Trade & { symbol?: string; originalSymbol?: string; originalIsin?: string; corporateActionId?: string }),
      [tv18Merge]
    );
    expect(remapped.isin).toBe('INE870H01013');
    expect(remapped.originalIsin).toBe('INE886H01027');
  });

  it('collapses NETWORK18 media name onto surviving ISIN', () => {
    const [a, b] = applyCorporateActionsToTrades(
      [
        baseTrade({
          symbol: 'NETWORK18MEDIA&INV',
          stockName: 'NETWORK18 MEDIA & INV LTD',
          isin: 'INE870H01013',
        }),
        baseTrade({
          symbol: 'TV18BROADCAST',
          stockName: 'TV18 Broadcast Ltd',
          isin: 'INE886H01027',
        }),
      ],
      [tv18Merge]
    );
    expect(a.symbol).toBe('NETWORK18');
    expect(a.isin).toBe('INE870H01013');
    expect(b.symbol).toBe('NETWORK18');
    expect(b.isin).toBe('INE870H01013');
  });
});

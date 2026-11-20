import { sharesBuyableWithPnl } from './could-buy.utils';

describe('sharesBuyableWithPnl', () => {
  it('uses absolute P&L and floors to whole shares', () => {
    expect(sharesBuyableWithPnl(-1234, 100)).toBe(12);
    expect(sharesBuyableWithPnl(500, 200)).toBe(2);
  });

  it('returns null without a usable CMP', () => {
    expect(sharesBuyableWithPnl(-100, null)).toBeNull();
    expect(sharesBuyableWithPnl(-100, 0)).toBeNull();
  });
});

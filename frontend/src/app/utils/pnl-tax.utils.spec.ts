import {
  INDIA_INTRADAY_TAX_RATE,
  INDIA_LTCG_EXEMPTION,
  INDIA_LTCG_RATE,
  INDIA_STCG_RATE,
  applyIndiaTradingTax,
  buildPnLTaxBreakdown,
} from './pnl-tax.utils';
import { Trade } from '../models/trade.models';

function trade(partial: Partial<Trade>): Trade {
  return {
    stockName: 'TEST',
    isin: 'INE000000001',
    quantity: 1,
    buyDate: '2026-01-01',
    buyPrice: 100,
    buyValue: 100,
    sellDate: '2026-01-02',
    sellPrice: 110,
    sellValue: 110,
    realisedPnL: 10,
    remark: '',
    tradeType: 'delivery',
    holdingDays: 1,
    allocatedCharges: 0,
    netPnL: 10,
    ...partial,
  };
}

describe('applyIndiaTradingTax', () => {
  it('taxes only positive speculative net at 30% slab + cess', () => {
    const taxes = applyIndiaTradingTax({
      intradayNet: 1000,
      deliveryStcgNet: 0,
      deliveryLtcgNet: 0,
    });
    expect(taxes.taxIntraday).toBeCloseTo(1000 * INDIA_INTRADAY_TAX_RATE);
    expect(taxes.taxDelivery).toBe(0);
    expect(taxes.tax).toBeCloseTo(taxes.taxIntraday);
  });

  it('does not create a tax credit from intraday losses', () => {
    const taxes = applyIndiaTradingTax({
      intradayNet: -5000,
      deliveryStcgNet: 1000,
      deliveryLtcgNet: 0,
    });
    expect(taxes.taxIntraday).toBe(0);
    expect(taxes.taxDelivery).toBeCloseTo(1000 * INDIA_STCG_RATE);
  });

  it('applies the listed-equity LTCG exemption before 12.5% + cess', () => {
    const gain = INDIA_LTCG_EXEMPTION + 10_000;
    const taxes = applyIndiaTradingTax({
      intradayNet: 0,
      deliveryStcgNet: 0,
      deliveryLtcgNet: gain,
    });
    expect(taxes.taxDelivery).toBeCloseTo(10_000 * INDIA_LTCG_RATE);
  });
});

describe('buildPnLTaxBreakdown', () => {
  it('splits profit, loss, and net by intraday vs delivery', () => {
    const result = buildPnLTaxBreakdown([
      trade({
        tradeType: 'intraday',
        remark: 'intraday',
        buyDate: '2026-01-05',
        sellDate: '2026-01-05',
        holdingDays: 0,
        netPnL: 200,
      }),
      trade({
        tradeType: 'intraday',
        remark: 'intraday',
        buyDate: '2026-01-06',
        sellDate: '2026-01-06',
        holdingDays: 0,
        netPnL: -50,
      }),
      trade({ tradeType: 'delivery', netPnL: 400, holdingDays: 10 }),
      trade({ tradeType: 'delivery', netPnL: -100, holdingDays: 20 }),
    ]);

    expect(result.hasOutcomeSplit).toBe(true);
    expect(result.intraday).toEqual({ profit: 200, loss: -50, net: 150 });
    expect(result.delivery).toEqual({ profit: 400, loss: -100, net: 300 });
    expect(result.netPnL).toBe(450);
    expect(result.taxIntraday).toBeCloseTo(150 * INDIA_INTRADAY_TAX_RATE);
    expect(result.taxDelivery).toBeCloseTo(300 * INDIA_STCG_RATE);
    expect(result.pat).toBeCloseTo(450 - result.tax);
  });

  it('treats same-day trades as intraday for tax', () => {
    const result = buildPnLTaxBreakdown([
      trade({
        tradeType: 'same_day',
        remark: '',
        buyDate: '2026-03-01',
        sellDate: '2026-03-01',
        holdingDays: 0,
        netPnL: 80,
      }),
    ]);
    expect(result.intraday.net).toBe(80);
    expect(result.delivery.net).toBe(0);
  });

  it('falls back to daily nets without a profit/loss split', () => {
    const result = buildPnLTaxBreakdown(
      [],
      0,
      [
        {
          sellDate: '2026-01-02',
          tradeType: 'intraday',
          tradeCount: 2,
          totalBuyValue: 0,
          totalSellValue: 0,
          realisedPnL: 100,
          allocatedCharges: 10,
          netPnL: 90,
          winningTrades: 1,
          losingTrades: 1,
        },
        {
          sellDate: '2026-01-02',
          tradeType: 'delivery',
          tradeCount: 1,
          totalBuyValue: 0,
          totalSellValue: 0,
          realisedPnL: 50,
          allocatedCharges: 5,
          netPnL: 45,
          winningTrades: 1,
          losingTrades: 0,
        },
      ]
    );
    expect(result.hasOutcomeSplit).toBe(false);
    expect(result.intraday.net).toBe(90);
    expect(result.delivery.net).toBe(45);
    expect(result.taxIntraday).toBeCloseTo(90 * INDIA_INTRADAY_TAX_RATE);
    expect(result.pat).toBeCloseTo(135 - result.tax);
  });
});

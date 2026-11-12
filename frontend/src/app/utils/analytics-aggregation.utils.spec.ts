import { DailyAnalyticsRow } from '../models/trade.models';
import { sellDatesForPeriodScope } from './analytics-aggregation.utils';

function row(sellDate: string): DailyAnalyticsRow {
  return {
    sellDate,
    tradeType: 'delivery',
    tradeCount: 1,
    totalBuyValue: 1,
    totalSellValue: 1,
    realisedPnL: 0,
    allocatedCharges: 0,
    netPnL: 0,
    winningTrades: 0,
    losingTrades: 0,
  };
}

describe('sellDatesForPeriodScope', () => {
  const rows = [
    row('2026-11-13'), // Friday
    row('2026-11-16'), // Monday
    row('2026-10-13'), // Tuesday
    row('2025-11-13'), // Thursday
  ];

  it('keeps Fridays for weekday 5', () => {
    expect(sellDatesForPeriodScope(rows, 'weekday', '5')).toEqual(['2026-11-13']);
  });

  it('keeps the 13th for day-of-month', () => {
    expect(sellDatesForPeriodScope(rows, 'dayOfMonth', '13')).toEqual([
      '2025-11-13',
      '2026-10-13',
      '2026-11-13',
    ]);
  });

  it('keeps November for month-of-year', () => {
    expect(sellDatesForPeriodScope(rows, 'monthOfYear', '11')).toEqual([
      '2025-11-13',
      '2026-11-13',
      '2026-11-16',
    ]);
  });
});

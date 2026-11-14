import {
  aopMonthKeyFromIso,
  aopPeriodWritable,
  aopWeekKeyFromIso,
  shiftMonthKey,
  shiftWeekKey,
} from './aop-period.utils';

describe('aop period navigation', () => {
  it('defaults to the ISO week and calendar month of the given day', () => {
    expect(aopWeekKeyFromIso('2026-11-13')).toBe('W:2026-W46');
    expect(aopMonthKeyFromIso('2026-11-13')).toBe('M:2026-11');
  });

  it('steps a week or month forward and back', () => {
    expect(shiftWeekKey('W:2026-W46', -1)).toBe('W:2026-W45');
    expect(shiftWeekKey('W:2026-W46', 1)).toBe('W:2026-W47');
    expect(shiftMonthKey('M:2026-11', -1)).toBe('M:2026-10');
    expect(shiftMonthKey('M:2026-11', 1)).toBe('M:2026-12');
  });

  it('treats the current and future periods as writable', () => {
    expect(aopPeriodWritable('W:2026-W46', '2026-11-13')).toBeTrue();
    expect(aopPeriodWritable('M:2026-11', '2026-11-13')).toBeTrue();
    expect(aopPeriodWritable('W:2026-W45', '2026-11-13')).toBeFalse();
    expect(aopPeriodWritable('M:2026-10', '2026-11-13')).toBeFalse();
  });
});

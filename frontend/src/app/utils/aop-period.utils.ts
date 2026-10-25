import { getISOWeek } from './analytics-aggregation.utils';
import { istTodayIso } from './market-calendar.utils';

export type AopKind = 'week' | 'month';

export interface AopPeriodOption {
  key: string;
  kind: AopKind;
  label: string;
  hint: string;
  writable: boolean;
}

const MS_DAY = 86_400_000;

export function aopTodayIso(): string {
  return istTodayIso();
}

export function aopWeekKeyFromIso(iso: string): string {
  const { year, week } = getISOWeek(new Date(`${iso}T12:00:00`));
  return `W:${year}-W${String(week).padStart(2, '0')}`;
}

export function aopMonthKeyFromIso(iso: string): string {
  return `M:${iso.slice(0, 7)}`;
}

export function shiftIsoDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shiftMonthKey(monthKey: string, months: number): string {
  const raw = monthKey.startsWith('M:') ? monthKey.slice(2) : monthKey;
  const [year, month] = raw.split('-').map(Number);
  const d = new Date(year, month - 1 + months, 1);
  return `M:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function aopKindOf(key: string): AopKind {
  return key.startsWith('M:') ? 'month' : 'week';
}

export function aopWritableKeys(todayIso = aopTodayIso()): string[] {
  return [
    aopWeekKeyFromIso(todayIso),
    aopWeekKeyFromIso(shiftIsoDays(todayIso, 7)),
    aopMonthKeyFromIso(todayIso),
  ];
}

function isoWeekMondayUtc(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay() || 7;
  return jan4 - (jan4Dow - 1) * MS_DAY + (week - 1) * 7 * MS_DAY;
}

function formatDay(ms: number, withYear: boolean): string {
  return new Date(ms).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

export function aopPeriodHint(key: string): string {
  if (key.startsWith('M:')) {
    const iso = `${key.slice(2)}-01`;
    return new Date(`${iso}T12:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  }
  const match = key.slice(2).match(/^(\d{4})-W(\d{2})$/i);
  if (!match) return key;
  const monday = isoWeekMondayUtc(Number(match[1]), Number(match[2]));
  const sunday = monday + 6 * MS_DAY;
  const sameYear = new Date(monday).getUTCFullYear() === new Date(sunday).getUTCFullYear();
  return `${formatDay(monday, !sameYear)} – ${formatDay(sunday, true)}`;
}

export function aopPeriodLabel(key: string, todayIso = aopTodayIso()): string {
  const thisWeek = aopWeekKeyFromIso(todayIso);
  const nextWeek = aopWeekKeyFromIso(shiftIsoDays(todayIso, 7));
  const lastWeek = aopWeekKeyFromIso(shiftIsoDays(todayIso, -7));
  const twoWeeks = aopWeekKeyFromIso(shiftIsoDays(todayIso, -14));
  const thisMonth = aopMonthKeyFromIso(todayIso);
  const lastMonth = shiftMonthKey(thisMonth, -1);
  if (key === thisWeek) return 'This week';
  if (key === nextWeek) return 'Next week';
  if (key === lastWeek) return 'Last week';
  if (key === twoWeeks) return '2 weeks ago';
  if (key === thisMonth) return 'This month';
  if (key === lastMonth) return 'Last month';
  if (key.startsWith('M:')) return aopPeriodHint(key);
  const match = key.slice(2).match(/^(\d{4})-W(\d{2})$/i);
  return match ? `W${Number(match[2])}` : key;
}

export function aopWeekOptions(storedKeys: string[], todayIso = aopTodayIso()): AopPeriodOption[] {
  const writable = new Set(aopWritableKeys(todayIso));
  const preset = [
    aopWeekKeyFromIso(shiftIsoDays(todayIso, 7)),
    aopWeekKeyFromIso(todayIso),
    aopWeekKeyFromIso(shiftIsoDays(todayIso, -7)),
    aopWeekKeyFromIso(shiftIsoDays(todayIso, -14)),
  ];
  const extras = storedKeys
    .filter((key) => aopKindOf(key) === 'week' && !preset.includes(key))
    .sort()
    .reverse();
  return [...preset, ...extras].map((key) => ({
    key,
    kind: 'week' as const,
    label: aopPeriodLabel(key, todayIso),
    hint: aopPeriodHint(key),
    writable: writable.has(key),
  }));
}

export function aopMonthOptions(storedKeys: string[], todayIso = aopTodayIso()): AopPeriodOption[] {
  const writable = new Set(aopWritableKeys(todayIso));
  const thisMonth = aopMonthKeyFromIso(todayIso);
  const preset = [thisMonth, shiftMonthKey(thisMonth, -1)];
  const extras = storedKeys
    .filter((key) => aopKindOf(key) === 'month' && !preset.includes(key))
    .sort()
    .reverse();
  return [...preset, ...extras].map((key) => ({
    key,
    kind: 'month' as const,
    label: aopPeriodLabel(key, todayIso),
    hint: aopPeriodHint(key),
    writable: writable.has(key),
  }));
}

export function aopAddDestinations(todayIso = aopTodayIso()): AopPeriodOption[] {
  return aopWritableKeys(todayIso).map((key) => ({
    key,
    kind: aopKindOf(key),
    label: aopPeriodLabel(key, todayIso),
    hint: aopPeriodHint(key),
    writable: true,
  }));
}

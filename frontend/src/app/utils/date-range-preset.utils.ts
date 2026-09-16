export type DateRangePresetId = 'inception' | 'year' | 'fytd' | 'month' | 'week' | 'day';

/** Short URL values for `?period=` — stable user intent, not inferred from dates. */
export type DatePeriodUrlId = 'all' | 'ytd' | 'fytd' | 'mtd' | 'wtd' | 'last' | 'custom';

const PRESET_TO_URL: Record<DateRangePresetId, DatePeriodUrlId> = {
  inception: 'all',
  year: 'ytd',
  fytd: 'fytd',
  month: 'mtd',
  week: 'wtd',
  day: 'last',
};

const URL_TO_PRESET: Record<Exclude<DatePeriodUrlId, 'custom'>, DateRangePresetId> = {
  all: 'inception',
  ytd: 'year',
  fytd: 'fytd',
  mtd: 'month',
  wtd: 'week',
  last: 'day',
};

export function periodUrlFromPreset(id: DateRangePresetId | 'custom'): DatePeriodUrlId {
  if (id === 'custom') return 'custom';
  return PRESET_TO_URL[id];
}

export function presetFromPeriodUrl(raw: string | null | undefined): DateRangePresetId | 'custom' | null {
  if (!raw) return null;
  if (raw === 'custom') return 'custom';
  return URL_TO_PRESET[raw as Exclude<DatePeriodUrlId, 'custom'>] ?? null;
}

export interface DateRangeBounds {
  min: string;
  max: string;
}

export interface DateRangeValue {
  start: string;
  end: string;
}

export const DATE_RANGE_PRESETS: {
  id: DateRangePresetId;
  shortLabel: string;
  label: string;
}[] = [
  { id: 'inception', shortLabel: 'All', label: 'From inception' },
  { id: 'year', shortLabel: 'YTD', label: 'This year' },
  { id: 'fytd', shortLabel: 'FYTD', label: 'Financial year to date' },
  { id: 'month', shortLabel: 'MTD', label: 'This month' },
  { id: 'week', shortLabel: 'WTD', label: 'This week' },
  { id: 'day', shortLabel: 'Last', label: 'Last day' },
];

export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

/** Indian FY starts 1 April. Jan–Mar belong to the year that began the previous April. */
function financialYearStart(iso: string): string {
  const date = parseIsoDate(iso);
  const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${year}-04-01`;
}

function mondayOfWeek(iso: string): string {
  const date = parseIsoDate(iso);
  const day = date.getDay();
  const offset = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - offset);
  return toIsoDate(date);
}

export function clampIsoDate(iso: string, min: string, max: string): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

export function asOfDate(bounds: DateRangeBounds, today = new Date()): string {
  const todayIso = toIsoDate(today);
  if (bounds.max && todayIso > bounds.max) return bounds.max;
  if (bounds.min && todayIso < bounds.min) return bounds.min;
  return todayIso;
}

export function rangeForPreset(
  id: DateRangePresetId,
  bounds: DateRangeBounds,
  today = new Date()
): DateRangeValue {
  const asOf = asOfDate(bounds, today);
  let start = bounds.min;
  let end = bounds.max || asOf;

  switch (id) {
    case 'inception':
      start = bounds.min;
      end = bounds.max || asOf;
      break;
    case 'year':
      start = `${parseIsoDate(asOf).getFullYear()}-01-01`;
      end = asOf;
      break;
    case 'fytd':
      start = financialYearStart(asOf);
      end = asOf;
      break;
    case 'month': {
      const d = parseIsoDate(asOf);
      start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      end = asOf;
      break;
    }
    case 'week':
      start = mondayOfWeek(asOf);
      end = asOf;
      break;
    case 'day':
      start = asOf;
      end = asOf;
      break;
  }

  return {
    start: clampIsoDate(start, bounds.min, bounds.max || end),
    end: clampIsoDate(end, bounds.min, bounds.max || end),
  };
}

export function detectDateRangePreset(
  start: string,
  end: string,
  bounds: DateRangeBounds,
  today = new Date()
): DateRangePresetId | 'custom' {
  if (!start || !end) return 'custom';
  // Check widest ranges first so a full-history window is never mistaken for Last
  // when min===max (single-day statement) or asOf collapses.
  const order: DateRangePresetId[] = ['inception', 'year', 'fytd', 'month', 'week', 'day'];
  for (const id of order) {
    const range = rangeForPreset(id, bounds, today);
    if (range.start === start && range.end === end) return id;
  }
  return 'custom';
}

const ROUTES_WITH_YTD_DEFAULT = ['/analytics'];

/** Default date range when the URL has no from/to params (route-specific). */
export function defaultDateRangeForRoute(
  url: string,
  bounds: DateRangeBounds,
  today = new Date()
): DateRangeValue | null {
  if (ROUTES_WITH_YTD_DEFAULT.some((route) => url.includes(route))) {
    return rangeForPreset('year', bounds, today);
  }
  return null;
}

export function routeNeedsDefaultDateRange(
  url: string,
  hasFromParam: boolean,
  hasToParam: boolean
): boolean {
  return (
    ROUTES_WITH_YTD_DEFAULT.some((route) => url.includes(route)) && !hasFromParam && !hasToParam
  );
}

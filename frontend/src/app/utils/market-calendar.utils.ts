/** NSE equity / F&O full-day closures. Weekend holidays are omitted. */
const NSE_HOLIDAYS: Record<string, string> = {
  '2026-01-15': 'Municipal Corporation Election',
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Shri Ram Navami',
  '2026-03-31': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Id',
  '2026-06-26': 'Muharram',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali-Balipratipada',
  '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
  '2026-12-25': 'Christmas',
};

/** Special sessions on days the cash market would otherwise be shut. */
const NSE_MUHURAT = new Set(['2026-11-08']);

export type MarketSession = 'open' | 'closed';

export interface MarketDayInfo {
  day: number;
  iso: string;
  session: MarketSession;
  reason: string;
}

export function istTodayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function marketSessionForIso(iso: string): { session: MarketSession; reason: string } {
  if (NSE_MUHURAT.has(iso)) {
    return { session: 'open', reason: 'Muhurat trading' };
  }
  const holiday = NSE_HOLIDAYS[iso];
  if (holiday) {
    return { session: 'closed', reason: holiday };
  }
  const weekday = new Date(`${iso}T12:00:00`).getDay();
  if (weekday === 0 || weekday === 6) {
    return { session: 'closed', reason: 'Weekend' };
  }
  return { session: 'open', reason: 'Regular session' };
}

export function currentMonthMarketDays(): MarketDayInfo[] {
  const today = istTodayIso();
  const [year, month] = today.split('-').map(Number);
  const monthKey = today.slice(0, 7);
  const daysInMonth = new Date(year, month, 0).getDate();
  const days: MarketDayInfo[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${monthKey}-${String(day).padStart(2, '0')}`;
    days.push({ day, iso, ...marketSessionForIso(iso) });
  }
  return days;
}

export function addIsoDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Next cash-market session after `fromIso` (skips weekends and NSE holidays). */
export function nextOpenMarketIso(fromIso: string): string {
  let iso = addIsoDays(fromIso, 1);
  for (let i = 0; i < 21; i++) {
    if (marketSessionForIso(iso).session === 'open') return iso;
    iso = addIsoDays(iso, 1);
  }
  return addIsoDays(fromIso, 1);
}

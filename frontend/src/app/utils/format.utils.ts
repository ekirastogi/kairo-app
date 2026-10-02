export function formatCurrency(value: number): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatPrice(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function compactMagnitude(abs: number, divisor: number, suffix: string): string {
  const scaled = abs / divisor;
  const digits = scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits).replace(/\.?0+$/, '')}${suffix}`;
}

/** Unsigned compact P&L for heatmap cells; color conveys sign (e.g. 1.2L, 45.6K). */
export function formatCompactCurrency(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_00_00_000) return compactMagnitude(abs, 1_00_00_000, 'Cr');
  if (abs >= 1_00_000) return compactMagnitude(abs, 1_00_000, 'L');
  if (abs >= 1000) return compactMagnitude(abs, 1000, 'K');
  return String(Math.round(abs));
}

export function formatSignedCompactCurrency(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  return `${value > 0 ? '+' : '−'}${formatCompactCurrency(value)}`;
}

export function formatPct(value: number): string {
  return (value * 100).toFixed(2) + '%';
}

export function formatPctSigned(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function pnlClass(value: number): string {
  if (value > 0) return 'text-emerald-600';
  if (value < 0) return 'text-red-600';
  return 'text-slate-600';
}

export function pnlBadgeClass(value: number): string {
  if (value > 0) return 'bg-emerald-100 text-emerald-700';
  if (value < 0) return 'bg-red-100 text-red-700';
  return 'bg-slate-100 text-slate-600';
}

export function formatDate(iso: string): string {
  if (!iso) return '';
  const dateKey = iso.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? iso.slice(0, 10);
  if (!dateKey) return '';
  const d = new Date(dateKey + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

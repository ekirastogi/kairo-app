import { signal } from '@angular/core';

export type SortDir = 'asc' | 'desc';

const ASC_DEFAULT_COLUMNS = new Set([
  'stockName',
  'label',
  'symbol',
  'period',
  'name',
  'side',
  'status',
  'tradeType',
  'createdAt',
  'supportPct',
  'overallSignal',
  'buyDate',
  'letter',
  'sno',
]);

export function defaultSortDirection(column: string): SortDir {
  return ASC_DEFAULT_COLUMNS.has(column) ? 'asc' : 'desc';
}

export function compareSortValues(av: string | number, bv: string | number): number {
  if (typeof av === 'number' && typeof bv === 'number') {
    return av - bv;
  }
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
}

export function sortRows<T>(
  rows: T[],
  column: string,
  direction: SortDir,
  getValue: (row: T, column: string) => string | number
): T[] {
  if (!column || !rows.length) return rows;
  return [...rows].sort((a, b) => {
    const cmp = compareSortValues(getValue(a, column), getValue(b, column));
    return direction === 'asc' ? cmp : -cmp;
  });
}

/** Reusable column-header sort state for data tables (dashboard per-stock pattern). */
export class TableSortState {
  readonly column = signal('');
  readonly direction = signal<SortDir>('desc');

  constructor(defaultColumn: string, defaultDirection?: SortDir) {
    this.column.set(defaultColumn);
    this.direction.set(defaultDirection ?? defaultSortDirection(defaultColumn));
  }

  toggle(column: string, event?: Event): void {
    event?.stopPropagation();
    if (this.column() === column) {
      this.direction.update((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    this.column.set(column);
    this.direction.set(defaultSortDirection(column));
  }

  indicator(column: string): string {
    if (this.column() !== column) return '';
    return this.direction() === 'asc' ? '↑' : '↓';
  }

  isActive(column: string): boolean {
    return this.column() === column;
  }

  reset(column: string, direction?: SortDir): void {
    this.column.set(column);
    this.direction.set(direction ?? defaultSortDirection(column));
  }

  sort<T>(rows: T[], getValue: (row: T, column: string) => string | number): T[] {
    return sortRows(rows, this.column(), this.direction(), getValue);
  }
}

import { RegistryFinancialTable } from '../models/trading-journal.models';
import type { ScreenerSnapshot } from '../services/screener.service';

export function tickerFromScreenerUrl(url: string | undefined | null): string {
  if (!url?.trim()) return '';
  try {
    const path = new URL(url.trim(), 'https://www.screener.in').pathname;
    const match = path.match(/\/company\/([^/]+)/i);
    if (!match) return '';
    return decodeURIComponent(match[1]).toUpperCase().replace(/\.(NS|BO|BSE)$/i, '');
  } catch {
    return '';
  }
}

export function snapshotMatchesPage(
  snapshot: { symbol?: string; url?: string } | null | undefined,
  pageUrl: string
): boolean {
  const wanted = tickerFromScreenerUrl(pageUrl);
  if (!wanted || !snapshot) return false;
  const got = tickerFromScreenerUrl(snapshot.url) || (snapshot.symbol ?? '').trim().toUpperCase();
  return got === wanted;
}

function emptyTable(): RegistryFinancialTable {
  return { headers: [], rows: [] };
}

function parseNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/₹/g, '')
    .replace(/%/g, '')
    .replace(/\bCr\.?/gi, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!cleaned || cleaned === '-' || cleaned === '—') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function cellText(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function parseTopRatios(doc: Document): Record<string, string> {
  const out: Record<string, string> = {};
  doc.querySelectorAll('#top-ratios li').forEach((li) => {
    const name = cellText(li.querySelector('.name'));
    const value = cellText(li.querySelector('.value'));
    if (name) out[name] = value;
  });
  return out;
}

function parseRangesTable(doc: Document, title: string): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  doc.querySelectorAll('table.ranges-table').forEach((table) => {
    const heading = cellText(table.querySelector('th'));
    if (heading.toLowerCase() !== title.toLowerCase()) return;
    table.querySelectorAll('tr').forEach((tr, i) => {
      if (i === 0) return;
      const cells = tr.querySelectorAll('td');
      const key = cellText(cells[0]).replace(/:$/, '');
      if (key) out[key] = parseNumber(cellText(cells[1]));
    });
  });
  return out;
}

function parseSectionTable(doc: Document, sectionId: string): RegistryFinancialTable {
  const table = doc.querySelector(`#${sectionId} table.data-table`);
  if (!table) return emptyTable();
  const headers: string[] = [];
  table.querySelectorAll('thead th').forEach((th, i) => {
    if (i === 0) return;
    headers.push(cellText(th));
  });
  const rows: RegistryFinancialTable['rows'] = [];
  table.querySelectorAll('tbody tr').forEach((tr) => {
    const cells = [...tr.children].filter((el) => el.tagName === 'TD');
    const first = cells[0];
    if (!first) return;
    const label = cellText(first).replace(/\+$/, '').trim();
    if (!label) return;
    rows.push({ label, values: cells.slice(1).map((td) => cellText(td)) });
  });
  return { headers, rows };
}

function latestHolding(table: RegistryFinancialTable, label: string): number | undefined {
  const row = table.rows.find((r) => r.label.toLowerCase().startsWith(label.toLowerCase()));
  if (!row?.values.length) return undefined;
  for (let i = row.values.length - 1; i >= 0; i--) {
    const n = parseNumber(row.values[i]);
    if (n != null) return n;
  }
  return undefined;
}

function parseIsin(doc: Document, html: string): string | undefined {
  const nodes = doc.querySelectorAll('#top-ratios li, #company-info li, li');
  for (const li of Array.from(nodes)) {
    const label = cellText(li.querySelector('.name')).toUpperCase();
    const value = cellText(li.querySelector('.value, .nowrap')).toUpperCase();
    if (label === 'ISIN' && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value)) return value;
  }
  return html.toUpperCase().match(/\b(INE[A-Z0-9]{9}[0-9])\b/)?.[1];
}

export function parseScreenerHtml(html: string, url: string, fallbackName?: string): ScreenerSnapshot {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const ratios = parseTopRatios(doc);
  const sales = parseRangesTable(doc, 'Compounded Sales Growth');
  const profit = parseRangesTable(doc, 'Compounded Profit Growth');
  const cagr = parseRangesTable(doc, 'Stock Price CAGR');
  const quarterlyResults = parseSectionTable(doc, 'quarters');
  const profitLoss = parseSectionTable(doc, 'profit-loss');
  const balanceSheet = parseSectionTable(doc, 'balance-sheet');
  const cashFlow = parseSectionTable(doc, 'cash-flow');
  const shareholding = parseSectionTable(doc, 'quarterly-shp');
  const shp = shareholding.rows.length ? shareholding : parseSectionTable(doc, 'shareholding');
  const ticker = tickerFromScreenerUrl(url);
  const h1 = cellText(doc.querySelector('h1'));

  return {
    symbol: ticker,
    name: h1 || fallbackName || ticker,
    url,
    isin: parseIsin(doc, html),
    currentPrice: parseNumber(ratios['Current Price']),
    marketCap: parseNumber(ratios['Market Cap']),
    pe: parseNumber(ratios['Stock P/E']),
    bookValue: parseNumber(ratios['Book Value']),
    dividendYield: parseNumber(ratios['Dividend Yield']),
    roce: parseNumber(ratios['ROCE']),
    roe: parseNumber(ratios['ROE']),
    faceValue: parseNumber(ratios['Face Value']),
    highLow: ratios['High / Low'] || undefined,
    salesGrowth3y: sales['3 Years'],
    salesGrowth5y: sales['5 Years'],
    salesGrowth10y: sales['10 Years'],
    salesGrowthTtm: sales['TTM'],
    profitGrowth3y: profit['3 Years'],
    profitGrowth5y: profit['5 Years'],
    profitGrowth10y: profit['10 Years'],
    profitGrowthTtm: profit['TTM'],
    stockCagr1y: cagr['1 Year'],
    stockCagr3y: cagr['3 Years'],
    stockCagr5y: cagr['5 Years'],
    stockCagr10y: cagr['10 Years'],
    promoterHolding: latestHolding(shp, 'Promoters'),
    fiiHolding: latestHolding(shp, 'FIIs'),
    diiHolding: latestHolding(shp, 'DIIs'),
    publicHolding: latestHolding(shp, 'Public'),
    governmentHolding: latestHolding(shp, 'Government'),
    otherHolding: latestHolding(shp, 'Others'),
    quarterlyResults,
    profitLoss,
    balanceSheet,
    cashFlow,
    shareholding: shp,
    fetchedAt: Date.now(),
  };
}

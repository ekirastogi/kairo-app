import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import * as cheerio from 'npm:cheerio@1.0.0';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface FinancialTable {
  headers: string[];
  rows: Array<{ label: string; values: string[] }>;
}

export interface ScreenerSnapshot {
  symbol: string;
  name: string;
  url: string;
  currentPrice?: number;
  marketCap?: number;
  pe?: number;
  bookValue?: number;
  dividendYield?: number;
  roce?: number;
  roe?: number;
  faceValue?: number;
  highLow?: string;
  salesGrowth3y?: number;
  salesGrowth5y?: number;
  salesGrowth10y?: number;
  salesGrowthTtm?: number;
  profitGrowth3y?: number;
  profitGrowth5y?: number;
  profitGrowth10y?: number;
  profitGrowthTtm?: number;
  stockCagr1y?: number;
  stockCagr3y?: number;
  stockCagr5y?: number;
  stockCagr10y?: number;
  promoterHolding?: number;
  fiiHolding?: number;
  diiHolding?: number;
  publicHolding?: number;
  governmentHolding?: number;
  otherHolding?: number;
  quarterlyResults: FinancialTable;
  profitLoss: FinancialTable;
  balanceSheet: FinancialTable;
  cashFlow: FinancialTable;
  shareholding: FinancialTable;
  isin?: string;
  fetchedAt: number;
}

interface SearchHit {
  id?: number;
  name?: string;
  url?: string;
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

function text($: cheerio.CheerioAPI, el: unknown): string {
  return $(el as never)
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/json',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
  });
  if (!res.ok) {
    throw new Error(`Screener request failed (${res.status}) for ${url}`);
  }
  return res.text();
}

function isIsin(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value);
}

function tickerFromScreenerUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\/company\/([^/]+)/i);
    if (!match) return '';
    return decodeURIComponent(match[1]).toUpperCase().replace(/\.(NS|BO|BSE)$/i, '');
  } catch {
    return '';
  }
}

function normalizeScreenerUrl(raw: string): string {
  let value = raw.trim();
  if (!value) throw new Error('Screener page URL is required');
  if (value.startsWith('/')) value = `https://www.screener.in${value}`;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Enter a valid Screener.in company URL');
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'screener.in') {
    throw new Error('Use a www.screener.in company page URL');
  }
  if (!/\/company\//i.test(parsed.pathname)) {
    throw new Error('That is not a Screener company page. Open the stock on Screener and paste that URL.');
  }
  parsed.hash = '';
  return parsed.toString();
}

function parseIsin($: cheerio.CheerioAPI, html: string): string | undefined {
  let found: string | undefined;
  $('#top-ratios li, #company-info li, li').each((_, li) => {
    if (found) return;
    const label = $(li).find('.name').first().text().replace(/\s+/g, ' ').trim().toUpperCase();
    const value = $(li).find('.value, .nowrap').first().text().replace(/\s+/g, ' ').trim().toUpperCase();
    if (label === 'ISIN' && isIsin(value)) found = value;
  });
  if (found) return found;
  const match = html.toUpperCase().match(/\b(INE[A-Z0-9]{9}[0-9])\b/);
  return match?.[1];
}

function companyUrl(hit: SearchHit): { url: string; name?: string } | null {
  if (!hit.url) return null;
  const path = hit.url.startsWith('http') ? hit.url : `https://www.screener.in${hit.url}`;
  return { url: path, name: hit.name };
}

function urlMatchesTicker(url: string, ticker: string): boolean {
  const path = url.toUpperCase();
  const sym = ticker.toUpperCase();
  return path.includes(`/COMPANY/${sym}/`) || path.endsWith(`/COMPANY/${sym}`);
}

/** Legal suffixes stripped so "Hindustan Foods Limited" and "Hindustan Foods Ltd" compare equal. */
function nameTokens(value: string): string[] {
  return value
    .toUpperCase()
    .replace(/\b(LTD|LIMITED|INC|CORP|CO|COMPANY|PVT|PRIVATE)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function sameCompanyName(query: string, hitName: string): boolean {
  const wanted = nameTokens(query);
  const got = nameTokens(hitName);
  if (wanted.length < 2 || got.length !== wanted.length) return false;
  return wanted.every((token) => got.includes(token));
}

async function searchHits(query: string): Promise<SearchHit[]> {
  const body = await fetchText(`https://www.screener.in/api/company/search/?q=${encodeURIComponent(query)}`);
  try {
    const hits = JSON.parse(body) as SearchHit[];
    return Array.isArray(hits) ? hits : [];
  } catch {
    return [];
  }
}

/** Exchange slug only. A fuzzy first hit maps HINDUSTANFOODS to Hindustan Zinc. */
async function searchExactTicker(ticker: string): Promise<{ url: string; name?: string } | null> {
  const hits = await searchHits(ticker);
  const exact = hits.find((hit) => urlMatchesTicker(hit.url ?? '', ticker));
  return exact ? companyUrl(exact) : null;
}

async function searchExactName(name: string): Promise<{ url: string; name?: string } | null> {
  const hits = await searchHits(name);
  const exact = hits.find((hit) => sameCompanyName(name, hit.name ?? ''));
  return exact ? companyUrl(exact) : null;
}

/** Yahoo indexes ISINs. Screener does not, and name-derived symbols are not its tickers. */
async function tickerFromIsin(isin: string): Promise<string | null> {
  let body = '';
  try {
    body = await fetchText(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=6&newsCount=0`
    );
  } catch {
    return null;
  }
  let quotes: Array<{ symbol?: string; quoteType?: string }> = [];
  try {
    quotes = (JSON.parse(body) as { quotes?: Array<{ symbol?: string; quoteType?: string }> }).quotes ?? [];
  } catch {
    return null;
  }
  const equities = quotes.filter((quote) => quote.quoteType === 'EQUITY' && quote.symbol);
  const preferred = equities.find((quote) => /\.NS$/i.test(quote.symbol ?? '')) ?? equities[0];
  if (!preferred?.symbol) return null;
  return preferred.symbol.toUpperCase().replace(/\.(NS|BO|BSE)$/i, '');
}

async function resolveCompanyUrl(
  symbol: string,
  isin?: string,
  name?: string
): Promise<{ url: string; name?: string }> {
  const ticker = symbol && !isIsin(symbol) ? symbol : '';
  if (isin) {
    const fromIsin = await tickerFromIsin(isin);
    if (fromIsin) {
      const exact = await searchExactTicker(fromIsin);
      if (exact) return exact;
      return { url: `https://www.screener.in/company/${encodeURIComponent(fromIsin)}/consolidated/` };
    }
  }
  if (ticker) {
    const exact = await searchExactTicker(ticker);
    if (exact) return exact;
  }
  if (name) {
    const named = await searchExactName(name);
    if (named) return named;
  }
  if (ticker && !isin) {
    return { url: `https://www.screener.in/company/${encodeURIComponent(ticker)}/consolidated/` };
  }
  throw new Error(`No Screener page found for ${isin || name || symbol}`);
}

function parseTopRatios($: cheerio.CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};
  $('#top-ratios li').each((_, li) => {
    const name = $(li).find('.name').first().text().replace(/\s+/g, ' ').trim();
    const value = $(li).find('.value').first().text().replace(/\s+/g, ' ').trim();
    if (name) out[name] = value;
  });
  return out;
}

function parseRangesTable($: cheerio.CheerioAPI, title: string): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  $('table.ranges-table').each((_, table) => {
    const heading = $(table).find('th').first().text().replace(/\s+/g, ' ').trim();
    if (heading.toLowerCase() !== title.toLowerCase()) return;
    $(table)
      .find('tr')
      .each((i, tr) => {
        if (i === 0) return;
        const cells = $(tr).find('td');
        const key = $(cells[0]).text().replace(/\s+/g, ' ').trim().replace(/:$/, '');
        out[key] = parseNumber($(cells[1]).text());
      });
  });
  return out;
}

function parseSectionTable($: cheerio.CheerioAPI, sectionId: string): FinancialTable {
  const section = $(`#${sectionId}`);
  const table = section.find('table.data-table').first();
  const headers: string[] = [];
  table.find('thead th').each((i, th) => {
    if (i === 0) return;
    headers.push(text($, th));
  });
  const rows: FinancialTable['rows'] = [];
  table.find('tbody tr').each((_, tr) => {
    const cells = $(tr).children('td');
    const first = cells.get(0);
    if (!first) return;
    const label = text($, first).replace(/\+$/, '').trim();
    if (!label) return;
    const values: string[] = [];
    cells.slice(1).each((_, td) => {
      values.push(text($, td));
    });
    rows.push({ label, values });
  });
  return { headers, rows };
}

function latestHolding(table: FinancialTable, label: string): number | undefined {
  const row = table.rows.find((r) => r.label.toLowerCase().startsWith(label.toLowerCase()));
  if (!row?.values.length) return undefined;
  for (let i = row.values.length - 1; i >= 0; i--) {
    const n = parseNumber(row.values[i]);
    if (n != null) return n;
  }
  return undefined;
}

function parseScreenerHtml(html: string, url: string, symbol: string, fallbackName?: string): ScreenerSnapshot {
  const $ = cheerio.load(html);
  const ratios = parseTopRatios($);
  const sales = parseRangesTable($, 'Compounded Sales Growth');
  const profit = parseRangesTable($, 'Compounded Profit Growth');
  const cagr = parseRangesTable($, 'Stock Price CAGR');
  const quarterlyResults = parseSectionTable($, 'quarters');
  const profitLoss = parseSectionTable($, 'profit-loss');
  const balanceSheet = parseSectionTable($, 'balance-sheet');
  const cashFlow = parseSectionTable($, 'cash-flow');
  const shareholding = parseSectionTable($, 'quarterly-shp');
  const shp = shareholding.rows.length ? shareholding : parseSectionTable($, 'shareholding');

  const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const ticker = tickerFromScreenerUrl(url) || symbol;

  return {
    symbol: ticker,
    name: h1 || fallbackName || ticker || symbol,
    url,
    isin: parseIsin($, html),
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

async function fetchScreenerSnapshot(
  rawSymbol: string,
  rawIsin?: string,
  rawName?: string,
  rawPageUrl?: string
): Promise<ScreenerSnapshot> {
  const symbol = rawSymbol.trim().toUpperCase().replace(/\.(NS|BO|BSE)$/i, '');
  const isin = rawIsin?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') ?? '';
  const name = rawName?.trim() ?? '';
  const pageUrl = rawPageUrl?.trim() ?? '';
  if (pageUrl) {
    const url = normalizeScreenerUrl(pageUrl);
    const html = await fetchText(url);
    if (/page not found/i.test(html) || html.length < 2000) {
      throw new Error('That Screener URL did not return a company page');
    }
    return parseScreenerHtml(html, url, tickerFromScreenerUrl(url) || symbol, name || undefined);
  }
  if (!symbol && !isin) throw new Error('Symbol, ISIN, or Screener page URL is required');
  const ticker = symbol && !isIsin(symbol) ? symbol : '';
  const resolved = await resolveCompanyUrl(ticker, isin && isIsin(isin) ? isin : undefined, name || undefined);
  const html = await fetchText(resolved.url);
  if (/page not found/i.test(html) || html.length < 2000) {
    throw new Error(`No Screener page found for ${isin || symbol}`);
  }
  return parseScreenerHtml(html, resolved.url, ticker || symbol, resolved.name);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const symbol = String(body?.symbol ?? '').trim();
    const isin = String(body?.isin ?? '').trim();
    const name = String(body?.name ?? '').trim();
    const pageUrl = String(body?.pageUrl ?? body?.url ?? '').trim();
    if (!symbol && !isin && !pageUrl) {
      return new Response(JSON.stringify({ error: 'Symbol, ISIN, or Screener page URL is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const snapshot = await fetchScreenerSnapshot(symbol, isin || undefined, name || undefined, pageUrl || undefined);
    return new Response(JSON.stringify(snapshot), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Screener fetch failed';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

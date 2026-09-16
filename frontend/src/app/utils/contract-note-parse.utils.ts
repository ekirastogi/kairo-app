import {
  ContractNoteEquitySummary,
  ContractNoteFill,
  ParsedContractNote,
} from '../models/contract-note.models';
import { ChargeItem } from '../models/trade.models';
import { normalizeIsin } from './stock-identity.utils';

const ISIN_RE = /INE[A-Z0-9]{9}/g;

const CHARGE_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'Brokerage', re: /Taxable Value of Supply\s*\(Brokerage\)\s+(-?\d[\d,]*\.?\d*)/i },
  { label: 'Exchange Transaction Charges', re: /Exchange Transaction Charges\s+(-?\d[\d,]*\.?\d*)/i },
  { label: 'CGST', re: /CGST\s*\([^)]*\)\s+(-?\d[\d,]*\.?\d*)/i },
  { label: 'SGST', re: /SGST\s*\([^)]*\)\s+(-?\d[\d,]*\.?\d*)/i },
  { label: 'IGST', re: /IGST\s*\([^)]*\)\s+(-?\d[\d,]*\.?\d*)/i },
  { label: 'STT', re: /Securities Transaction Tax\s+(-?\d[\d,]*\.?\d*)/i },
  { label: 'SEBI Charges', re: /SEBI Turnover Fees\s+(-?\d[\d,]*\.?\d*)/i },
  { label: 'Stamp Duty', re: /Stamp Duty\s+(-?\d[\d,]*\.?\d*)/i },
  { label: 'IPFT Charges', re: /IPFT Charges\s+(-?\d[\d,]*\.?\d*)/i },
];

function parseAmount(raw: string): number {
  return Number(String(raw).replace(/,/g, '')) || 0;
}

function toIsoDate(ddmmyyyy: string): string | null {
  const m = ddmmyyyy.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function absQty(n: number): number {
  return Math.abs(n);
}

/**
 * Parse Groww equity contract-note plain text (after PDF decrypt + extract).
 */
export function parseContractNoteText(rawText: string): ParsedContractNote {
  const text = rawText.replace(/\u00a0/g, ' ');
  const flat = text.replace(/\s+/g, ' ').trim();

  const tradeDateMatch = flat.match(/Trade Date\s+(\d{2}-\d{2}-\d{4})/i);
  const tradeDate = tradeDateMatch ? toIsoDate(tradeDateMatch[1]) : null;
  if (!tradeDate) {
    throw new Error('Could not find Trade Date in this contract note.');
  }

  const clientCode =
    flat.match(/Unique Client Code\s+(\d+)/i)?.[1]?.trim() ||
    flat.match(/Trading\/Backoffice\s*Code\s+(\d+)/i)?.[1]?.trim() ||
    '';
  const clientName =
    flat.match(/Unique Client Code\s+\d+\s+Name\s+([A-Za-z][A-Za-z .'-]+?)(?:\s+Client GSTIN|\s+Mobile)/i)?.[1]?.trim() ||
    flat.match(/Dear\s+([A-Za-z][A-Za-z .'-]+),/i)?.[1]?.trim() ||
    '';
  const pan = flat.match(/\bPAN\s+([A-Z]{5}\d{4}[A-Z])\b/i)?.[1]?.toUpperCase() || '';
  const contractNoteNo = flat.match(/Contract Note no\.\s*([A-Z0-9/\-]+)/i)?.[1] || '';

  const equity = parseEquitySummary(flat);
  if (!equity.length) {
    throw new Error('No equity trades found in this contract note.');
  }

  const fills = parseAnnexureFills(text, equity);
  const charges = parseCharges(flat);
  const chargesTotal = charges.reduce((sum, item) => sum + item.amount, 0);
  const realisedPnL = equity.reduce((sum, row) => sum + row.netAmount, 0);

  return {
    clientCode,
    clientName,
    pan,
    tradeDate,
    contractNoteNo,
    equity,
    fills,
    charges,
    chargesTotal,
    realisedPnL,
  };
}

function parseEquitySummary(flat: string): ContractNoteEquitySummary[] {
  const cutMatchers = [/Annexure\s*A/i, /Pay In\s*\/\s*Pay Out/i, /Description Equity Future/i];
  let end = flat.length;
  for (const re of cutMatchers) {
    const idx = flat.search(re);
    if (idx >= 0 && idx < end) end = idx;
  }
  const equityRegion = flat.slice(0, end);
  const isins = [...equityRegion.matchAll(ISIN_RE)];
  const rows: ContractNoteEquitySummary[] = [];

  for (let i = 0; i < isins.length; i++) {
    const match = isins[i];
    const start = match.index ?? 0;
    const next = i + 1 < isins.length ? (isins[i + 1].index ?? equityRegion.length) : equityRegion.length;
    const chunk = equityRegion.slice(start, next).trim();
    const isin = normalizeIsin(match[0]);
    const afterIsin = chunk.slice(match[0].length).trim();
    const nums = [...afterIsin.matchAll(/-?\d[\d,]*\.?\d*/g)].map((m) => parseAmount(m[0]));
    if (nums.length < 12) continue;

    const fields = nums.slice(0, 12);
    const nameMatch = afterIsin.match(/^([A-Za-z0-9][A-Za-z0-9 .,&'/()-]*?)(?=\s+-?\d)/);
    const stockName = (nameMatch?.[1] || isin).replace(/\s+/g, ' ').trim();

    const [
      buyQuantity,
      buyWap,
      _buyBrokerage,
      _buyWapAfter,
      buyValueRaw,
      sellQuantity,
      sellWap,
      _sellBrokerage,
      _sellWapAfter,
      sellValueRaw,
      netQuantity,
      netAmount,
    ] = fields;

    rows.push({
      isin,
      stockName,
      buyQuantity: absQty(buyQuantity),
      buyWap,
      buyValue: Math.abs(buyValueRaw),
      sellQuantity: absQty(sellQuantity),
      sellWap,
      sellValue: Math.abs(sellValueRaw),
      netQuantity,
      netAmount,
    });
  }

  return rows;
}

function parseCharges(flat: string): ChargeItem[] {
  const start = flat.search(/Pay In\s*\/\s*Pay Out/i);
  const endMatch = flat.search(/Net Amount Receivable/i);
  const region =
    start >= 0 ? flat.slice(start, endMatch >= 0 ? endMatch : undefined) : flat;

  const items: ChargeItem[] = [];
  for (const { label, re } of CHARGE_PATTERNS) {
    const m = region.match(re);
    if (!m) continue;
    const amount = Math.abs(parseAmount(m[1]));
    if (amount > 0) items.push({ label, amount });
  }
  return items;
}

/**
 * Best-effort Annexure fill parse. Summary matching does not depend on this;
 * fills help preserve exchange/remark hints when present.
 */
function parseAnnexureFills(raw: string, equity: ContractNoteEquitySummary[]): ContractNoteFill[] {
  const byName = new Map<string, ContractNoteEquitySummary>();
  for (const row of equity) {
    byName.set(row.stockName.toLowerCase(), row);
    // short token: first two words
    const short = row.stockName.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
    byName.set(short, row);
  }

  const fills: ContractNoteFill[] = [];
  const annexure = raw.split(/Annexure\s*A/i)[1] ?? '';
  const lineRe =
    /(\d{2}:\d{2}:\d{2})\s+(.+?)\s+(NSE|BSE)\s+(B|S)\s+(-?\d[\d,]*(?:\.\d+)?)\s+(-?\d[\d,]*(?:\.\d+)?)/gi;

  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(annexure))) {
    const stockName = m[2].replace(/\s+/g, ' ').trim();
    const side = m[4].toUpperCase() as 'B' | 'S';
    const quantity = absQty(parseAmount(m[5]));
    const price = parseAmount(m[6]);
    const key = stockName.toLowerCase();
    let row =
      byName.get(key) ||
      [...byName.entries()].find(([name]) => key.includes(name) || name.includes(key.split(' ')[0]))?.[1];
    if (!row) {
      // try first word
      const first = stockName.split(/\s+/)[0]?.toLowerCase();
      row = first ? [...byName.entries()].find(([name]) => name.startsWith(first))?.[1] : undefined;
    }
    fills.push({
      isin: row?.isin ?? '',
      stockName: row?.stockName || stockName,
      side,
      quantity,
      price,
      exchange: m[3].toUpperCase(),
      remark: '',
    });
  }
  return fills;
}

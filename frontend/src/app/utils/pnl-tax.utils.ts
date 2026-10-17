import { DailyAnalyticsRow, Trade, TradeType } from '../models/trade.models';
import { nextOpenMarketIso } from './market-calendar.utils';
import { INTRADAY_TRADE_TYPES, effectiveTradeType } from './trade-type-filter.utils';

/** User-specified 30% slab for speculative / business income. */
export const INDIA_SLAB_RATE = 0.3;
/** Health and education cess on income-tax. */
export const INDIA_CESS_RATE = 0.04;
/** Effective rate on taxable intraday (speculative) and F&O business profit. */
export const INDIA_SLAB_TAX_RATE = INDIA_SLAB_RATE * (1 + INDIA_CESS_RATE);
export const INDIA_INTRADAY_TAX_RATE = INDIA_SLAB_TAX_RATE;

/** Listed equity STCG (STT paid) from 23 Jul 2024, plus cess. */
export const INDIA_STCG_RATE = 0.2 * (1 + INDIA_CESS_RATE);
/** Listed equity LTCG, plus cess. */
export const INDIA_LTCG_RATE = 0.125 * (1 + INDIA_CESS_RATE);
export const INDIA_LTCG_EXEMPTION = 1_25_000;
export const LTCG_HOLDING_DAYS = 365;

export type IndiaTaxHead = 'intraday' | 'btst' | 'stcg' | 'ltcg' | 'fno';

export interface SegmentPnL {
  profit: number;
  loss: number;
  net: number;
}

export interface PnLTaxBreakdown {
  intraday: SegmentPnL;
  delivery: SegmentPnL;
  btst: SegmentPnL;
  stcg: SegmentPnL;
  ltcg: SegmentPnL;
  fno: SegmentPnL;
  netPnL: number;
  taxIntraday: number;
  taxStcg: number;
  taxLtcg: number;
  taxFno: number;
  taxDelivery: number;
  tax: number;
  taxableStcg: number;
  ltcgExemptionUsed: number;
  taxableLtcg: number;
  pat: number;
  hasOutcomeSplit: boolean;
}

const EMPTY_SEGMENT: SegmentPnL = { profit: 0, loss: 0, net: 0 };

function emptyBreakdown(partial: Partial<PnLTaxBreakdown> = {}): PnLTaxBreakdown {
  return {
    intraday: { ...EMPTY_SEGMENT },
    delivery: { ...EMPTY_SEGMENT },
    btst: { ...EMPTY_SEGMENT },
    stcg: { ...EMPTY_SEGMENT },
    ltcg: { ...EMPTY_SEGMENT },
    fno: { ...EMPTY_SEGMENT },
    netPnL: 0,
    taxIntraday: 0,
    taxStcg: 0,
    taxLtcg: 0,
    taxFno: 0,
    taxDelivery: 0,
    tax: 0,
    taxableStcg: 0,
    ltcgExemptionUsed: 0,
    taxableLtcg: 0,
    pat: 0,
    hasOutcomeSplit: false,
    ...partial,
  };
}

function tradeNetPnL(trade: Trade, chargeRatio: number): number {
  if (trade.netPnL != null && Number.isFinite(trade.netPnL)) return trade.netPnL;
  const charges = trade.allocatedCharges ?? trade.sellValue * chargeRatio;
  return trade.realisedPnL - charges;
}

function addOutcome(segment: SegmentPnL, net: number): void {
  if (net > 0) segment.profit += net;
  else if (net < 0) segment.loss += net;
  segment.net += net;
}

function mergeSegments(a: SegmentPnL, b: SegmentPnL): SegmentPnL {
  return {
    profit: a.profit + b.profit,
    loss: a.loss + b.loss,
    net: a.net + b.net,
  };
}

function taxOnPositive(amount: number, rate: number): number {
  return amount > 0 ? amount * rate : 0;
}

function isIntradayType(type: TradeType): boolean {
  return INTRADAY_TRADE_TYPES.includes(type);
}

function isDeliveryType(type: TradeType): boolean {
  return type === 'delivery' || type === 'mtf';
}

/** Same-session square-off — speculative business income (s.43(5)). */
function isSpeculativeIntraday(trade: Trade, type: TradeType): boolean {
  if (type === 'intraday' || type === 'same_day') return true;
  if (trade.buyDate && trade.sellDate && trade.buyDate === trade.sellDate) return true;
  return (trade.holdingDays ?? 0) === 0 && type !== 'delivery' && type !== 'mtf';
}

/** Sold on the next cash-market session after buy — BTST, taxed as listed-equity STCG. */
export function isBtstTrade(trade: Trade): boolean {
  if (!trade.buyDate || !trade.sellDate) return (trade.holdingDays ?? 0) === 1;
  if (trade.buyDate >= trade.sellDate) return false;
  return nextOpenMarketIso(trade.buyDate) === trade.sellDate;
}

export function classifyIndiaTaxHead(trade: Trade): IndiaTaxHead | null {
  const type = effectiveTradeType(trade);
  if (type === 'fno') return 'fno';
  if (isSpeculativeIntraday(trade, type)) return 'intraday';
  if (!isDeliveryType(type)) return null;
  if ((trade.holdingDays ?? 0) >= LTCG_HOLDING_DAYS) return 'ltcg';
  if (isBtstTrade(trade)) return 'btst';
  return 'stcg';
}

/**
 * Intraday is speculative (slab). F&O is non-speculative business (slab) and is not
 * set off against speculative profit. BTST and other listed-equity STCG net together
 * at 20% + cess. LTCG uses 12.5% + cess after the ₹1.25L exemption.
 */
export function applyIndiaTradingTax(input: {
  intradayNet: number;
  btstNet?: number;
  stcgNet?: number;
  deliveryStcgNet?: number;
  deliveryLtcgNet: number;
  fnoNet?: number;
}): Pick<
  PnLTaxBreakdown,
  | 'taxIntraday'
  | 'taxStcg'
  | 'taxLtcg'
  | 'taxFno'
  | 'taxDelivery'
  | 'tax'
  | 'taxableStcg'
  | 'ltcgExemptionUsed'
  | 'taxableLtcg'
> {
  const stcgCombined =
    input.deliveryStcgNet ?? (input.btstNet ?? 0) + (input.stcgNet ?? 0);
  const taxIntraday = taxOnPositive(input.intradayNet, INDIA_SLAB_TAX_RATE);
  const taxFno = taxOnPositive(input.fnoNet ?? 0, INDIA_SLAB_TAX_RATE);
  const taxableStcg = Math.max(0, stcgCombined);
  const taxStcg = taxOnPositive(taxableStcg, INDIA_STCG_RATE);
  const ltcgExemptionUsed = Math.max(
    0,
    Math.min(INDIA_LTCG_EXEMPTION, Math.max(0, input.deliveryLtcgNet))
  );
  const taxableLtcg = Math.max(0, input.deliveryLtcgNet - INDIA_LTCG_EXEMPTION);
  const taxLtcg = taxOnPositive(taxableLtcg, INDIA_LTCG_RATE);
  const taxDelivery = taxStcg + taxLtcg;
  return {
    taxIntraday,
    taxStcg,
    taxLtcg,
    taxFno,
    taxDelivery,
    tax: taxIntraday + taxDelivery + taxFno,
    taxableStcg,
    ltcgExemptionUsed,
    taxableLtcg,
  };
}

export function buildPnLTaxBreakdown(
  trades: Trade[],
  chargeRatio = 0,
  dailyRows: DailyAnalyticsRow[] = []
): PnLTaxBreakdown {
  if (trades.length) {
    const intraday: SegmentPnL = { ...EMPTY_SEGMENT };
    const btst: SegmentPnL = { ...EMPTY_SEGMENT };
    const stcg: SegmentPnL = { ...EMPTY_SEGMENT };
    const ltcg: SegmentPnL = { ...EMPTY_SEGMENT };
    const fno: SegmentPnL = { ...EMPTY_SEGMENT };

    for (const trade of trades) {
      const net = tradeNetPnL(trade, chargeRatio);
      const head = classifyIndiaTaxHead(trade);
      if (head === 'intraday') addOutcome(intraday, net);
      else if (head === 'btst') addOutcome(btst, net);
      else if (head === 'stcg') addOutcome(stcg, net);
      else if (head === 'ltcg') addOutcome(ltcg, net);
      else if (head === 'fno') addOutcome(fno, net);
    }

    const delivery = mergeSegments(mergeSegments(btst, stcg), ltcg);
    const taxes = applyIndiaTradingTax({
      intradayNet: intraday.net,
      btstNet: btst.net,
      stcgNet: stcg.net,
      deliveryLtcgNet: ltcg.net,
      fnoNet: fno.net,
    });
    const netPnL = intraday.net + delivery.net + fno.net;
    return {
      intraday,
      delivery,
      btst,
      stcg,
      ltcg,
      fno,
      netPnL,
      ...taxes,
      pat: netPnL - taxes.tax,
      hasOutcomeSplit: true,
    };
  }

  if (!dailyRows.length) return emptyBreakdown();

  const intraday: SegmentPnL = { ...EMPTY_SEGMENT };
  const delivery: SegmentPnL = { ...EMPTY_SEGMENT };
  const fno: SegmentPnL = { ...EMPTY_SEGMENT };
  for (const row of dailyRows) {
    if (isIntradayType(row.tradeType)) intraday.net += row.netPnL;
    else if (isDeliveryType(row.tradeType)) delivery.net += row.netPnL;
    else if (row.tradeType === 'fno') fno.net += row.netPnL;
  }

  const taxes = applyIndiaTradingTax({
    intradayNet: intraday.net,
    deliveryStcgNet: delivery.net,
    deliveryLtcgNet: 0,
    fnoNet: fno.net,
  });
  const netPnL = intraday.net + delivery.net + fno.net;
  return emptyBreakdown({
    intraday,
    delivery,
    stcg: { ...delivery },
    fno,
    netPnL,
    ...taxes,
    pat: netPnL - taxes.tax,
    hasOutcomeSplit: false,
  });
}

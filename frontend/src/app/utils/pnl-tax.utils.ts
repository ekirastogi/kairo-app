import { DailyAnalyticsRow, Trade, TradeType } from '../models/trade.models';
import { INTRADAY_TRADE_TYPES, effectiveTradeType } from './trade-type-filter.utils';

/** User-specified 30% slab for speculative / business income. */
export const INDIA_SLAB_RATE = 0.3;
/** Health and education cess on income-tax. */
export const INDIA_CESS_RATE = 0.04;
/** Effective rate on taxable intraday (speculative) profit. */
export const INDIA_INTRADAY_TAX_RATE = INDIA_SLAB_RATE * (1 + INDIA_CESS_RATE);

/** Listed equity STCG (STT paid) from 23 Jul 2024, plus cess. */
export const INDIA_STCG_RATE = 0.2 * (1 + INDIA_CESS_RATE);
/** Listed equity LTCG, plus cess. */
export const INDIA_LTCG_RATE = 0.125 * (1 + INDIA_CESS_RATE);
export const INDIA_LTCG_EXEMPTION = 1_25_000;
export const LTCG_HOLDING_DAYS = 365;

export interface SegmentPnL {
  profit: number;
  loss: number;
  net: number;
}

export interface PnLTaxBreakdown {
  intraday: SegmentPnL;
  delivery: SegmentPnL;
  netPnL: number;
  /** Listed-equity delivery split when trade-level holding days are available. */
  deliveryStcgNet: number;
  deliveryLtcgNet: number;
  taxIntraday: number;
  taxDelivery: number;
  tax: number;
  pat: number;
  hasOutcomeSplit: boolean;
}

const EMPTY_SEGMENT: SegmentPnL = { profit: 0, loss: 0, net: 0 };

function emptyBreakdown(partial: Partial<PnLTaxBreakdown> = {}): PnLTaxBreakdown {
  return {
    intraday: { ...EMPTY_SEGMENT },
    delivery: { ...EMPTY_SEGMENT },
    netPnL: 0,
    deliveryStcgNet: 0,
    deliveryLtcgNet: 0,
    taxIntraday: 0,
    taxDelivery: 0,
    tax: 0,
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

function isIntradayType(type: TradeType): boolean {
  return INTRADAY_TRADE_TYPES.includes(type);
}

function isDeliveryType(type: TradeType): boolean {
  return type === 'delivery' || type === 'mtf';
}

function taxOnPositive(amount: number, rate: number): number {
  return amount > 0 ? amount * rate : 0;
}

/**
 * Intraday (incl. same-day) is speculative business income at the 30% slab + cess.
 * Delivery STCG and LTCG cannot be set off against speculative profit, and vice versa.
 * LTCG exemption of ₹1.25L applies to listed-equity long-term net only.
 */
export function applyIndiaTradingTax(input: {
  intradayNet: number;
  deliveryStcgNet: number;
  deliveryLtcgNet: number;
}): Pick<PnLTaxBreakdown, 'taxIntraday' | 'taxDelivery' | 'tax'> {
  const taxIntraday = taxOnPositive(input.intradayNet, INDIA_INTRADAY_TAX_RATE);
  const stcgTax = taxOnPositive(input.deliveryStcgNet, INDIA_STCG_RATE);
  const ltcgTaxable = Math.max(0, input.deliveryLtcgNet - INDIA_LTCG_EXEMPTION);
  const ltcgTax = taxOnPositive(ltcgTaxable, INDIA_LTCG_RATE);
  const taxDelivery = stcgTax + ltcgTax;
  return {
    taxIntraday,
    taxDelivery,
    tax: taxIntraday + taxDelivery,
  };
}

export function buildPnLTaxBreakdown(
  trades: Trade[],
  chargeRatio = 0,
  dailyRows: DailyAnalyticsRow[] = []
): PnLTaxBreakdown {
  if (trades.length) {
    const intraday: SegmentPnL = { ...EMPTY_SEGMENT };
    const delivery: SegmentPnL = { ...EMPTY_SEGMENT };
    let deliveryStcgNet = 0;
    let deliveryLtcgNet = 0;

    for (const trade of trades) {
      const type = effectiveTradeType(trade);
      const net = tradeNetPnL(trade, chargeRatio);
      if (isIntradayType(type)) {
        addOutcome(intraday, net);
      } else if (isDeliveryType(type)) {
        addOutcome(delivery, net);
        if ((trade.holdingDays ?? 0) >= LTCG_HOLDING_DAYS) deliveryLtcgNet += net;
        else deliveryStcgNet += net;
      }
    }

    const taxes = applyIndiaTradingTax({
      intradayNet: intraday.net,
      deliveryStcgNet,
      deliveryLtcgNet,
    });
    const netPnL = intraday.net + delivery.net;
    return {
      intraday,
      delivery,
      netPnL,
      deliveryStcgNet,
      deliveryLtcgNet,
      ...taxes,
      pat: netPnL - taxes.tax,
      hasOutcomeSplit: true,
    };
  }

  if (!dailyRows.length) return emptyBreakdown();

  const intraday: SegmentPnL = { ...EMPTY_SEGMENT };
  const delivery: SegmentPnL = { ...EMPTY_SEGMENT };
  for (const row of dailyRows) {
    if (isIntradayType(row.tradeType)) intraday.net += row.netPnL;
    else if (isDeliveryType(row.tradeType)) delivery.net += row.netPnL;
  }

  const taxes = applyIndiaTradingTax({
    intradayNet: intraday.net,
    deliveryStcgNet: delivery.net,
    deliveryLtcgNet: 0,
  });
  const netPnL = intraday.net + delivery.net;
  return {
    intraday,
    delivery,
    netPnL,
    deliveryStcgNet: delivery.net,
    deliveryLtcgNet: 0,
    ...taxes,
    pat: netPnL - taxes.tax,
    hasOutcomeSplit: false,
  };
}

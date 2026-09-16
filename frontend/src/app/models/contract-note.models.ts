import { ChargeItem, Trade, UnrealisedHolding, UnrealisedLot } from './trade.models';

/** One equity ISIN row from the contract-note summary table. */
export interface ContractNoteEquitySummary {
  isin: string;
  stockName: string;
  buyQuantity: number;
  buyWap: number;
  buyValue: number;
  sellQuantity: number;
  sellWap: number;
  sellValue: number;
  netQuantity: number;
  netAmount: number;
}

export interface ContractNoteFill {
  isin: string;
  stockName: string;
  side: 'B' | 'S';
  quantity: number;
  price: number;
  exchange: string;
  remark: string;
}

export interface ParsedContractNote {
  clientCode: string;
  clientName: string;
  pan: string;
  tradeDate: string;
  contractNoteNo: string;
  equity: ContractNoteEquitySummary[];
  fills: ContractNoteFill[];
  charges: ChargeItem[];
  chargesTotal: number;
  /** Sum of per-ISIN net amounts (before levies). */
  realisedPnL: number;
}

export interface OpenInventoryLot {
  stockName: string;
  isin: string;
  quantity: number;
  buyDate: string;
  buyPrice: number;
  buyValue: number;
}

export interface ContractNoteMatchResult {
  trades: Trade[];
  openLots: OpenInventoryLot[];
  holdings: UnrealisedHolding[];
  unrealisedLots: UnrealisedLot[];
}

import { Injectable, inject } from '@angular/core';
import { Observable, map, of, switchMap } from 'rxjs';
import {
  DayTradeSummary,
  ExecutionLeg,
  PlannedEntryLeg,
  PlannedTrade,
  PlannedTradeTarget,
  TradeDirection,
  TradeExecutionInput,
  TradeExecutionStatus,
  TradePlanSource,
  TradeSegment,
} from '../models/trading-journal.models';
import { AuthService } from './auth.service';
import { objectToSnake, numField, rowToCamel, SupabaseService } from './supabase.service';
import { addDaysIso, previousTradingDayOnOrBefore } from '../utils/trade-plan-date.utils';

export interface CreatePlannedTradeInput {
  symbol: string;
  stockName?: string;
  tradeDate?: string;
  segment: TradeSegment;
  direction: TradeDirection;
  quantity: number;
  cmp?: number;
  entryPrice: number;
  targetPrice: number;
  stopLoss?: number;
  entryLegs?: PlannedEntryLeg[];
  /** Partial exit ladder. When set, targetPrice is derived from its weighted average. */
  targets?: PlannedTradeTarget[];
  source?: TradePlanSource;
  notes?: string;
  carriedFromDate?: string;
  /** When 'open', trade goes to the date-independent open pool. */
  pool?: 'dated' | 'open';
  momentumId?: string;
}

export interface CopyUnfinishedResult {
  copied: number;
  skippedDuplicates: number;
  sourceDate: string;
}

/** Sentinel trade_date for trades in the date-independent open pool. */
export const OPEN_TRADE_POOL_DATE = '__open__';
export const OPEN_TRADES_PAGE_SIZE = 20;

export interface OpenTradesPage {
  trades: PlannedTrade[];
  total: number;
  page: number;
  pageSize: number;
}

type PlannedTradePayload = {
  source?: TradePlanSource;
  estimatedStopLossPnL?: number | null;
  executedQuantity?: number | null;
  executedBuyPrice?: number | null;
  executedSellPrice?: number | null;
  buyLegs?: ExecutionLeg[] | null;
  sellLegs?: ExecutionLeg[] | null;
  entryLegs?: PlannedEntryLeg[] | null;
  targets?: PlannedTradeTarget[] | null;
  updatedAt?: number;
  carriedFromDate?: string;
  openedFromDate?: string;
};

function legsFromLegacy(
  quantity?: number,
  buyPrice?: number,
  sellPrice?: number
): { buyLegs?: ExecutionLeg[]; sellLegs?: ExecutionLeg[] } {
  if (!quantity || buyPrice == null || sellPrice == null) return {};
  return {
    buyLegs: [{ quantity, price: buyPrice }],
    sellLegs: [{ quantity, price: sellPrice }],
  };
}

function rowToPlannedTrade(row: Record<string, unknown>): PlannedTrade {
  const camel = rowToCamel<Record<string, unknown>>(row);
  const payload = (camel['payload'] as PlannedTradePayload | undefined) ?? {};
  const executedQuantity = payload.executedQuantity ?? undefined;
  const executedBuyPrice = payload.executedBuyPrice ?? undefined;
  const executedSellPrice = payload.executedSellPrice ?? undefined;
  const legacyLegs = legsFromLegacy(executedQuantity, executedBuyPrice, executedSellPrice);
  const buyLegs = payload.buyLegs?.length ? payload.buyLegs : legacyLegs.buyLegs;
  const sellLegs = payload.sellLegs?.length ? payload.sellLegs : legacyLegs.sellLegs;
  const quantity = Number(camel['quantity'] ?? 0);
  const entryPrice = Number(camel['entryPrice'] ?? 0);
  const entryLegs = payload.entryLegs?.length
    ? payload.entryLegs
    : quantity > 0 && entryPrice > 0
      ? [{ quantity, price: entryPrice }]
      : undefined;
  return {
    id: String(camel['id'] ?? ''),
    symbol: String(camel['symbol'] ?? ''),
    stockName: camel['stockName'] as string | undefined,
    tradeDate: String(camel['tradeDate'] ?? ''),
    segment: camel['segment'] as TradeSegment,
    direction: camel['direction'] as TradeDirection,
    quantity,
    cmp: camel['cmp'] as number | undefined,
    entryPrice,
    targetPrice: Number(camel['targetPrice'] ?? 0),
    stopLoss: camel['stopLoss'] as number | undefined,
    entryLegs,
    targets: payload.targets?.length ? payload.targets : undefined,
    source: payload.source ?? 'manual',
    status: (camel['status'] as TradeExecutionStatus) ?? 'planned',
    estimatedPnL: numField(camel, 'estimatedPnL', 'estimatedPnl'),
    estimatedStopLossPnL: payload.estimatedStopLossPnL ?? undefined,
    realizedPnL: (camel['realizedPnL'] ?? camel['realizedPnl']) as number | undefined,
    executedQuantity,
    executedBuyPrice,
    executedSellPrice,
    buyLegs,
    sellLegs,
    notes: camel['notes'] as string | undefined,
    openedFromDate: payload.openedFromDate,
    createdAt: Number(camel['createdAt'] ?? 0),
    updatedAt: payload.updatedAt ?? Number(camel['createdAt'] ?? 0),
  };
}

@Injectable({ providedIn: 'root' })
export class TradePlanService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  watchForDate(tradeDate: string): Observable<PlannedTrade[]> {
    return this.auth.user$.pipe(
      switchMap((user) => {
        if (!user) return of([]);
        return this.supabase.watchTable(
          `planned_trades-${tradeDate}`,
          () => this.fetchForDate(tradeDate),
          undefined,
          'planned_trades'
        );
      })
    );
  }

  watchOpenTrades(page: number, pageSize = OPEN_TRADES_PAGE_SIZE): Observable<OpenTradesPage> {
    return this.auth.user$.pipe(
      switchMap((user) => {
        if (!user) return of({ trades: [], total: 0, page, pageSize });
        return this.supabase.watchTable(
          `planned_trades-open-${page}`,
          () => this.fetchOpenTradesPage(page, pageSize),
          undefined,
          'planned_trades'
        );
      })
    );
  }

  private async fetchForDate(tradeDate: string): Promise<PlannedTrade[]> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];
    const { data, error } = await this.supabase.client
      .from('planned_trades')
      .select('*')
      .eq('user_id', uid)
      .eq('trade_date', tradeDate)
      .neq('status', 'open')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => rowToPlannedTrade(row));
  }

  async fetchOpenTradesPage(page: number, pageSize = OPEN_TRADES_PAGE_SIZE): Promise<OpenTradesPage> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return { trades: [], total: 0, page, pageSize };
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, count, error } = await this.supabase.client
      .from('planned_trades')
      .select('*', { count: 'exact' })
      .eq('user_id', uid)
      .eq('status', 'open')
      .eq('trade_date', OPEN_TRADE_POOL_DATE)
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return {
      trades: (data ?? []).map((row) => rowToPlannedTrade(row)),
      total: count ?? 0,
      page,
      pageSize,
    };
  }

  watchInMonth(year: number, month: number): Observable<PlannedTrade[]> {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDay = new Date(year, month, 0).getDate();
    const end = `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    return this.auth.user$.pipe(
      switchMap((user) => {
        if (!user) return of([]);
        return this.supabase.watchTable(
          `planned_trades-${year}-${month}`,
          () => this.fetchInRange(start, end),
          undefined,
          'planned_trades'
        );
      })
    );
  }

  private async fetchInRange(start: string, end: string): Promise<PlannedTrade[]> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];
    const { data, error } = await this.supabase.client
      .from('planned_trades')
      .select('*')
      .eq('user_id', uid)
      .gte('trade_date', start)
      .lte('trade_date', end)
      .order('trade_date', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => rowToPlannedTrade(row));
  }

  async fetchForSymbol(symbol: string): Promise<PlannedTrade[]> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];
    const { data, error } = await this.supabase.client
      .from('planned_trades')
      .select('*')
      .eq('user_id', uid)
      .eq('symbol', symbol.trim().toUpperCase())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => rowToPlannedTrade(row));
  }

  daySummariesForMonth$(year: number, month: number): Observable<DayTradeSummary[]> {
    return this.watchInMonth(year, month).pipe(map((trades) => this.summarizeByDay(trades)));
  }

  summarizeByDay(trades: PlannedTrade[]): DayTradeSummary[] {
    const byDate = new Map<string, PlannedTrade[]>();
    for (const t of trades) {
      const list = byDate.get(t.tradeDate) ?? [];
      list.push(t);
      byDate.set(t.tradeDate, list);
    }
    return [...byDate.entries()]
      .map(([tradeDate, dayTrades]) => this.summarizeDay(tradeDate, dayTrades))
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  }

  summarizeDay(tradeDate: string, trades: PlannedTrade[]): DayTradeSummary {
    let estimatedPnL = 0;
    let estimatedStopLossPnL = 0;
    let realizedPnL = 0;
    let executedCount = 0;
    let skippedCount = 0;
    for (const t of trades) {
      estimatedPnL += t.estimatedPnL ?? 0;
      const slPnL = TradePlanService.stopLossPnL(t);
      if (slPnL != null) estimatedStopLossPnL += slPnL;
      if (t.status === 'executed') {
        executedCount++;
        realizedPnL += t.realizedPnL ?? 0;
      } else if (t.status === 'skipped' || t.status === 'open') {
        skippedCount++;
      }
    }
    return {
      tradeDate,
      tradeCount: trades.length,
      estimatedPnL,
      estimatedStopLossPnL,
      realizedPnL,
      executedCount,
      skippedCount,
    };
  }

  static estimatePnL(
    segment: TradeSegment,
    direction: TradeDirection,
    quantity: number,
    entryPrice: number,
    targetPrice: number
  ): number {
    if (!quantity || !entryPrice || !targetPrice) return 0;
    const diff = targetPrice - entryPrice;
    if (segment === 'intraday' && direction === 'short') {
      return (entryPrice - targetPrice) * quantity;
    }
    return diff * quantity;
  }

  static stopLossPnL(
    trade: Pick<PlannedTrade, 'segment' | 'direction' | 'quantity' | 'entryPrice' | 'stopLoss' | 'estimatedStopLossPnL'>
  ): number | null {
    if (trade.estimatedStopLossPnL != null) return trade.estimatedStopLossPnL;
    if (!trade.stopLoss) return null;
    return TradePlanService.estimatePnL(
      trade.segment,
      trade.direction,
      trade.quantity,
      trade.entryPrice,
      trade.stopLoss
    );
  }

  static stopLossPctVsEntry(
    entry: number,
    stopLoss: number | undefined,
    segment: TradeSegment,
    direction: TradeDirection
  ): number | null {
    if (!entry || !stopLoss) return null;
    return TradePlanService.exitPctVsEntry(entry, stopLoss, segment, direction);
  }

  static realizedPnLFromPrices(quantity: number, buyPrice: number, sellPrice: number): number {
    if (!quantity || !buyPrice || !sellPrice) return 0;
    return (sellPrice - buyPrice) * quantity;
  }

  static legTotalQty(legs: ExecutionLeg[]): number {
    return legs.reduce((sum, leg) => sum + leg.quantity, 0);
  }

  static weightedAvgPrice(legs: ExecutionLeg[]): number {
    const qty = TradePlanService.legTotalQty(legs);
    if (!qty) return 0;
    return legs.reduce((sum, leg) => sum + leg.quantity * leg.price, 0) / qty;
  }

  static legTotalValue(legs: ExecutionLeg[]): number {
    return legs.reduce((sum, leg) => sum + leg.quantity * leg.price, 0);
  }

  static realizedPnLFromLegs(buyLegs: ExecutionLeg[], sellLegs: ExecutionLeg[]): number {
    return TradePlanService.legTotalValue(sellLegs) - TradePlanService.legTotalValue(buyLegs);
  }

  /** Drops incomplete rows from a target ladder. */
  static sanitizeTargets(targets: PlannedTradeTarget[] | undefined): PlannedTradeTarget[] {
    return (targets ?? []).filter((target) => target.quantity > 0 && target.price > 0);
  }

  /** The exit ladder for a trade, falling back to a single exit at targetPrice. */
  static resolveTargets(
    trade: Pick<PlannedTrade, 'targets' | 'targetPrice' | 'quantity'>
  ): PlannedTradeTarget[] {
    const targets = TradePlanService.sanitizeTargets(trade.targets);
    if (targets.length) return targets;
    if (trade.quantity > 0 && trade.targetPrice > 0) {
      return [{ quantity: trade.quantity, price: trade.targetPrice }];
    }
    return [];
  }

  static resolveEntryLegs(
    legs: PlannedEntryLeg[] | undefined,
    entryPrice: number,
    quantity: number
  ): PlannedEntryLeg[] {
    if (legs?.length) return legs;
    if (quantity > 0 && entryPrice > 0) return [{ quantity, price: entryPrice }];
    return [];
  }

  static estimatePnLFromEntryLegs(
    segment: TradeSegment,
    direction: TradeDirection,
    legs: PlannedEntryLeg[],
    exitPrice: number
  ): number {
    return legs.reduce(
      (sum, leg) =>
        sum + TradePlanService.estimatePnL(segment, direction, leg.quantity, leg.price, exitPrice),
      0
    );
  }

  static validatePlannedEntryLegs(
    legs: PlannedEntryLeg[],
    segment: TradeSegment,
    direction: TradeDirection
  ): string | null {
    if (!legs.length) return 'Add at least one entry level';
    for (const leg of legs) {
      if (!leg.quantity || leg.quantity <= 0 || !leg.price || leg.price <= 0) {
        return 'Each entry needs a positive quantity and price';
      }
    }
    const initial = legs[0].price;
    const isShort = segment === 'intraday' && direction === 'short';
    for (let i = 1; i < legs.length; i++) {
      const price = legs[i].price;
      if (isShort && price <= initial) {
        return 'Short scale-ins should be at higher prices than the initial entry';
      }
      if (!isShort && price >= initial) {
        return 'Long scale-ins should be at lower prices than the initial entry';
      }
    }
    return null;
  }

  static entryLegSummary(
    legs: PlannedEntryLeg[],
    segment: TradeSegment,
    direction: TradeDirection,
    targetPrice: number,
    stopLoss?: number
  ): {
    totalQuantity: number;
    avgEntryPrice: number;
    estimatedPnL: number;
    estimatedStopLossPnL: number | null;
  } {
    const totalQuantity = TradePlanService.legTotalQty(legs);
    const avgEntryPrice = TradePlanService.weightedAvgPrice(legs);
    const estimatedPnL = TradePlanService.estimatePnLFromEntryLegs(
      segment,
      direction,
      legs,
      targetPrice
    );
    const estimatedStopLossPnL = stopLoss
      ? TradePlanService.estimatePnLFromEntryLegs(segment, direction, legs, stopLoss)
      : null;
    return { totalQuantity, avgEntryPrice, estimatedPnL, estimatedStopLossPnL };
  }

  static validateExecutionLegs(buyLegs: ExecutionLeg[], sellLegs: ExecutionLeg[]): string | null {
    if (!buyLegs.length || !sellLegs.length) {
      return 'Add at least one buy and one sell entry';
    }
    for (const leg of [...buyLegs, ...sellLegs]) {
      if (!leg.quantity || leg.quantity <= 0 || !leg.price || leg.price <= 0) {
        return 'Each entry needs a positive quantity and price';
      }
    }
    const buyQty = TradePlanService.legTotalQty(buyLegs);
    const sellQty = TradePlanService.legTotalQty(sellLegs);
    if (buyQty !== sellQty) {
      return `Buy quantity (${buyQty}) must match sell quantity (${sellQty})`;
    }
    return null;
  }

  static executionSummary(trade: Pick<PlannedTrade, 'buyLegs' | 'sellLegs' | 'executedQuantity' | 'executedBuyPrice' | 'executedSellPrice' | 'realizedPnL'>): {
    buyLegs: ExecutionLeg[];
    sellLegs: ExecutionLeg[];
    quantity: number;
    avgBuyPrice: number;
    avgSellPrice: number;
    realizedPnL: number;
  } | null {
    const buyLegs = trade.buyLegs ?? [];
    const sellLegs = trade.sellLegs ?? [];
    if (!buyLegs.length || !sellLegs.length) {
      if (trade.executedQuantity && trade.executedBuyPrice != null && trade.executedSellPrice != null) {
        const buy = [{ quantity: trade.executedQuantity, price: trade.executedBuyPrice }];
        const sell = [{ quantity: trade.executedQuantity, price: trade.executedSellPrice }];
        return {
          buyLegs: buy,
          sellLegs: sell,
          quantity: trade.executedQuantity,
          avgBuyPrice: trade.executedBuyPrice,
          avgSellPrice: trade.executedSellPrice,
          realizedPnL: trade.realizedPnL ?? TradePlanService.realizedPnLFromLegs(buy, sell),
        };
      }
      return null;
    }
    const quantity = TradePlanService.legTotalQty(buyLegs);
    return {
      buyLegs,
      sellLegs,
      quantity,
      avgBuyPrice: TradePlanService.weightedAvgPrice(buyLegs),
      avgSellPrice: TradePlanService.weightedAvgPrice(sellLegs),
      realizedPnL: trade.realizedPnL ?? TradePlanService.realizedPnLFromLegs(buyLegs, sellLegs),
    };
  }

  static pctVsCmp(entry: number, cmp?: number): number | null {
    if (!cmp || !entry) return null;
    return ((entry - cmp) / cmp) * 100;
  }

  static exitPctVsEntry(
    entry: number,
    exit: number,
    segment: TradeSegment,
    direction: TradeDirection
  ): number | null {
    if (!entry || !exit) return null;
    if (segment === 'intraday' && direction === 'short') {
      return ((entry - exit) / entry) * 100;
    }
    return ((exit - entry) / entry) * 100;
  }

  async create(input: CreatePlannedTradeInput): Promise<string> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to add trades');

    const segment = input.segment;
    let direction = input.direction;
    if (segment === 'delivery') {
      direction = 'long';
    }

    const entryLegs = TradePlanService.resolveEntryLegs(input.entryLegs, input.entryPrice, input.quantity);
    const validationError = TradePlanService.validatePlannedEntryLegs(entryLegs, segment, direction);
    if (validationError) throw new Error(validationError);
    const targets = TradePlanService.sanitizeTargets(input.targets);
    const targetPrice = targets.length
      ? TradePlanService.weightedAvgPrice(targets)
      : input.targetPrice;
    const summary = TradePlanService.entryLegSummary(
      entryLegs,
      segment,
      direction,
      targetPrice,
      input.stopLoss
    );

    const now = Date.now();
    const id = crypto.randomUUID();
    const inOpenPool = input.pool === 'open';
    const tradeDate = inOpenPool ? OPEN_TRADE_POOL_DATE : (input.tradeDate ?? '');
    if (!inOpenPool && !tradeDate) {
      throw new Error('Trade date is required');
    }
    const status: TradeExecutionStatus = inOpenPool ? 'open' : 'planned';

    const row = objectToSnake({
      id,
      userId: uid,
      symbol: input.symbol.toUpperCase(),
      stockName: input.stockName ?? input.symbol.toUpperCase(),
      tradeDate,
      segment,
      direction,
      quantity: summary.totalQuantity,
      cmp: input.cmp ?? null,
      entryPrice: summary.avgEntryPrice,
      targetPrice,
      stopLoss: input.stopLoss ?? null,
      status,
      estimatedPnl: summary.estimatedPnL,
      realizedPnl: null,
      notes: input.notes ?? '',
      createdAt: now,
      payload: {
        source: input.source ?? 'manual',
        estimatedStopLossPnL: summary.estimatedStopLossPnL,
        executedQuantity: null,
        executedBuyPrice: null,
        executedSellPrice: null,
        entryLegs,
        targets: targets.length ? targets : null,
        updatedAt: now,
        carriedFromDate: input.carriedFromDate,
        momentumStockId: input.momentumId,
      },
    });
    const { error } = await this.supabase.client.from('planned_trades').insert(row);
    if (error) throw error;
    return id;
  }

  async updateExecution(
    id: string,
    status: TradeExecutionStatus,
    execution?: TradeExecutionInput
  ): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to update trades');
    const existing = await this.getById(id);
    const payload: PlannedTradePayload = {
      source: existing?.source,
      estimatedStopLossPnL: existing?.estimatedStopLossPnL ?? null,
      updatedAt: Date.now(),
      executedQuantity: null,
      executedBuyPrice: null,
      executedSellPrice: null,
      buyLegs: null,
      sellLegs: null,
      entryLegs: existing?.entryLegs ?? null,
      targets: existing?.targets ?? null,
    };
    let realizedPnl: number | null = null;
    if (status === 'executed' && execution) {
      const validationError = TradePlanService.validateExecutionLegs(execution.buyLegs, execution.sellLegs);
      if (validationError) throw new Error(validationError);
      const quantity = TradePlanService.legTotalQty(execution.buyLegs);
      const avgBuy = TradePlanService.weightedAvgPrice(execution.buyLegs);
      const avgSell = TradePlanService.weightedAvgPrice(execution.sellLegs);
      realizedPnl = TradePlanService.realizedPnLFromLegs(execution.buyLegs, execution.sellLegs);
      payload.executedQuantity = quantity;
      payload.executedBuyPrice = avgBuy;
      payload.executedSellPrice = avgSell;
      payload.buyLegs = execution.buyLegs;
      payload.sellLegs = execution.sellLegs;
    }
    const { error } = await this.supabase.client
      .from('planned_trades')
      .update(
        objectToSnake({
          status,
          realizedPnl,
          executedAt: status === 'executed' ? Date.now() : null,
          payload,
        })
      )
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
  }

  async moveToOpen(id: string): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to update trades');
    const existing = await this.getById(id);
    if (!existing) throw new Error('Trade not found');

    const openedFromDate =
      existing.tradeDate !== OPEN_TRADE_POOL_DATE
        ? existing.tradeDate
        : existing.openedFromDate;
    const payload: PlannedTradePayload = {
      source: existing.source,
      estimatedStopLossPnL: existing.estimatedStopLossPnL ?? null,
      executedQuantity: null,
      executedBuyPrice: null,
      executedSellPrice: null,
      buyLegs: null,
      sellLegs: null,
      entryLegs: existing.entryLegs ?? null,
      targets: existing.targets ?? null,
      openedFromDate,
      updatedAt: Date.now(),
    };

    const { error } = await this.supabase.client
      .from('planned_trades')
      .update(
        objectToSnake({
          status: 'open' as TradeExecutionStatus,
          tradeDate: OPEN_TRADE_POOL_DATE,
          realizedPnl: null,
          executedAt: null,
          payload,
        })
      )
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
  }

  async assignOpenTradeToDate(id: string, targetDate: string): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to update trades');
    const existing = await this.getById(id);
    if (!existing || existing.status !== 'open') {
      throw new Error('Trade is not in the open pool');
    }

    const targetTrades = await this.fetchForDate(targetDate);
    const key = TradePlanService.tradeDuplicateKey(existing);
    const duplicate = targetTrades.some(
      (t) => t.status === 'planned' && TradePlanService.tradeDuplicateKey(t) === key
    );
    if (duplicate) {
      throw new Error('A similar trade is already planned for that day');
    }

    const payload: PlannedTradePayload = {
      source: existing.source,
      estimatedStopLossPnL: existing.estimatedStopLossPnL ?? null,
      executedQuantity: null,
      executedBuyPrice: null,
      executedSellPrice: null,
      buyLegs: null,
      sellLegs: null,
      entryLegs: existing.entryLegs ?? null,
      targets: existing.targets ?? null,
      openedFromDate: existing.openedFromDate,
      updatedAt: Date.now(),
    };

    const { error } = await this.supabase.client
      .from('planned_trades')
      .update(
        objectToSnake({
          tradeDate: targetDate,
          status: 'planned' as TradeExecutionStatus,
          payload,
        })
      )
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
  }

  async getById(id: string): Promise<PlannedTrade | null> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return null;
    const { data, error } = await this.supabase.client
      .from('planned_trades')
      .select('*')
      .eq('id', id)
      .eq('user_id', uid)
      .maybeSingle();
    if (error) throw error;
    return data ? rowToPlannedTrade(data) : null;
  }

  async update(id: string, input: CreatePlannedTradeInput): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to update trades');
    const existing = await this.getById(id);

    const segment = input.segment;
    let direction = input.direction;
    if (segment === 'delivery') {
      direction = 'long';
    }

    const entryLegs = TradePlanService.resolveEntryLegs(input.entryLegs, input.entryPrice, input.quantity);
    const validationError = TradePlanService.validatePlannedEntryLegs(entryLegs, segment, direction);
    if (validationError) throw new Error(validationError);
    // Callers that don't know about ladders (the plan form) keep an existing one as long
    // as they left the exit price alone; changing the exit means a single target now.
    const existingTargets = TradePlanService.sanitizeTargets(existing?.targets);
    const keepsExistingLadder =
      input.targets === undefined &&
      existingTargets.length > 0 &&
      existing != null &&
      Math.abs(input.targetPrice - existing.targetPrice) < 0.005;
    const targets =
      input.targets !== undefined
        ? TradePlanService.sanitizeTargets(input.targets)
        : keepsExistingLadder
          ? existingTargets
          : [];
    const targetPrice = targets.length
      ? TradePlanService.weightedAvgPrice(targets)
      : input.targetPrice;
    const summary = TradePlanService.entryLegSummary(
      entryLegs,
      segment,
      direction,
      targetPrice,
      input.stopLoss
    );

    const payload: PlannedTradePayload = {
      source: input.source ?? existing?.source ?? 'manual',
      estimatedStopLossPnL: summary.estimatedStopLossPnL,
      executedQuantity: existing?.executedQuantity ?? null,
      executedBuyPrice: existing?.executedBuyPrice ?? null,
      executedSellPrice: existing?.executedSellPrice ?? null,
      buyLegs: existing?.buyLegs ?? null,
      sellLegs: existing?.sellLegs ?? null,
      entryLegs,
      targets: targets.length ? targets : null,
      updatedAt: Date.now(),
    };

    const { error } = await this.supabase.client
      .from('planned_trades')
      .update(
        objectToSnake({
          symbol: input.symbol.toUpperCase(),
          stockName: input.stockName ?? input.symbol.toUpperCase(),
          tradeDate: input.tradeDate,
          segment,
          direction,
          quantity: summary.totalQuantity,
          cmp: input.cmp ?? null,
          entryPrice: summary.avgEntryPrice,
          targetPrice,
          stopLoss: input.stopLoss ?? null,
          notes: input.notes ?? '',
          estimatedPnl: summary.estimatedPnL,
          payload,
        })
      )
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
  }

  async countUnfinishedFromPreviousTradingDay(
    targetDate: string
  ): Promise<{ count: number; sourceDate: string | null }> {
    const sourceDate = TradePlanService.previousTradingDayBefore(targetDate);
    if (!sourceDate) return { count: 0, sourceDate: null };

    const [sourceTrades, targetTrades] = await Promise.all([
      this.fetchForDate(sourceDate),
      this.fetchForDate(targetDate),
    ]);
    const existingKeys = new Set(targetTrades.map((t) => TradePlanService.tradeDuplicateKey(t)));
    const count = sourceTrades
      .filter((t) => t.status === 'planned')
      .filter((t) => !existingKeys.has(TradePlanService.tradeDuplicateKey(t))).length;
    return { count, sourceDate };
  }

  async copyUnfinishedFromPreviousTradingDay(targetDate: string): Promise<CopyUnfinishedResult> {
    const sourceDate = TradePlanService.previousTradingDayBefore(targetDate);
    if (!sourceDate) return { copied: 0, skippedDuplicates: 0, sourceDate: '' };

    const [sourceTrades, targetTrades] = await Promise.all([
      this.fetchForDate(sourceDate),
      this.fetchForDate(targetDate),
    ]);
    const existingKeys = new Set(targetTrades.map((t) => TradePlanService.tradeDuplicateKey(t)));
    const unfinished = sourceTrades.filter((t) => t.status === 'planned');

    let copied = 0;
    let skippedDuplicates = 0;
    for (const t of unfinished) {
      const key = TradePlanService.tradeDuplicateKey(t);
      if (existingKeys.has(key)) {
        skippedDuplicates++;
        continue;
      }
      await this.create({
        symbol: t.symbol,
        stockName: t.stockName,
        tradeDate: targetDate,
        segment: t.segment,
        direction: t.direction,
        quantity: t.quantity,
        cmp: t.cmp,
        entryPrice: t.entryPrice,
        targetPrice: t.targetPrice,
        stopLoss: t.stopLoss,
        entryLegs: t.entryLegs,
        targets: t.targets,
        source: t.source,
        notes: t.notes,
        carriedFromDate: sourceDate,
      });
      existingKeys.add(key);
      copied++;
    }
    return { copied, skippedDuplicates, sourceDate };
  }

  private static previousTradingDayBefore(iso: string): string | null {
    const prev = previousTradingDayOnOrBefore(addDaysIso(iso, -1));
    return prev < iso ? prev : null;
  }

  private static tradeDuplicateKey(
    t: Pick<PlannedTrade, 'symbol' | 'segment' | 'direction'>
  ): string {
    return `${t.symbol.toUpperCase()}:${t.segment}:${t.direction}`;
  }

  async remove(id: string): Promise<void> {
    await this.removeMany([id]);
  }

  async removeMany(ids: string[]): Promise<number> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to delete trades');
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (!uniqueIds.length) return 0;
    const chunkSize = 100;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);
      const { error } = await this.supabase.client
        .from('planned_trades')
        .delete()
        .in('id', chunk)
        .eq('user_id', uid);
      if (error) throw error;
    }
    return uniqueIds.length;
  }

  async removeAllOpen(): Promise<number> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to delete trades');
    const { data, error: selectError } = await this.supabase.client
      .from('planned_trades')
      .select('id')
      .eq('user_id', uid)
      .eq('status', 'open')
      .eq('trade_date', OPEN_TRADE_POOL_DATE);
    if (selectError) throw selectError;
    if (!data?.length) return 0;
    const { error } = await this.supabase.client
      .from('planned_trades')
      .delete()
      .eq('user_id', uid)
      .eq('status', 'open')
      .eq('trade_date', OPEN_TRADE_POOL_DATE);
    if (error) throw error;
    return data.length;
  }

  async removeAllForDate(tradeDate: string): Promise<number> {
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to delete trades');
    const { data, error: selectError } = await this.supabase.client
      .from('planned_trades')
      .select('id')
      .eq('user_id', uid)
      .eq('trade_date', tradeDate)
      .neq('status', 'open');
    if (selectError) throw selectError;
    if (!data?.length) return 0;
    const { error } = await this.supabase.client
      .from('planned_trades')
      .delete()
      .eq('user_id', uid)
      .eq('trade_date', tradeDate)
      .neq('status', 'open');
    if (error) throw error;
    return data.length;
  }

  async deleteAll(): Promise<number> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return 0;
    const { data, error: selectError } = await this.supabase.client
      .from('planned_trades')
      .select('id')
      .eq('user_id', uid);
    if (selectError) throw selectError;
    if (!data?.length) return 0;
    const { error } = await this.supabase.client.from('planned_trades').delete().eq('user_id', uid);
    if (error) throw error;
    return data.length;
  }
}

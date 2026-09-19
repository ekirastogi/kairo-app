import { Injectable, inject } from '@angular/core';
import {
  Report,
  StockProfile,
  StockSummary,
  StoredTrade,
  Trade,
  TradeType,
  UnrealisedHolding,
  UnrealisedLot,
  UploadRecord,
  DailyAnalyticsRow,
} from '../models/trade.models';
import { AuthService } from './auth.service';
import { ChargesService } from './charges.service';
import { ClientAccountService } from './client-account.service';
import { ContractNoteParserService } from './contract-note-parser.service';
import { CorporateActionService } from './corporate-action.service';
import { ParserService } from './parser.service';
import { RegistryStockService } from './registry-stock.service';
import { RegistryLabelService } from './registry-label.service';
import { TradePlanService } from './trade-plan.service';
import { MomentumStockService } from './momentum-stock.service';
import { UserConfigService } from './user-config.service';
import { WatchlistService } from './watchlist.service';
import { objectToSnake, numField, rowToCamel, SupabaseService } from './supabase.service';
import {
  buildTradeTypeStats,
  computeTradeCharges,
  computeFileContentHash,
  enrichTradeWithCharges,
  normalizeSymbol,
} from '../utils/upload-merge.utils';
import { applyCorporateActionsToTrades } from '../utils/corporate-action.utils';
import { holdingsToOpenLots, matchContractNoteDay } from '../utils/contract-note-match.utils';
import { expandTradeTypes, effectiveTradeType, tradeMatchesTypeFilter } from '../utils/trade-type-filter.utils';
import { mergeStockProfiles, mergeStockSummaries, profileToStockSummary, profilesHaveTypeBreakdown } from '../utils/filter-stock-profiles.utils';
import { buildDailyAnalyticsFromTrades } from '../utils/analytics-aggregation.utils';
import { buyLotKey, mergeUnrealisedHoldings } from '../utils/holdings.utils';
import {
  applyKnownIsins,
  collectIsinsByName,
  fillMissingIsins,
  IdentityHint,
  normalizeIsin,
  preferStockSymbol,
  StockIdentityResolver,
  stockIdentityKey,
  uniqueByKey,
} from '../utils/stock-identity.utils';

/**
 * Realised P&L the ledger holds for the statement's period against the figure printed on the
 * file. They must agree; when they do not, rows were lost or double-counted on the way in and
 * every downstream screen quietly disagrees with Groww.
 */
export interface UploadReconciliation {
  /** Realised P&L from the statement header. */
  statement: number;
  /** Realised P&L now stored for the same period. */
  stored: number;
  difference: number;
  matches: boolean;
}

export interface UploadResult {
  uploadId: string;
  clientCode: string;
  clientName: string;
  newTradesAdded: number;
  /** Stored rows cleared because the file supplied a fresh version of those dates. */
  tradesReplaced: number;
  fileDuplicate: boolean;
  affectedSymbols: string[];
  report?: Report;
  reconciliation?: UploadReconciliation;
}

/** Rounding across thousands of rows, so anything under a rupee is not a real discrepancy. */
const RECONCILIATION_TOLERANCE = 1;

export interface UploadOptions {
  forceReingest?: boolean;
}

export interface ResetDataOptions {
  tradeData?: boolean;
  watchlists?: boolean;
  stockRegistry?: boolean;
  tradePlans?: boolean;
  stockLevels?: boolean;
}

export interface ResetDataResult {
  clientsRemoved: number;
  watchlistsRemoved: number;
  registryStocksRemoved: number;
  plannedTradesRemoved: number;
  momentumStocksRemoved: number;
  levelsRemoved: number;
}

export interface BackfillUniverseOptions {
  rebuildProfiles?: boolean;
}

export interface BackfillUniverseResult {
  clientsProcessed: number;
  symbolsSynced: number;
  symbols: string[];
  profilesRebuilt: number;
}

const UPSERT_BATCH_LIMIT = 400;
/** Supabase caps a single response at 1000 rows, so paged reads step in that size. */
const SELECT_PAGE_SIZE = 1000;
const DEFAULT_REPORT_TRADE_TYPES: TradeType[] = ['all', 'intraday', 'delivery', 'mtf'];
const ALL_REPORT_TRADE_TYPES: TradeType[] = ['all', 'intraday', 'delivery', 'same_day', 'mtf', 'fno'];

function profileFromRow(row: Record<string, unknown>, clientCode: string, clientName: string): StockProfile {
  const camel = rowToCamel<Record<string, unknown>>(row);
  const buyValue = numField(camel, 'buyValue');
  const netPnL = numField(camel, 'netPnL', 'netPnl');
  const rawByType = camel['byTradeType'];
  const byTradeType =
    rawByType && typeof rawByType === 'object' && !Array.isArray(rawByType)
      ? (rawByType as StockProfile['byTradeType'])
      : {};
  return {
    symbol: String(camel['symbol'] ?? ''),
    stockName: String(camel['stockName'] ?? ''),
    isin: normalizeIsin(String(camel['isin'] ?? '')),
    clientCode,
    clientName,
    tradeCount: Number(camel['tradeCount'] ?? 0),
    winningTrades: Number(camel['winningTrades'] ?? 0),
    losingTrades: Number(camel['losingTrades'] ?? 0),
    breakEvenTrades: 0,
    winRate: Number(camel['winRate'] ?? 0),
    totalBuyValue: buyValue,
    totalSellValue: numField(camel, 'sellValue'),
    grossProfit: 0,
    grossLoss: 0,
    realisedPnL: numField(camel, 'realisedPnL', 'realisedPnl'),
    allocatedCharges: numField(camel, 'allocatedCharges'),
    netPnL,
    netPnLPct: buyValue ? (netPnL / buyValue) * 100 : 0,
    avgHoldingDays: 0,
    dateRange: { first: '', last: '' },
    byTradeType,
    uploadIds: [],
    updatedAt: Date.now(),
  };
}

function tradeFromRow(row: Record<string, unknown>): StoredTrade {
  const camel = rowToCamel<Record<string, unknown>>(row);
  const sourceRaw = String(camel['source'] ?? '').trim();
  const source =
    sourceRaw === 'contract_note' || sourceRaw === 'excel'
      ? (sourceRaw as StoredTrade['source'])
      : undefined;
  return {
    dedupeKey: String(camel['dedupeKey'] ?? camel['id'] ?? ''),
    uploadId: String(camel['uploadId'] ?? ''),
    clientCode: String(camel['clientCode'] ?? ''),
    clientName: String(camel['clientName'] ?? ''),
    symbol: String(camel['symbol'] ?? ''),
    stockName: String(camel['stockName'] ?? ''),
    isin: normalizeIsin(String(camel['isin'] ?? '')),
    quantity: Number(camel['quantity'] ?? 0),
    buyDate: String(camel['buyDate'] ?? ''),
    buyPrice: numField(camel, 'buyPrice'),
    buyValue: numField(camel, 'buyValue'),
    sellDate: String(camel['sellDate'] ?? ''),
    sellPrice: numField(camel, 'sellPrice'),
    sellValue: numField(camel, 'sellValue'),
    realisedPnL: numField(camel, 'realisedPnL', 'realisedPnl'),
    remark: String(camel['remark'] ?? ''),
    tradeType: (camel['tradeType'] as TradeType) ?? 'delivery',
    holdingDays: Number(camel['holdingDays'] ?? 0),
    allocatedCharges: numField(camel, 'allocatedCharges'),
    netPnL: numField(camel, 'netPnL', 'netPnl'),
    createdAt: Number(camel['createdAt'] ?? 0),
    source,
    originalSymbol: camel['originalSymbol'] ? String(camel['originalSymbol']) : undefined,
    originalStockName: camel['originalStockName'] ? String(camel['originalStockName']) : undefined,
    originalIsin: camel['originalIsin'] ? normalizeIsin(String(camel['originalIsin'])) : undefined,
    corporateActionId: camel['corporateActionId']
      ? String(camel['corporateActionId'])
      : undefined,
  };
}

function profileToRow(
  profile: StockProfile,
  userId: string,
  options: { includeByTradeType?: boolean } = {}
): Record<string, unknown> {
  const includeByTradeType = options.includeByTradeType !== false;
  const row: Record<string, unknown> = {
    userId,
    clientCode: profile.clientCode,
    symbol: profile.symbol,
    stockName: profile.stockName,
    isin: profile.isin,
    quantity: profile.tradeCount,
    buyValue: profile.totalBuyValue,
    sellValue: profile.totalSellValue,
    realisedPnl: profile.realisedPnL,
    allocatedCharges: profile.allocatedCharges,
    netPnl: profile.netPnL,
    tradeCount: profile.tradeCount,
    winningTrades: profile.winningTrades,
    losingTrades: profile.losingTrades,
    winRate: profile.winRate,
  };
  if (includeByTradeType && Object.keys(profile.byTradeType).length > 0) {
    row['byTradeType'] = profile.byTradeType;
  }
  return objectToSnake(row);
}

function isMissingColumnError(error: { message?: string; code?: string }, column: string): boolean {
  const message = (error.message ?? '').toLowerCase();
  return (
    error.code === 'PGRST204' ||
    message.includes(column) ||
    message.includes('column') && message.includes('does not exist')
  );
}

function isMissingRelationError(error: { message?: string; code?: string }): boolean {
  const message = (error.message ?? '').toLowerCase();
  return (
    error.code === 'PGRST205' ||
    error.code === '42P01' ||
    message.includes('does not exist') ||
    message.includes('schema cache')
  );
}

function holdingFromRow(row: Record<string, unknown>): UnrealisedHolding {
  const camel = rowToCamel<Record<string, unknown>>(row);
  const lotsRaw = camel['lots'];
  const lots = Array.isArray(lotsRaw) ? (lotsRaw as UnrealisedLot[]) : [];
  return {
    stockName: String(camel['stockName'] ?? ''),
    isin: normalizeIsin(String(camel['isin'] ?? '')),
    symbol: String(camel['symbol'] ?? ''),
    quantity: Number(camel['quantity'] ?? 0),
    avgBuyPrice: numField(camel, 'avgBuyPrice'),
    buyValue: numField(camel, 'buyValue'),
    closingPrice: numField(camel, 'closingPrice'),
    closingValue: numField(camel, 'closingValue'),
    unrealisedPnL: numField(camel, 'unrealisedPnL', 'unrealisedPnl'),
    unrealisedPnLPct: numField(camel, 'unrealisedPnLPct', 'unrealisedPnlPct'),
    asOfDate: String(camel['asOfDate'] ?? ''),
    lots,
  };
}

function holdingToRow(
  holding: UnrealisedHolding,
  userId: string,
  clientCode: string
): Record<string, unknown> {
  return objectToSnake({
    userId,
    clientCode,
    symbol: holding.symbol,
    stockName: holding.stockName,
    isin: normalizeIsin(holding.isin),
    quantity: holding.quantity,
    avgBuyPrice: holding.avgBuyPrice,
    buyValue: holding.buyValue,
    closingPrice: holding.closingPrice,
    closingValue: holding.closingValue,
    unrealisedPnl: holding.unrealisedPnL,
    unrealisedPnlPct: holding.unrealisedPnLPct,
    asOfDate: holding.asOfDate,
    lots: holding.lots ?? [],
    updatedAt: Date.now(),
  });
}

function tradeToRow(trade: StoredTrade, userId: string): Record<string, unknown> {
  const row = objectToSnake({
    id: trade.dedupeKey,
    userId,
    clientCode: trade.clientCode,
    dedupeKey: trade.dedupeKey,
    uploadId: trade.uploadId,
    symbol: trade.symbol,
    stockName: trade.stockName,
    isin: normalizeIsin(trade.isin),
    quantity: trade.quantity,
    buyDate: trade.buyDate,
    buyPrice: trade.buyPrice,
    buyValue: trade.buyValue,
    sellDate: trade.sellDate,
    sellPrice: trade.sellPrice,
    sellValue: trade.sellValue,
    realisedPnl: trade.realisedPnL,
    remark: trade.remark,
    tradeType: trade.tradeType,
    holdingDays: trade.holdingDays,
    allocatedCharges: trade.allocatedCharges,
    netPnl: trade.netPnL,
    clientName: trade.clientName,
    createdAt: trade.createdAt,
    source: trade.source ?? 'excel',
    originalSymbol: trade.originalSymbol ?? null,
    originalStockName: trade.originalStockName ?? null,
    originalIsin: trade.originalIsin ? normalizeIsin(trade.originalIsin) : null,
    corporateActionId: trade.corporateActionId ?? null,
  });
  return row;
}

function stripCorporateActionColumns(row: Record<string, unknown>): Record<string, unknown> {
  const {
    original_symbol: _os,
    original_stock_name: _on,
    original_isin: _oi,
    corporate_action_id: _ca,
    ...rest
  } = row;
  return rest;
}

/**
 * Compares the ledger against the statement over the file's own date range, so a file covering
 * part of the history is still checked fairly against the rest of the ledger.
 */
function reconcileAgainstStatement(
  statement: Report,
  stored: Report | null
): UploadReconciliation | null {
  const expected = statement.summary.realisedPnL;
  const { min, max } = statement.dateRange;
  if (!Number.isFinite(expected) || !expected || !min || !max) return null;
  if (!stored?.tradesLoaded || !stored.trades.length) return null;

  const actual = stored.trades.reduce(
    (sum, trade) =>
      trade.sellDate >= min && trade.sellDate <= max ? sum + trade.realisedPnL : sum,
    0
  );
  const difference = actual - expected;
  return {
    statement: expected,
    stored: actual,
    difference,
    matches: Math.abs(difference) < RECONCILIATION_TOLERANCE,
  };
}

function dailyAnalyticsFromRow(row: Record<string, unknown>): DailyAnalyticsRow {
  const camel = rowToCamel<Record<string, unknown>>(row);
  return {
    sellDate: String(camel['sellDate'] ?? ''),
    tradeType: (camel['tradeType'] as TradeType) ?? 'delivery',
    tradeCount: Number(camel['tradeCount'] ?? 0),
    totalBuyValue: numField(camel, 'totalBuyValue'),
    totalSellValue: numField(camel, 'totalSellValue'),
    realisedPnL: numField(camel, 'realisedPnL', 'realisedPnl'),
    allocatedCharges: numField(camel, 'allocatedCharges'),
    netPnL: numField(camel, 'netPnL', 'netPnl'),
    winningTrades: Number(camel['winningTrades'] ?? 0),
    losingTrades: Number(camel['losingTrades'] ?? 0),
  };
}

function dailyAnalyticsToRow(
  row: DailyAnalyticsRow,
  userId: string,
  clientCode: string
): Record<string, unknown> {
  return objectToSnake({
    userId,
    clientCode,
    sellDate: row.sellDate,
    tradeType: row.tradeType,
    tradeCount: row.tradeCount,
    totalBuyValue: row.totalBuyValue,
    totalSellValue: row.totalSellValue,
    realisedPnl: row.realisedPnL,
    allocatedCharges: row.allocatedCharges,
    netPnl: row.netPnL,
    winningTrades: row.winningTrades,
    losingTrades: row.losingTrades,
  });
}

@Injectable({ providedIn: 'root' })
export class TradeLedgerService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private clientSvc = inject(ClientAccountService);
  private parser = inject(ParserService);
  private contractNoteParser = inject(ContractNoteParserService);
  private userConfig = inject(UserConfigService);
  private registry = inject(RegistryStockService);
  private corporateActions = inject(CorporateActionService);
  private registryLabels = inject(RegistryLabelService);
  private tradePlans = inject(TradePlanService);
  private momentumStocks = inject(MomentumStockService);
  private watchlists = inject(WatchlistService);
  private chargesSvc = inject(ChargesService);
  /** null = unknown; false = `by_trade_type` column not on remote DB yet. */
  private stockProfilesSupportByTradeType: boolean | null = null;
  /** null = unknown; false = `unrealised_holdings` table not on remote DB yet. */
  private holdingsTableAvailable: boolean | null = null;
  /** null = unknown; false = `trades_replaced` column not on remote DB yet. */
  private uploadsSupportTradesReplaced: boolean | null = null;
  /** null = unknown; false = `source` column not on remote DB yet. */
  private tradesSupportSource: boolean | null = null;
  /** null = unknown; false = corporate-action columns not on remote DB yet. */
  private tradesSupportCorporateAction: boolean | null = null;
  /** The traded-label backfill only needs to run once per session. */
  private tradedLabelsSynced = false;

  async uploadReport(file: File, options: UploadOptions = {}): Promise<UploadResult> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to push data');

    const buffer = await file.arrayBuffer();
    const contentHash = await computeFileContentHash(buffer);
    const report = await this.parser.parseFile(file);
    const resolver = await this.buildIdentityResolver(report);
    this.applyIdentity(report, resolver);
    await this.applyCorporateActionsToReport(report);

    if (!report.trades.length && !(report.unrealisedHoldings?.length)) {
      throw new Error('No trades found in this file. Check that it is a Groww P&L export.');
    }

    const clientCode = report.summary.clientCode?.trim() || 'UNKNOWN';
    const clientName = report.summary.clientName?.trim() || clientCode;
    const holdings = report.unrealisedHoldings ?? [];

    if (options.forceReingest) {
      await this.deleteClientData(clientCode);
    }

    const existingUploadId = options.forceReingest
      ? null
      : await this.findUploadByContentHash(uid, clientCode, contentHash);

    const uploadId = existingUploadId ?? crypto.randomUUID();
    const rateCardCharges = computeTradeCharges(
      report.trades,
      this.chargesSvc,
      report.charges.total
    );
    const now = Date.now();

    const affectedSymbols = new Set<string>();
    const pendingWrites: StoredTrade[] = report.trades.map((trade, index) => {
      const identity = resolver.resolve(trade.isin, trade.stockName, trade.symbol);
      const enriched = enrichTradeWithCharges(trade, rateCardCharges[index] ?? 0);
      const symbol = trade.symbol || identity.symbol;
      affectedSymbols.add(symbol);
      return {
        ...trade,
        isin: trade.isin || identity.isin,
        dedupeKey: crypto.randomUUID(),
        uploadId,
        clientCode,
        clientName,
        symbol,
        allocatedCharges: enriched.allocatedCharges,
        netPnL: enriched.netPnL,
        createdAt: now,
        source: 'excel',
        originalSymbol: trade.originalSymbol,
        originalStockName: trade.originalStockName,
        originalIsin: trade.originalIsin,
        corporateActionId: trade.corporateActionId,
      };
    });

    /**
     * A Groww P&L statement is the complete record for its printed window. Wipe every stored
     * trade in that window (not only sell dates that appear in the rows) before inserting, so
     * orphan rows from older buggy imports cannot survive a full re-upload and silently skew
     * FYTD / all-time totals away from Groww.
     */
    const replaceStart = report.dateRange.min;
    const replaceEnd = report.dateRange.max;
    const tradesReplaced = await this.deleteTradesInSellDateRange(
      uid,
      clientCode,
      replaceStart,
      replaceEnd
    );

    if (pendingWrites.length) {
      await this.commitTradesInChunks(pendingWrites, uid);
    }
    const newTradesAdded = pendingWrites.length;

    const uploadRecord: Omit<UploadRecord, 'id'> = {
      fileName: file.name,
      contentHash,
      uploadedAt: now,
      clientCode,
      clientName,
      periodLabel: report.summary.period,
      periodStart: report.dateRange.min,
      periodEnd: report.dateRange.max,
      reportRealisedPnL: report.summary.realisedPnL,
      reportUnrealisedPnL: report.summary.unrealisedPnL,
      chargesTotal: report.charges.total,
      charges: report.charges.items,
      tradeCount: report.trades.length,
      newTradesAdded,
      tradesReplaced,
      status: 'completed',
    };
    await this.writeUploadRecord(uploadId, uid, uploadRecord);

    await this.purgeMarkToMarketTrades(clientCode, report);
    await this.replaceHoldings(clientCode, holdings);

    // Re-read with a stable key order so same-day pages cannot skip/duplicate rows, then
    // rebuild profiles/analytics from that exact set — this is what the dashboard will sum.
    const storedTrades = await this.getAllTrades(clientCode);
    const syncedReport = await this.syncDerivedData(clientCode, clientName, {
      trades: storedTrades,
      uploadMeta: uploadRecord,
      holdings,
    });

    const reconciliation = reconcileAgainstStatement(report, syncedReport);
    if (reconciliation && !reconciliation.matches) {
      throw new Error(
        `Realised P&L does not match this statement after import ` +
          `(file ${reconciliation.statement.toLocaleString('en-IN')}, ` +
          `ledger ${reconciliation.stored.toLocaleString('en-IN')}). ` +
          `Upload the full Groww file again.`
      );
    }

    return {
      uploadId,
      clientCode,
      clientName,
      newTradesAdded,
      tradesReplaced,
      fileDuplicate: existingUploadId !== null,
      affectedSymbols: [...affectedSymbols],
      report: syncedReport ?? undefined,
      reconciliation: reconciliation ?? undefined,
    };
  }

  /**
   * Provisional evening ingest from a Groww contract note PDF.
   * Replaces only sell_date = trade date, FIFO-matches against open holdings,
   * and tags rows as `contract_note` so Sunday Excel can supersede them.
   */
  async uploadContractNote(file: File, password?: string): Promise<UploadResult> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to push data');

    const resolvedPassword =
      password?.trim() ||
      (await this.userConfig.getContractNotePassword()) ||
      '';
    if (!resolvedPassword) {
      throw new Error('Save the contract note password under Settings → Contract notes first.');
    }

    const buffer = await file.arrayBuffer();
    const contentHash = await computeFileContentHash(buffer);
    const note = await this.contractNoteParser.parseFile(file, resolvedPassword);

    const clientCode = note.clientCode?.trim() || 'UNKNOWN';
    const clientName = note.clientName?.trim() || clientCode;

    const existingHoldings = await this.getHoldings(clientCode);
    const matched = matchContractNoteDay(note, holdingsToOpenLots(existingHoldings));
    if (!matched.trades.length && !matched.holdings.length) {
      throw new Error('No trades found in this contract note.');
    }

    const stubReport: Report = {
      summary: {
        clientName,
        clientCode,
        period: `Contract note ${note.tradeDate}`,
        realisedPnL: note.realisedPnL,
        unrealisedPnL: 0,
      },
      dateRange: { min: note.tradeDate, max: note.tradeDate },
      charges: { items: note.charges, total: note.chargesTotal },
      trades: matched.trades,
      stockSummary: [],
      unrealisedHoldings: matched.holdings,
      unrealisedLots: matched.unrealisedLots,
      tradeTypes: ['all', 'intraday', 'delivery', 'same_day'],
    };

    const resolver = await this.buildIdentityResolver(stubReport);
    this.applyIdentity(stubReport, resolver);
    await this.applyCorporateActionsToReport(stubReport);

    const existingUploadId = await this.findUploadByContentHash(uid, clientCode, contentHash);
    const uploadId = existingUploadId ?? crypto.randomUUID();
    const rateCardCharges = computeTradeCharges(
      stubReport.trades,
      this.chargesSvc,
      note.chargesTotal
    );
    const now = Date.now();

    const affectedSymbols = new Set<string>();
    const pendingWrites: StoredTrade[] = stubReport.trades.map((trade, index) => {
      const identity = resolver.resolve(trade.isin, trade.stockName, trade.symbol);
      const enriched = enrichTradeWithCharges(trade, rateCardCharges[index] ?? 0);
      const symbol = trade.symbol || identity.symbol;
      affectedSymbols.add(symbol);
      return {
        ...trade,
        isin: trade.isin || identity.isin,
        dedupeKey: crypto.randomUUID(),
        uploadId,
        clientCode,
        clientName,
        symbol,
        allocatedCharges: enriched.allocatedCharges,
        netPnL: enriched.netPnL,
        createdAt: now,
        source: 'contract_note',
        originalSymbol: trade.originalSymbol,
        originalStockName: trade.originalStockName,
        originalIsin: trade.originalIsin,
        corporateActionId: trade.corporateActionId,
      };
    });

    const tradesReplaced = await this.deleteTradesInSellDateRange(
      uid,
      clientCode,
      note.tradeDate,
      note.tradeDate
    );

    if (pendingWrites.length) {
      await this.commitTradesInChunks(pendingWrites, uid);
    }
    const newTradesAdded = pendingWrites.length;

    const uploadRecord: Omit<UploadRecord, 'id'> = {
      fileName: file.name,
      contentHash,
      uploadedAt: now,
      clientCode,
      clientName,
      periodLabel: `Contract note ${note.contractNoteNo || note.tradeDate}`,
      periodStart: note.tradeDate,
      periodEnd: note.tradeDate,
      reportRealisedPnL: note.realisedPnL,
      reportUnrealisedPnL: 0,
      chargesTotal: note.chargesTotal,
      charges: note.charges,
      tradeCount: stubReport.trades.length,
      newTradesAdded,
      tradesReplaced,
      status: 'completed',
    };
    await this.writeUploadRecord(uploadId, uid, uploadRecord);

    const holdings = mergeUnrealisedHoldings(
      (stubReport.unrealisedHoldings ?? []).map((holding) => {
        const identity = resolver.resolve(holding.isin, holding.stockName, holding.symbol);
        return {
          ...holding,
          isin: identity.isin,
          symbol: identity.symbol,
        };
      })
    );
    await this.replaceHoldings(clientCode, holdings);

    const storedTrades = await this.getAllTrades(clientCode);
    const syncedReport = await this.syncDerivedData(clientCode, clientName, {
      trades: storedTrades,
      uploadMeta: uploadRecord,
      holdings,
    });

    return {
      uploadId,
      clientCode,
      clientName,
      newTradesAdded,
      tradesReplaced,
      fileDuplicate: existingUploadId !== null,
      affectedSymbols: [...affectedSymbols],
      report: syncedReport ?? undefined,
    };
  }

  /**
   * Tags every symbol in the ledger with the shared "traded" label, across all clients.
   * Used to backfill ledgers imported before the label existed.
   */
  async syncTradedLabels(force = false): Promise<string[]> {
    if (this.tradedLabelsSynced && !force) return [];
    await this.auth.whenReady();
    if (!(await this.auth.getDataUserId())) return [];

    const symbols = new Set<string>();
    for (const client of await this.clientSvc.listClients()) {
      const profiles = await this.getStockProfiles(client.clientCode);
      if (profiles.length) {
        for (const profile of profiles) {
          if (profile.symbol) symbols.add(profile.symbol.toUpperCase());
        }
        continue;
      }
      // Ledgers imported before profiles were written still carry a symbol per trade.
      for (const trade of await this.getAllTrades(client.clientCode)) {
        if (trade.symbol) symbols.add(trade.symbol.toUpperCase());
      }
    }

    const list = [...symbols];
    await this.tagTradedSymbols(list);
    this.tradedLabelsSynced = true;
    return list;
  }

  /** Label bookkeeping must never fail an upload, so failures are swallowed here. */
  private async tagTradedSymbols(symbols: string[]): Promise<void> {
    try {
      await this.registryLabels.syncTradedSymbols(symbols);
    } catch {
      // Labels may not be provisioned yet; the registry page retries this as a backfill.
    }
  }

  async backfillUniverse(options: BackfillUniverseOptions = {}): Promise<BackfillUniverseResult> {
    await this.auth.whenReady();
    if (!(await this.auth.getDataUserId())) throw new Error('Sign in to backfill universe');

    const clients = await this.clientSvc.listClients();
    const symbolMap = new Map<string, { symbol: string; name?: string; isin?: string }>();
    let profilesRebuilt = 0;

    for (const client of clients) {
      let profiles = await this.getStockProfiles(client.clientCode);
      if (options.rebuildProfiles || !profiles.length) {
        const trades = await this.getAllTrades(client.clientCode);
        if (trades.length) {
          profiles = this.buildStockProfilesFromTrades(
            trades,
            client.clientCode,
            client.clientName
          );
          await this.writeStockProfiles(client.clientCode, profiles);
          profilesRebuilt++;
        }
      }

      for (const profile of profiles) {
        symbolMap.set(profile.symbol, {
          symbol: profile.symbol,
          name: profile.stockName,
          isin: profile.isin,
        });
      }
    }

    const symbolsSynced = await this.registry.syncSymbols([...symbolMap.values()], 'pnl_upload');
    await this.tagTradedSymbols([...symbolMap.keys()]);

    return {
      clientsProcessed: clients.length,
      symbolsSynced,
      symbols: [...symbolMap.keys()].sort(),
      profilesRebuilt,
    };
  }

  async resetData(options: ResetDataOptions): Promise<ResetDataResult> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to reset data');

    const result: ResetDataResult = {
      clientsRemoved: 0,
      watchlistsRemoved: 0,
      registryStocksRemoved: 0,
      plannedTradesRemoved: 0,
      momentumStocksRemoved: 0,
      levelsRemoved: 0,
    };

    if (options.tradeData) {
      const clients = await this.clientSvc.listClients();
      for (const client of clients) {
        await this.deleteClientData(client.clientCode);
      }
      result.clientsRemoved = clients.length;
      this.clientSvc.clearSelectedClient();
    }

    if (options.watchlists) {
      result.watchlistsRemoved = await this.watchlists.deleteAllWatchlists();
    }

    if (options.stockRegistry) {
      await this.registryLabels.deleteAll();
      result.registryStocksRemoved = await this.registry.deleteAll();
    }

    if (options.tradePlans) {
      result.plannedTradesRemoved = await this.tradePlans.deleteAll();
      result.momentumStocksRemoved = await this.momentumStocks.deleteAll();
    }

    if (options.stockLevels) {
      result.levelsRemoved = await this.deleteUserLevels(uid);
    }

    return result;
  }

  private async deleteUserLevels(uid: string): Promise<number> {
    const { data, error: selectError } = await this.supabase.client
      .from('user_stock_levels')
      .select('symbol')
      .eq('user_id', uid);
    if (selectError) throw selectError;
    if (!data?.length) return 0;
    const { error } = await this.supabase.client.from('user_stock_levels').delete().eq('user_id', uid);
    if (error) throw error;
    return data.length;
  }

  async getAllTrades(clientCode: string): Promise<StoredTrade[]> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];

    const all: StoredTrade[] = [];
    for (let from = 0; ; from += SELECT_PAGE_SIZE) {
      const { data, error } = await this.supabase.client
        .from('trades')
        .select('*')
        .eq('user_id', uid)
        .eq('client_code', clientCode)
        // id is the tie-break: ordering by sell_date alone skips/duplicates same-day rows across pages.
        .order('sell_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, from + SELECT_PAGE_SIZE - 1);
      if (error) throw error;
      if (!data?.length) break;
      all.push(...data.map((row) => tradeFromRow(row)));
      if (data.length < SELECT_PAGE_SIZE) break;
    }
    return uniqueByKey(all, (trade) => trade.dedupeKey);
  }

  async countTrades(clientCode: string): Promise<number> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return 0;
    const { count, error } = await this.supabase.client
      .from('trades')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', uid)
      .eq('client_code', clientCode);
    if (error) throw error;
    return count ?? 0;
  }

  async getTradesForSymbol(
    clientCode: string,
    symbol: string,
    filters: { startDate?: string; endDate?: string; tradeTypes?: TradeType[] } = {}
  ): Promise<StoredTrade[]> {
    return this.getTradesForStock(clientCode, { symbol }, filters);
  }

  async getTradesForStock(
    clientCode: string,
    identity: { symbol?: string; isin?: string },
    filters: { startDate?: string; endDate?: string; tradeTypes?: TradeType[] } = {}
  ): Promise<StoredTrade[]> {
    const isin = normalizeIsin(identity.isin);
    const symbol = (identity.symbol ?? '').trim().toUpperCase();
    if (!isin && !symbol) return [];
    return this.queryTrades(clientCode, { isin, symbol, ...filters });
  }

  async getTradesForDateRange(
    clientCode: string,
    startDate: string,
    endDate: string,
    filters: { tradeTypes?: TradeType[] } = {}
  ): Promise<StoredTrade[]> {
    return this.queryTrades(clientCode, { startDate, endDate, ...filters });
  }

  private async queryTrades(
    clientCode: string,
    filters: {
      symbol?: string;
      isin?: string;
      startDate?: string;
      endDate?: string;
      tradeTypes?: TradeType[];
    }
  ): Promise<StoredTrade[]> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];

    const pageSize = SELECT_PAGE_SIZE;
    const all: StoredTrade[] = [];
    for (let from = 0; ; from += pageSize) {
      let query = this.supabase.client
        .from('trades')
        .select('*')
        .eq('user_id', uid)
        .eq('client_code', clientCode);

      /**
       * A stock row is merged by display symbol, so it can cover more than one ISIN once a
       * split issues a new one. Matching either column keeps those trades with their stock.
       */
      const identityFilters = [
        filters.isin ? `isin.eq.${filters.isin}` : '',
        filters.symbol ? `symbol.eq.${filters.symbol}` : '',
      ].filter(Boolean);
      if (identityFilters.length > 1) query = query.or(identityFilters.join(','));
      else if (filters.isin) query = query.eq('isin', filters.isin);
      else if (filters.symbol) query = query.eq('symbol', filters.symbol);
      if (filters.startDate) query = query.gte('sell_date', filters.startDate);
      if (filters.endDate) query = query.lte('sell_date', filters.endDate);

      const { data, error } = await query
        .order('sell_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data?.length) break;
      all.push(...data.map((row) => tradeFromRow(row)));
      if (data.length < pageSize) break;
    }

    const deduped = uniqueByKey(all, (trade) => trade.dedupeKey);
    if (filters.tradeTypes?.length && !filters.tradeTypes.includes('all')) {
      return deduped.filter((trade) => tradeMatchesTypeFilter(trade, filters.tradeTypes));
    }
    return deduped;
  }

  async getFilteredStockSummaries(
    clientCode: string,
    filters: { startDate?: string; endDate?: string; tradeTypes?: TradeType[] }
  ): Promise<StockSummary[]> {
    const trades = await this.queryTrades(clientCode, {
      startDate: filters.startDate,
      endDate: filters.endDate,
      tradeTypes: filters.tradeTypes,
    });
    if (!trades.length) return [];

    const clients = await this.clientSvc.listClients();
    const client = clients.find((c) => c.clientCode === clientCode);
    const clientName = client?.clientName ?? clientCode;
    const profiles = this.buildStockProfilesFromTrades(trades, clientCode, clientName);
    return profiles.map((profile) => profileToStockSummary(profile));
  }

  /** Rebuild stock profiles (including per-type breakdown) from all trades. */
  async rebuildStockProfiles(clientCode: string): Promise<StockProfile[]> {
    const clients = await this.clientSvc.listClients();
    const client = clients.find((c) => c.clientCode === clientCode);
    const clientName = client?.clientName ?? clientCode;
    let trades = await this.getAllTrades(clientCode);
    if (!trades.length) return [];

    trades = await this.resyncCorporateActionIdentities(trades);

    const profiles = this.buildStockProfilesFromTrades(trades, clientCode, clientName);
    try {
      await this.writeStockProfiles(clientCode, profiles);
      await this.writeAnalyticsDaily(clientCode, buildDailyAnalyticsFromTrades(trades));
    } catch (error) {
      console.warn('Could not persist rebuilt stock profiles', error);
    }
    return profiles;
  }

  /**
   * Re-apply corporate-action surviving ISINs/tickers onto ledger trades and persist
   * identity fields so merge/split pairs (Mindtree/LTIM, TV18/NETWORK18) collapse.
   */
  private async resyncCorporateActionIdentities(trades: StoredTrade[]): Promise<StoredTrade[]> {
    try {
      await this.corporateActions.ensureSeeded();
      const actions = await this.corporateActions.listAll();
      if (!actions.length) return trades;

      const remapped = applyCorporateActionsToTrades(trades, actions) as StoredTrade[];
      const changed = remapped.filter((trade, index) => {
        const before = trades[index];
        return (
          normalizeIsin(before.isin) !== normalizeIsin(trade.isin) ||
          (before.symbol || '') !== (trade.symbol || '') ||
          before.stockName !== trade.stockName ||
          (before.corporateActionId || '') !== (trade.corporateActionId || '') ||
          normalizeIsin(before.originalIsin) !== normalizeIsin(trade.originalIsin)
        );
      });
      if (changed.length) {
        const uid = await this.auth.getDataUserId();
        if (uid) await this.commitTradesInChunks(changed, uid);
      }
      return remapped;
    } catch (error) {
      console.warn('Could not resync corporate-action identities', error);
      return trades;
    }
  }

  async ensureStockProfilesWithBreakdown(clientCode: string, profiles: StockProfile[]): Promise<StockProfile[]> {
    if (profiles.length && profilesHaveTypeBreakdown(profiles)) return profiles;
    try {
      return await this.rebuildStockProfiles(clientCode);
    } catch (error) {
      console.warn('Could not rebuild stock profiles with trade-type breakdown', error);
      const clients = await this.clientSvc.listClients();
      const client = clients.find((c) => c.clientCode === clientCode);
      const clientName = client?.clientName ?? clientCode;
      const trades = await this.getAllTrades(clientCode);
      if (!trades.length) return profiles;
      return this.buildStockProfilesFromTrades(trades, clientCode, clientName);
    }
  }

  mergeTradesIntoReport(report: Report, trades: StoredTrade[]): Report {
    const merged = this.buildReportFromStoredData(
      trades,
      report.summary.clientCode,
      report.summary.clientName,
      undefined,
      undefined,
      {
        totalTradeCount: trades.length,
        tradesLoaded: true,
        holdings: report.unrealisedHoldings,
      }
    );
    return {
      ...merged,
      // Keep the statement window stable across trade hydration / silent refresh so
      // MTD/Last presets do not flip to Custom when bounds briefly change.
      dateRange:
        report.dateRange?.min && report.dateRange?.max ? report.dateRange : merged.dateRange,
      charges: report.charges,
      summary: {
        ...report.summary,
        realisedPnL: merged.summary.realisedPnL,
        unrealisedPnL:
          report.summary.unrealisedPnL ||
          (report.unrealisedHoldings ?? []).reduce((sum, holding) => sum + holding.unrealisedPnL, 0),
      },
      unrealisedHoldings: report.unrealisedHoldings ?? merged.unrealisedHoldings,
      unrealisedLots: report.unrealisedLots ?? merged.unrealisedLots,
    };
  }

  async buildReportFromClient(
    clientCode: string,
    options: { loadTrades?: boolean } = {}
  ): Promise<Report | null> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return null;

    const clients = await this.clientSvc.listClients();
    const client = clients.find((c) => c.clientCode === clientCode);
    const clientName = client?.clientName ?? clientCode;
    let stockProfiles = await this.getStockProfiles(clientCode);
    const totalTradeCount = await this.countTrades(clientCode);
    const holdings = await this.getHoldings(clientCode);

    if (!stockProfiles.length && totalTradeCount === 0 && !holdings.length) return null;

    let aggregatesRebuilt = false;
    if (totalTradeCount > 0) {
      const profileTradeSum = stockProfiles.reduce((sum, profile) => sum + profile.tradeCount, 0);
      const needsBreakdown = !stockProfiles.length || !profilesHaveTypeBreakdown(stockProfiles);
      const staleCounts =
        stockProfiles.length > 0 && profileTradeSum > 0 && profileTradeSum !== totalTradeCount;

      if (needsBreakdown || staleCounts) {
        if (staleCounts) {
          console.warn(
            `Stale stock_profiles for ${clientCode}: profile trades ${profileTradeSum} vs ledger ${totalTradeCount}; rebuilding`
          );
        }
        stockProfiles = await this.rebuildStockProfiles(clientCode);
        aggregatesRebuilt = true;
      }
    }

    const { data: lastUploadRow } = await this.supabase.client
      .from('uploads')
      .select('*')
      .eq('user_id', uid)
      .eq('client_code', clientCode)
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastUpload = lastUploadRow ? rowToCamel<UploadRecord>(lastUploadRow) : undefined;

    // Registry sync deliberately does NOT happen here. This is a read path, hit on every
    // navigation and by the periodic refresh, and syncing upserted the whole symbol universe
    // each time — which then fired the registry realtime channel and made every subscriber
    // refetch in response to our own write. `syncDerivedData` owns it on the upload path.

    const loadTrades = options.loadTrades !== false;
    const trades = loadTrades ? await this.getAllTrades(clientCode) : [];
    let dailyAnalytics = loadTrades ? undefined : await this.getAnalyticsDaily(clientCode);

    if (!loadTrades && totalTradeCount > 0) {
      if (aggregatesRebuilt) {
        dailyAnalytics = await this.getAnalyticsDaily(clientCode);
      } else {
        const dailyTradeSum = (dailyAnalytics ?? []).reduce((sum, row) => sum + row.tradeCount, 0);
        if (!dailyAnalytics?.length || dailyTradeSum !== totalTradeCount) {
          console.warn(
            `Stale analytics_daily for ${clientCode}: daily trades ${dailyTradeSum} vs ledger ${totalTradeCount}; rebuilding`
          );
          stockProfiles = await this.rebuildStockProfiles(clientCode);
          dailyAnalytics = await this.getAnalyticsDaily(clientCode);
        }
      }
    }

    const report = this.buildReportFromStoredData(
      trades,
      clientCode,
      clientName,
      lastUpload,
      stockProfiles,
      {
        totalTradeCount: totalTradeCount || client?.tradeCount || trades.length,
        tradesLoaded: loadTrades && trades.length > 0,
        dailyAnalytics,
        holdings,
      }
    );

    // Fast path without trades can still inherit a one-day CN upload window — expand from DB.
    if (
      uid &&
      report.dateRange.min &&
      report.dateRange.max &&
      (report.totalTradeCount ?? 0) > 0
    ) {
      const bounds = await this.getSellDateBounds(uid, clientCode);
      if (bounds) {
        report.dateRange = {
          min: [report.dateRange.min, bounds.min].filter(Boolean).sort()[0] || report.dateRange.min,
          max:
            [report.dateRange.max, bounds.max].filter(Boolean).sort().at(-1) || report.dateRange.max,
        };
      }
    }

    if (loadTrades && trades.length !== totalTradeCount && totalTradeCount > 0) {
      console.warn(
        `Trade count mismatch for ${clientCode}: fetched ${trades.length}, expected ${totalTradeCount}`
      );
      report.totalTradeCount = totalTradeCount;
    }

    return report;
  }

  /** Earliest/latest sell_date in the ledger — keeps All/MTD working after a one-day CN upload. */
  private async getSellDateBounds(
    userId: string,
    clientCode: string
  ): Promise<{ min: string; max: string } | null> {
    const base = () =>
      this.supabase.client
        .from('trades')
        .select('sell_date')
        .eq('user_id', userId)
        .eq('client_code', clientCode)
        .not('sell_date', 'is', null);

    const [{ data: earliest }, { data: latest }] = await Promise.all([
      base().order('sell_date', { ascending: true }).limit(1),
      base().order('sell_date', { ascending: false }).limit(1),
    ]);
    const min = earliest?.[0]?.sell_date ? String(earliest[0].sell_date) : '';
    const max = latest?.[0]?.sell_date ? String(latest[0].sell_date) : '';
    if (!min || !max) return null;
    return { min, max };
  }

  async getStockProfiles(clientCode: string): Promise<StockProfile[]> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];
    const clients = await this.clientSvc.listClients();
    const client = clients.find((c) => c.clientCode === clientCode);
    const clientName = client?.clientName ?? clientCode;

    const pageSize = 1000;
    const all: StockProfile[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await this.supabase.client
        .from('stock_profiles')
        .select('*')
        .eq('user_id', uid)
        .eq('client_code', clientCode)
        .order('net_pnl', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data?.length) break;
      all.push(...data.map((row) => profileFromRow(row, clientCode, clientName)));
      if (data.length < pageSize) break;
    }
    return mergeStockProfiles(all);
  }

  private async syncDerivedData(
    clientCode: string,
    clientName: string,
    options: {
      trades?: StoredTrade[];
      uploadMeta?: Omit<UploadRecord, 'id'>;
      holdings?: UnrealisedHolding[];
    } = {}
  ): Promise<Report | null> {
    const trades = options.trades ?? (await this.getAllTrades(clientCode));
    const holdings = options.holdings ?? (await this.getHoldings(clientCode));
    if (!trades.length && !holdings.length) return null;

    let uploadMeta = options.uploadMeta;
    if (!uploadMeta) {
      const uid = await this.auth.getDataUserId();
      if (uid) {
        const { data } = await this.supabase.client
          .from('uploads')
          .select('*')
          .eq('user_id', uid)
          .eq('client_code', clientCode)
          .order('uploaded_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        uploadMeta = data ? rowToCamel<UploadRecord>(data) : undefined;
      }
    }

    await this.clientSvc.registerClient(clientCode, clientName, trades.length, {
      totalRealisedPnL: trades.reduce((sum, trade) => sum + trade.realisedPnL, 0),
      totalNetPnL: trades.reduce((sum, trade) => sum + trade.netPnL, 0),
      totalCharges: trades.reduce((sum, trade) => sum + trade.allocatedCharges, 0),
      periodLabel: uploadMeta?.periodLabel,
    });

    const profiles = this.buildStockProfilesFromTrades(trades, clientCode, clientName);
    await this.writeStockProfiles(clientCode, profiles);
    await this.writeAnalyticsDaily(clientCode, buildDailyAnalyticsFromTrades(trades));
    await this.watchlists.syncPnlTierWatchlists(profiles);
    await this.registry.syncSymbols(
      [
        ...profiles.map((p) => ({ symbol: p.symbol, name: p.stockName, isin: p.isin })),
        ...holdings.map((h) => ({ symbol: h.symbol, name: h.stockName, isin: h.isin })),
      ],
      'pnl_upload'
    );
    await this.tagTradedSymbols([
      ...profiles.map((p) => p.symbol),
      ...holdings.map((h) => h.symbol),
    ]);

    return this.buildReportFromStoredData(
      trades,
      clientCode,
      clientName,
      uploadMeta,
      profiles,
      {
        totalTradeCount: trades.length,
        tradesLoaded: true,
        holdings,
      }
    );
  }

  private buildReportFromStoredData(
    trades: StoredTrade[],
    clientCode: string,
    clientName: string,
    uploadMeta: UploadRecord | Omit<UploadRecord, 'id'> | undefined,
    stockProfiles?: StockProfile[],
    meta?: {
      totalTradeCount?: number;
      tradesLoaded?: boolean;
      dailyAnalytics?: DailyAnalyticsRow[];
      holdings?: UnrealisedHolding[];
    }
  ): Report {
    const profiles = mergeStockProfiles(
      stockProfiles ??
      (trades.length ? this.buildStockProfilesFromTrades(trades, clientCode, clientName) : [])
    );
    const stockSummary = mergeStockSummaries(profiles.map((profile) => profileToStockSummary(profile)));
    const holdings = meta?.holdings ?? [];
    const holdingsPnL = holdings.reduce((sum, holding) => sum + holding.unrealisedPnL, 0);
    const plainTrades: Trade[] = trades.map(
      ({
        stockName,
        isin,
        quantity,
        buyDate,
        buyPrice,
        buyValue,
        sellDate,
        sellPrice,
        sellValue,
        realisedPnL,
        remark,
        tradeType,
        holdingDays,
        allocatedCharges,
        netPnL,
      }) => ({
        stockName,
        isin,
        quantity,
        buyDate,
        buyPrice,
        buyValue,
        sellDate,
        sellPrice,
        sellValue,
        realisedPnL,
        remark,
        tradeType,
        holdingDays,
        allocatedCharges,
        netPnL,
      })
    );

    const typeSet = new Set<TradeType>(['all']);
    plainTrades.forEach((t) => typeSet.add(t.tradeType));
    (meta?.dailyAnalytics ?? []).forEach((row) => typeSet.add(row.tradeType));
    profiles.forEach((profile) => {
      Object.keys(profile.byTradeType ?? {}).forEach((type) => typeSet.add(type as TradeType));
    });

    const dates = plainTrades.length
      ? plainTrades.map((t) => t.sellDate).sort()
      : (meta?.dailyAnalytics ?? []).map((row) => row.sellDate).sort();
    let dataMin = dates[0] || '';
    let dataMax = dates[dates.length - 1] || '';
    if (!dataMin || !dataMax) {
      const profileFirst = profiles
        .map((profile) => profile.dateRange?.first)
        .filter(Boolean)
        .sort();
      const profileLast = profiles
        .map((profile) => profile.dateRange?.last)
        .filter(Boolean)
        .sort();
      dataMin = dataMin || profileFirst[0] || '';
      dataMax = dataMax || profileLast[profileLast.length - 1] || '';
    }
    // Union upload window with actual trade/analytics span. A daily contract-note upload
    // stores periodStart=periodEnd=that day — using it alone collapsed All→Last and broke MTD.
    const rangeMin = [dataMin, uploadMeta?.periodStart].filter(Boolean).sort()[0] || '';
    const rangeMax =
      [dataMax, uploadMeta?.periodEnd].filter(Boolean).sort().at(-1) || '';
    const allocatedCharges =
      trades.length > 0
        ? trades.reduce((sum, trade) => sum + trade.allocatedCharges, 0)
        : profiles.reduce((sum, profile) => sum + profile.allocatedCharges, 0);
    const realisedPnL =
      plainTrades.length > 0
        ? plainTrades.reduce((sum, trade) => sum + trade.realisedPnL, 0)
        : profiles.reduce((sum, profile) => sum + profile.realisedPnL, 0);
    const totalTradeCount = meta?.totalTradeCount ?? plainTrades.length;

    return {
      summary: {
        clientName,
        clientCode,
        period: uploadMeta?.periodLabel ?? 'All trades',
        realisedPnL,
        unrealisedPnL: holdings.length ? holdingsPnL : (uploadMeta?.reportUnrealisedPnL ?? 0),
      },
      charges: {
        items: uploadMeta?.charges ?? [],
        total: uploadMeta?.chargesTotal ?? allocatedCharges,
      },
      trades: plainTrades,
      stockSummary,
      stockProfiles: profiles,
      unrealisedHoldings: holdings,
      unrealisedLots: holdings.flatMap((holding) => holding.lots ?? []),
      dateRange: {
        min: rangeMin,
        max: rangeMax,
      },
      tradeTypes: plainTrades.length || typeSet.size > 1
        ? (ALL_REPORT_TRADE_TYPES.filter((t) => typeSet.has(t)) as TradeType[])
        : DEFAULT_REPORT_TRADE_TYPES,
      totalTradeCount,
      tradesLoaded: meta?.tradesLoaded ?? plainTrades.length > 0,
      dailyAnalytics: meta?.dailyAnalytics,
    };
  }

  async getAnalyticsDaily(clientCode: string): Promise<DailyAnalyticsRow[]> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];

    const pageSize = 1000;
    const all: DailyAnalyticsRow[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await this.supabase.client
        .from('analytics_daily')
        .select('*')
        .eq('user_id', uid)
        .eq('client_code', clientCode)
        .order('sell_date', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data?.length) break;
      all.push(...data.map((row) => dailyAnalyticsFromRow(row)));
      if (data.length < pageSize) break;
    }
    return all;
  }

  private async writeAnalyticsDaily(
    clientCode: string,
    rows: DailyAnalyticsRow[]
  ): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return;

    const { error: deleteError } = await this.supabase.client
      .from('analytics_daily')
      .delete()
      .eq('user_id', uid)
      .eq('client_code', clientCode);
    if (deleteError) throw deleteError;

    const uniqueRows = uniqueByKey(rows, (row) => `${row.sellDate}::${row.tradeType}`);
    for (let i = 0; i < uniqueRows.length; i += UPSERT_BATCH_LIMIT) {
      const chunk = uniqueRows
        .slice(i, i + UPSERT_BATCH_LIMIT)
        .map((row) => dailyAnalyticsToRow(row, uid, clientCode));
      const { error } = await this.supabase.client.from('analytics_daily').upsert(chunk);
      if (error) throw error;
    }
  }

  private buildStockProfilesFromTrades(
    trades: StoredTrade[],
    clientCode: string,
    clientName: string
  ): StockProfile[] {
    const identified = fillMissingIsins(trades);
    const byKey = new Map<string, StoredTrade[]>();
    for (const trade of identified) {
      const key = stockIdentityKey(trade);
      const list = byKey.get(key) ?? [];
      list.push(trade);
      byKey.set(key, list);
    }

    return mergeStockProfiles(
      [...byKey.values()].map((symbolTrades) => {
        const symbol =
          preferStockSymbol(
            symbolTrades.find((trade) => trade.symbol)?.symbol,
            normalizeSymbol(symbolTrades[0].stockName)
          ) || normalizeSymbol(symbolTrades[0].stockName);
        return this.buildStockProfile(symbol, symbolTrades, clientCode, clientName);
      })
    );
  }

  private buildStockProfile(
    symbol: string,
    trades: StoredTrade[],
    clientCode: string,
    clientName: string
  ): StockProfile {
    let winningTrades = 0,
      losingTrades = 0,
      breakEvenTrades = 0;
    let totalBuyValue = 0,
      totalSellValue = 0,
      grossProfit = 0,
      grossLoss = 0;
    let realisedPnL = 0,
      allocatedCharges = 0,
      netPnL = 0,
      holdingDaysSum = 0;
    const uploadIds = new Set<string>();
    const byType = new Map<TradeType, StoredTrade[]>();
    let first = trades[0].sellDate,
      last = trades[0].sellDate;

    for (const t of trades) {
      totalBuyValue += t.buyValue;
      totalSellValue += t.sellValue;
      realisedPnL += t.realisedPnL;
      allocatedCharges += t.allocatedCharges;
      netPnL += t.netPnL;
      holdingDaysSum += t.holdingDays;
      uploadIds.add(t.uploadId);
      if (t.realisedPnL > 0) {
        winningTrades++;
        grossProfit += t.realisedPnL;
      } else if (t.realisedPnL < 0) {
        losingTrades++;
        grossLoss += t.realisedPnL;
      } else breakEvenTrades++;
      if (t.sellDate < first) first = t.sellDate;
      if (t.sellDate > last) last = t.sellDate;
      const effectiveType = effectiveTradeType(t);
      const list = byType.get(effectiveType) ?? [];
      list.push(t);
      byType.set(effectiveType, list);
    }

    const tradeCount = trades.length;
    const byTradeType: StockProfile['byTradeType'] = {};
    for (const [type, typeTrades] of byType) {
      if (type !== 'all') byTradeType[type] = buildTradeTypeStats(typeTrades);
    }

    return {
      symbol,
      stockName: trades[0].stockName,
      isin: normalizeIsin(trades.find((trade) => trade.isin)?.isin ?? trades[0].isin),
      clientCode,
      clientName,
      tradeCount,
      winningTrades,
      losingTrades,
      breakEvenTrades,
      winRate: tradeCount ? (winningTrades / tradeCount) * 100 : 0,
      totalBuyValue,
      totalSellValue,
      grossProfit,
      grossLoss,
      realisedPnL,
      allocatedCharges,
      netPnL,
      netPnLPct: totalBuyValue ? (netPnL / totalBuyValue) * 100 : 0,
      avgHoldingDays: tradeCount ? holdingDaysSum / tradeCount : 0,
      dateRange: { first, last },
      byTradeType,
      uploadIds: [...uploadIds],
      updatedAt: Date.now(),
    };
  }

  /**
   * Upserts the upload record, so re-uploading a file refreshes its row rather than adding a
   * second one. Falls back to omitting `trades_replaced` while migration 018 is still pending
   * on a remote database, since a failed write here would block the whole import.
   */
  private async writeUploadRecord(
    uploadId: string,
    userId: string,
    record: Omit<UploadRecord, 'id'>
  ): Promise<void> {
    const write = (payload: Omit<UploadRecord, 'id'> | Omit<UploadRecord, 'id' | 'tradesReplaced'>) =>
      this.supabase.client
        .from('uploads')
        .upsert(objectToSnake({ id: uploadId, userId, ...payload }));

    if (this.uploadsSupportTradesReplaced === false) {
      const { tradesReplaced: _omitted, ...rest } = record;
      const { error } = await write(rest);
      if (error) throw error;
      return;
    }

    const { error } = await write(record);
    if (!error) {
      this.uploadsSupportTradesReplaced = true;
      return;
    }
    if (!isMissingColumnError(error, 'trades_replaced')) throw error;

    this.uploadsSupportTradesReplaced = false;
    const { tradesReplaced: _omitted, ...rest } = record;
    const { error: retryError } = await write(rest);
    if (retryError) throw retryError;
  }

  /** Finds a previous upload of this exact file, so re-uploads refresh rather than duplicate. */
  private async findUploadByContentHash(
    userId: string,
    clientCode: string,
    contentHash: string
  ): Promise<string | null> {
    const { data } = await this.supabase.client
      .from('uploads')
      .select('id')
      .eq('user_id', userId)
      .eq('client_code', clientCode)
      .eq('content_hash', contentHash)
      .limit(1)
      .maybeSingle();
    return data?.id ? String(data.id) : null;
  }

  /**
   * Clears every stored trade whose sell date falls in [start, end]. A full-window Groww
   * statement owns that interval completely; wiping it first makes re-import idempotent and
   * removes orphans left by older ingest bugs.
   *
   * PostgREST caps how many rows a single DELETE…RETURNING can touch, so we loop until the
   * window is empty rather than trusting one shot to clear multi-thousand-row ledgers.
   */
  private async deleteTradesInSellDateRange(
    userId: string,
    clientCode: string,
    start: string,
    end: string
  ): Promise<number> {
    if (!start || !end) return 0;
    let removed = 0;
    for (;;) {
      const { data, error } = await this.supabase.client
        .from('trades')
        .delete()
        .eq('user_id', userId)
        .eq('client_code', clientCode)
        .gte('sell_date', start)
        .lte('sell_date', end)
        .select('id')
        .limit(SELECT_PAGE_SIZE);
      if (error) throw error;
      const batch = data?.length ?? 0;
      removed += batch;
      if (batch < SELECT_PAGE_SIZE) break;
    }
    return removed;
  }

  private async applyCorporateActionsToReport(report: Report): Promise<void> {
    try {
      await this.corporateActions.ensureSeeded();
      const actions = await this.corporateActions.listAll();
      if (!actions.length) return;

      report.trades = applyCorporateActionsToTrades(
        report.trades.map((trade) => ({
          ...trade,
          symbol: (trade as Trade & { symbol?: string }).symbol,
        })),
        actions
      );

      if (report.stockSummary.length) {
        report.stockSummary = report.stockSummary.map((stock) => {
          const remapped = applyCorporateActionsToTrades(
            [
              {
                stockName: stock.stockName,
                isin: stock.isin,
                symbol: stock.symbol,
                quantity: 0,
                buyDate: '',
                buyPrice: 0,
                buyValue: 0,
                sellDate: '',
                sellPrice: 0,
                sellValue: 0,
                realisedPnL: 0,
                remark: '',
                tradeType: 'delivery' as const,
                holdingDays: 0,
              },
            ],
            actions
          )[0];
          return {
            ...stock,
            symbol: remapped.symbol || stock.symbol,
            stockName: remapped.stockName || stock.stockName,
            isin: remapped.isin || stock.isin,
          };
        });
      }

      if (report.unrealisedHoldings?.length) {
        report.unrealisedHoldings = report.unrealisedHoldings.map((holding) => {
          const remapped = applyCorporateActionsToTrades(
            [
              {
                stockName: holding.stockName,
                isin: holding.isin,
                symbol: holding.symbol,
                quantity: holding.quantity,
                buyDate: '',
                buyPrice: holding.avgBuyPrice,
                buyValue: holding.buyValue,
                sellDate: '',
                sellPrice: 0,
                sellValue: 0,
                realisedPnL: 0,
                remark: '',
                tradeType: 'delivery' as const,
                holdingDays: 0,
              },
            ],
            actions
          )[0];
          return {
            ...holding,
            symbol: remapped.symbol || holding.symbol,
            stockName: remapped.stockName || holding.stockName,
            isin: remapped.isin || holding.isin,
          };
        });
      }
    } catch {
      // Corporate actions table may be missing until migration 020 is applied.
    }
  }

  private applyIdentity(report: Report, resolver: StockIdentityResolver): void {
    const knownIsins = collectIsinsByName([
      ...report.trades,
      ...report.stockSummary,
      ...(report.unrealisedHoldings ?? []),
      ...(report.unrealisedLots ?? []),
    ]);
    report.trades = applyKnownIsins(report.trades, knownIsins).map((trade) => {
      const identity = resolver.resolve(trade.isin, trade.stockName);
      return { ...trade, isin: identity.isin };
    });
    if (report.unrealisedLots?.length) {
      report.unrealisedLots = applyKnownIsins(report.unrealisedLots, knownIsins).map((lot) => {
        const identity = resolver.resolve(lot.isin, lot.stockName);
        return { ...lot, isin: identity.isin };
      });
    }
    if (report.unrealisedHoldings?.length) {
      report.unrealisedHoldings = mergeUnrealisedHoldings(
        applyKnownIsins(report.unrealisedHoldings, knownIsins).map((holding) => {
          const identity = resolver.resolve(holding.isin, holding.stockName, holding.symbol);
          return {
            ...holding,
            isin: identity.isin,
            symbol: identity.symbol,
            lots: applyKnownIsins(holding.lots ?? [], knownIsins).map((lot) => ({
              ...lot,
              isin: resolver.resolve(lot.isin, lot.stockName).isin,
            })),
          };
        })
      );
    }
    if (report.stockSummary.length) {
      report.stockSummary = mergeStockSummaries(
        applyKnownIsins(report.stockSummary, knownIsins).map((stock) => {
          const identity = resolver.resolve(stock.isin, stock.stockName, stock.symbol);
          return { ...stock, isin: identity.isin, symbol: identity.symbol };
        })
      );
    }
  }

  private async buildIdentityResolver(report: Report): Promise<StockIdentityResolver> {
    const hints: IdentityHint[] = [];
    try {
      const registry = await this.registry.listAll();
      for (const stock of registry) {
        hints.push({
          symbol: stock.symbol,
          name: stock.name,
          isin: stock.isin,
          exchange: stock.exchange,
        });
      }
    } catch {
      // Registry may be empty on a fresh account.
    }

    const isins = [
      ...report.trades.map((trade) => normalizeIsin(trade.isin)),
      ...(report.unrealisedHoldings ?? []).map((holding) => normalizeIsin(holding.isin)),
      ...(report.stockSummary ?? []).map((stock) => normalizeIsin(stock.isin)),
    ].filter(Boolean);
    hints.push(...(await this.lookupMarketTickersByIsin(isins)));

    return StockIdentityResolver.fromHints(hints);
  }

  private async lookupMarketTickersByIsin(isins: string[]): Promise<IdentityHint[]> {
    const unique = [...new Set(isins.map(normalizeIsin).filter(Boolean))];
    if (!unique.length) return [];
    const hints: IdentityHint[] = [];
    const chunkSize = 200;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const { data, error } = await this.supabase.client
        .from('stocks')
        .select('symbol, name, isin, exchange')
        .in('isin', chunk);
      if (error) return hints;
      for (const row of data ?? []) {
        const camel = rowToCamel<Record<string, unknown>>(row);
        const symbol = String(camel['symbol'] ?? '').toUpperCase();
        const isin = normalizeIsin(String(camel['isin'] ?? ''));
        if (!symbol || !isin) continue;
        hints.push({
          symbol,
          name: String(camel['name'] ?? symbol),
          isin,
          exchange: String(camel['exchange'] ?? 'NSE'),
        });
      }
    }
    return hints;
  }

  private async commitTradesInChunks(trades: StoredTrade[], userId: string): Promise<void> {
    for (let i = 0; i < trades.length; i += UPSERT_BATCH_LIMIT) {
      let chunk = uniqueByKey(
        trades.slice(i, i + UPSERT_BATCH_LIMIT).map((t) => tradeToRow(t, userId)),
        (row) => String(row['id'] ?? '')
      );
      if (this.tradesSupportSource === false) {
        chunk = chunk.map(({ source: _s, ...rest }) => rest);
      }
      if (this.tradesSupportCorporateAction === false) {
        chunk = chunk.map((row) => stripCorporateActionColumns(row));
      }
      let { error } = await this.supabase.client.from('trades').upsert(chunk);
      if (error && this.tradesSupportSource !== false && isMissingColumnError(error, 'source')) {
        this.tradesSupportSource = false;
        chunk = chunk.map(({ source: _s, ...rest }) => rest);
        ({ error } = await this.supabase.client.from('trades').upsert(chunk));
      } else if (!error && this.tradesSupportSource !== false) {
        this.tradesSupportSource = true;
      }
      if (
        error &&
        this.tradesSupportCorporateAction !== false &&
        (isMissingColumnError(error, 'corporate_action_id') ||
          isMissingColumnError(error, 'original_symbol'))
      ) {
        this.tradesSupportCorporateAction = false;
        chunk = chunk.map((row) => stripCorporateActionColumns(row));
        ({ error } = await this.supabase.client.from('trades').upsert(chunk));
      } else if (!error && this.tradesSupportCorporateAction !== false) {
        this.tradesSupportCorporateAction = true;
      }
      if (error) throw error;
    }
  }

  private async writeStockProfiles(clientCode: string, profiles: StockProfile[]): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return;

    const { error: deleteError } = await this.supabase.client
      .from('stock_profiles')
      .delete()
      .eq('user_id', uid)
      .eq('client_code', clientCode);
    if (deleteError) throw deleteError;
    if (!profiles.length) return;

    const uniqueProfiles = uniqueByKey(mergeStockProfiles(profiles), (profile) =>
      (profile.symbol ?? '').trim().toUpperCase()
    );
    const includeByTradeType = this.stockProfilesSupportByTradeType !== false;
    for (let i = 0; i < uniqueProfiles.length; i += UPSERT_BATCH_LIMIT) {
      const slice = uniqueProfiles.slice(i, i + UPSERT_BATCH_LIMIT);
      let chunk = slice.map((profile) =>
        profileToRow(profile, uid, { includeByTradeType })
      );
      let { error } = await this.supabase.client.from('stock_profiles').upsert(chunk);
      if (error && includeByTradeType && isMissingColumnError(error, 'by_trade_type')) {
        this.stockProfilesSupportByTradeType = false;
        chunk = slice.map((profile) => profileToRow(profile, uid, { includeByTradeType: false }));
        ({ error } = await this.supabase.client.from('stock_profiles').upsert(chunk));
      } else if (!error && includeByTradeType) {
        this.stockProfilesSupportByTradeType = true;
      }
      if (error) throw error;
    }
  }

  async getHoldings(clientCode: string): Promise<UnrealisedHolding[]> {
    if (this.holdingsTableAvailable === false) return [];
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];

    const { data, error } = await this.supabase.client
      .from('unrealised_holdings')
      .select('*')
      .eq('user_id', uid)
      .eq('client_code', clientCode)
      .order('unrealised_pnl', { ascending: false });

    if (error) {
      if (isMissingRelationError(error)) {
        this.holdingsTableAvailable = false;
        return [];
      }
      throw error;
    }
    this.holdingsTableAvailable = true;
    return mergeUnrealisedHoldings((data ?? []).map((row) => holdingFromRow(row as Record<string, unknown>)));
  }

  private async replaceHoldings(clientCode: string, holdings: UnrealisedHolding[]): Promise<void> {
    if (this.holdingsTableAvailable === false) return;
    const uid = await this.auth.getDataUserId();
    if (!uid) return;

    const { error: deleteError } = await this.supabase.client
      .from('unrealised_holdings')
      .delete()
      .eq('user_id', uid)
      .eq('client_code', clientCode);
    if (deleteError) {
      if (isMissingRelationError(deleteError)) {
        this.holdingsTableAvailable = false;
        return;
      }
      throw deleteError;
    }

    if (!holdings.length) {
      this.holdingsTableAvailable = true;
      return;
    }

    const rows = uniqueByKey(
      mergeUnrealisedHoldings(holdings).map((holding) => holdingToRow(holding, uid, clientCode)),
      (row) => String(row['symbol'] ?? '').toUpperCase()
    );
    const { error } = await this.supabase.client.from('unrealised_holdings').upsert(rows);
    if (error) {
      if (isMissingRelationError(error)) {
        this.holdingsTableAvailable = false;
        return;
      }
      throw error;
    }
    this.holdingsTableAvailable = true;
  }

  private async deleteHoldings(clientCode: string): Promise<void> {
    if (this.holdingsTableAvailable === false) return;
    const uid = await this.auth.getDataUserId();
    if (!uid) return;
    const { error } = await this.supabase.client
      .from('unrealised_holdings')
      .delete()
      .eq('user_id', uid)
      .eq('client_code', clientCode);
    if (error && isMissingRelationError(error)) {
      this.holdingsTableAvailable = false;
      return;
    }
    if (error) throw error;
  }

  /**
   * Drop previously ingested mark-to-market rows for still-held lots.
   * Groww writes open positions with the report's closing date as a fake sell,
   * so each new file otherwise re-adds the same holding to realised P&L.
   */
  private async purgeMarkToMarketTrades(clientCode: string, report: Report): Promise<number> {
    const lots = report.unrealisedLots?.length
      ? report.unrealisedLots
      : (report.unrealisedHoldings ?? []).flatMap((holding) => holding.lots ?? []);
    if (!lots.length) return 0;

    const openKeys = new Set(
      lots.map((lot) => buyLotKey(lot.isin, lot.buyDate, lot.quantity, lot.buyPrice))
    );
    // Sell dates per buy lot, so the scan below is a lookup instead of a nested search over
    // every uploaded trade. Without this the filter is O(stored x uploaded).
    const realisedSellDates = new Map<string, Set<string>>();
    for (const trade of report.trades) {
      const key = buyLotKey(trade.isin, trade.buyDate, trade.quantity, trade.buyPrice);
      const dates = realisedSellDates.get(key);
      if (dates) dates.add(trade.sellDate);
      else realisedSellDates.set(key, new Set([trade.sellDate]));
    }
    const periodEnds = await this.loadUploadPeriodEnds(clientCode);
    for (const lot of lots) {
      if (lot.closingDate) periodEnds.add(lot.closingDate);
    }

    const stored = await this.getAllTrades(clientCode);
    const toDelete = stored
      .filter((trade) => {
        const key = buyLotKey(trade.isin, trade.buyDate, trade.quantity, trade.buyPrice);
        if (openKeys.has(key)) return true;
        const sellDates = realisedSellDates.get(key);
        if (!sellDates || !periodEnds.has(trade.sellDate)) return false;
        return !sellDates.has(trade.sellDate);
      })
      .map((trade) => trade.dedupeKey)
      .filter(Boolean);

    const uniqueIds = [...new Set(toDelete)];
    for (let i = 0; i < uniqueIds.length; i += UPSERT_BATCH_LIMIT) {
      const chunk = uniqueIds.slice(i, i + UPSERT_BATCH_LIMIT);
      const { error } = await this.supabase.client.from('trades').delete().in('id', chunk);
      if (error) throw error;
    }
    return uniqueIds.length;
  }

  private async loadUploadPeriodEnds(clientCode: string): Promise<Set<string>> {
    const uid = await this.auth.getDataUserId();
    const ends = new Set<string>();
    if (!uid) return ends;
    const { data, error } = await this.supabase.client
      .from('uploads')
      .select('period_end')
      .eq('user_id', uid)
      .eq('client_code', clientCode);
    if (error) return ends;
    for (const row of data ?? []) {
      const end = String((row as { period_end?: string }).period_end ?? '');
      if (end) ends.add(end);
    }
    return ends;
  }

  private async deleteClientData(clientCode: string): Promise<void> {
    const uid = await this.auth.getDataUserId();
    if (!uid) return;
    await this.deleteTableRows('trades', uid, clientCode);
    await this.deleteTableRows('uploads', uid, clientCode);
    await this.deleteTableRows('stock_profiles', uid, clientCode);
    await this.deleteTableRows('analytics_daily', uid, clientCode);
    await this.deleteHoldings(clientCode);
    await this.clientSvc.deleteClient(clientCode);
  }

  private async deleteTableRows(
    table: 'trades' | 'uploads' | 'stock_profiles' | 'analytics_daily',
    userId: string,
    clientCode: string
  ): Promise<void> {
    const { error } = await this.supabase.client
      .from(table)
      .delete()
      .eq('user_id', userId)
      .eq('client_code', clientCode);
    if (error) throw error;
  }
}

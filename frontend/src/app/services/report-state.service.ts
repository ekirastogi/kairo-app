import { Injectable, inject, signal, computed } from '@angular/core';
import {
  AnalysisOptions,
  AnalysisResult,
  PeriodBucket,
  Report,
  ReportHistoryEntry,
  TradeType,
} from '../models/trade.models';
import { UI_CACHE_TTL_MS } from '../constants/cache.constants';
import { AnalysisService } from './analysis.service';
import { ParserService } from './parser.service';
import { TradeLedgerService } from './trade-ledger.service';
import { ClientAccountService } from './client-account.service';
import { AuthService } from './auth.service';
import { DateRangePresetId } from '../utils/date-range-preset.utils';

const MAX_REPORT_HISTORY = 5;
const HISTORY_STORAGE_KEY = 'groww-pl-report-history';
const FIREBASE_REPORT_CACHE_PREFIX = 'kairo-firebase-report-v3';

interface CachedFirebaseReport {
  savedAt: number;
  report: Report;
}
const DEFAULT_TRADE_TYPES: TradeType[] = ['all'];

function firebaseReportCacheKey(uid: string, clientCode: string): string {
  return `${FIREBASE_REPORT_CACHE_PREFIX}:${uid}:${clientCode}`;
}

function defaultTradeTypesForReport(_report: Report): TradeType[] {
  return DEFAULT_TRADE_TYPES;
}

/** Cheap identity for silent refresh — skip report.set when nothing material changed. */
function reportFingerprint(report: Report): string {
  return [
    report.summary.clientCode,
    report.summary.realisedPnL,
    report.summary.unrealisedPnL,
    report.dateRange?.min ?? '',
    report.dateRange?.max ?? '',
    report.totalTradeCount ?? report.trades.length,
    report.stockSummary?.length ?? 0,
    report.stockProfiles?.length ?? 0,
    report.unrealisedHoldings?.length ?? 0,
    report.charges?.total ?? 0,
    report.tradesLoaded ? 1 : 0,
  ].join('|');
}

@Injectable({ providedIn: 'root' })
export class ReportStateService {
  private parser = inject(ParserService);
  private analysisService = inject(AnalysisService);
  private ledger = inject(TradeLedgerService);
  private clientSvc = inject(ClientAccountService);
  private auth = inject(AuthService);
  private periodicRefreshStarted = false;
  private periodicRefreshTimer?: number;
  private tradesLoadPromise: Promise<void> | null = null;

  report = signal<Report | null>(null);
  reportHistory = signal<ReportHistoryEntry[]>(this.loadHistoryFromStorage());
  activeHistoryId = signal<string | null>(null);
  activeClientCode = signal<string | null>(null);
  dataSource = signal<'local' | 'firebase'>('local');
  loading = signal(false);
  tradesLoading = signal(false);
  error = signal<string | null>(null);

  startDate = signal('');
  endDate = signal('');
  /** User-owned date preset (All/MTD/Last/…). Never inferred away by background logic. */
  datePeriod = signal<DateRangePresetId | 'custom'>('inception');
  selectedTradeTypes = signal<TradeType[]>(DEFAULT_TRADE_TYPES);
  chartPeriod = signal<'daily' | 'weekly' | 'monthly'>('daily');
  topStocksCount = signal(10);

  analysisOptions = computed<AnalysisOptions>(() => ({
    startDate: this.startDate(),
    endDate: this.endDate(),
    tradeTypes: this.selectedTradeTypes(),
  }));

  analysis = computed<AnalysisResult | null>(() => {
    const report = this.report();
    if (!report) return null;
    return this.analysisService.analyze(report, this.analysisOptions());
  });

  chartPeriodData = computed<PeriodBucket[]>(() => {
    const analysis = this.analysis();
    if (!analysis) return [];
    switch (this.chartPeriod()) {
      case 'weekly':
        return analysis.weekly;
      case 'monthly':
        return analysis.monthly;
      default:
        return analysis.daily;
    }
  });

  hasReport = computed(() => !!this.report());
  hasHistory = computed(() => this.reportHistory().length > 0);
  isFirebaseBacked = computed(() => this.dataSource() === 'firebase');

  /** Disabled — filters must not change unless the user acts. Kept as a no-op for callers. */
  startPeriodicRefresh(): void {
    this.stopPeriodicRefresh();
  }

  /** Stop the background refresh — called on sign-out so it does not outlive the session. */
  stopPeriodicRefresh(): void {
    if (this.periodicRefreshTimer != null) {
      clearInterval(this.periodicRefreshTimer);
      this.periodicRefreshTimer = undefined;
    }
    this.periodicRefreshStarted = false;
  }

  private async refreshFirebaseReportSilently(): Promise<void> {
    // Intentionally empty — automatic refresh was overwriting date filters (e.g. All → Last).
  }

  async loadFromClient(clientCode: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.auth.whenReady();
      const report = await this.ledger.buildReportFromClient(clientCode, { loadTrades: false });
      if (!report) {
        throw new Error('No trades found for this account. Upload a P&L file first.');
      }
      this.clientSvc.selectClient(clientCode);
      this.activeClientCode.set(clientCode);
      this.dataSource.set('firebase');
      this.applyFirebaseReport(report);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load saved trades';
      this.error.set(message);
      // Keep any already-loaded report on screen. Re-throwing here surfaced a
      // red banner even when P&L from the previous successful load was correct.
      if (!this.report()) throw e;
    } finally {
      this.loading.set(false);
    }
  }

  /** Load individual trades when the report only has stock-level aggregates (Firebase fast path). */
  async ensureTradesLoaded(): Promise<void> {
    const report = this.report();
    if (!report) return;
    if (report.tradesLoaded && report.trades.length > 0) return;
    if (this.dataSource() === 'local' && report.trades.length > 0) {
      this.report.update((current) =>
        current ? { ...current, tradesLoaded: true } : current
      );
      return;
    }

    const clientCode = this.activeClientCode() ?? report.summary.clientCode;
    if (!clientCode) return;

    const needsTrades =
      (report.totalTradeCount ?? 0) > 0 ||
      (report.stockSummary?.length ?? 0) > 0;
    if (!needsTrades) return;

    if (this.tradesLoadPromise) {
      await this.tradesLoadPromise;
      return;
    }

    this.tradesLoading.set(true);
    this.tradesLoadPromise = (async () => {
      try {
        const trades = await this.ledger.getAllTrades(clientCode);
        if (!trades.length) return;

        const current = this.report();
        if (!current) return;

        const merged = this.ledger.mergeTradesIntoReport(current, trades);
        merged.tradesLoaded = true;
        merged.totalTradeCount = current.totalTradeCount ?? trades.length;
        merged.summary = {
          ...merged.summary,
          period: current.summary.period,
          unrealisedPnL: current.summary.unrealisedPnL,
        };
        merged.unrealisedHoldings = current.unrealisedHoldings;
        merged.unrealisedLots = current.unrealisedLots;
        this.applyFirebaseReport(merged);
      } catch (e) {
        // Stock/daily aggregates already drive P&L. A flaky trade-row fetch
        // must not replace a working dashboard with an unhandled error banner.
        console.warn('Trade detail load failed; keeping aggregate P&L', e);
      } finally {
        this.tradesLoading.set(false);
        this.tradesLoadPromise = null;
      }
    })();

    await this.tradesLoadPromise;
  }

  async ensureLoadedFromFirebase(forceRefresh = false): Promise<void> {
    if (!forceRefresh && this.report() && this.dataSource() === 'firebase') {
      const current = this.report();
      if (current && this.isValidReport(current)) return;
      this.report.set(null);
    }

    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) return;

    const selected = this.clientSvc.selectedClientCode();
    if (selected && !forceRefresh) {
      const cached = this.restoreFirebaseReportFromCache(uid, selected);
      if (cached) {
        this.clientSvc.selectClient(selected);
        this.activeClientCode.set(selected);
        this.dataSource.set('firebase');
        this.applyFirebaseReport(cached);
        return;
      }
      try {
        await this.loadFromClient(selected);
        return;
      } catch {
        // try latest client below
      }
    }

    const clients = await this.clientSvc.listClients();
    if (clients.length) {
      const clientCode = clients[0].clientCode;
      if (!forceRefresh) {
        const cached = this.restoreFirebaseReportFromCache(uid, clientCode);
        if (cached) {
          this.clientSvc.selectClient(clientCode);
          this.activeClientCode.set(clientCode);
          this.dataSource.set('firebase');
          this.applyFirebaseReport(cached);
          return;
        }
      }
      await this.loadFromClient(clientCode);
    }
  }

  async loadFile(file: File): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const report = await this.parser.parseFile(file);
      this.addToHistory(file.name, report);
      this.dataSource.set('local');
      this.activeClientCode.set(null);
      this.applyReport(report);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Failed to parse file');
      this.report.set(null);
      this.activeHistoryId.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  selectHistoryReport(id: string): void {
    const entry = this.reportHistory().find((item) => item.id === id);
    if (!entry) return;
    this.activeHistoryId.set(id);
    this.dataSource.set('local');
    this.activeClientCode.set(null);
    this.applyReport(entry.report);
    this.error.set(null);
  }

  private addToHistory(fileName: string, report: Report): void {
    const id = this.createHistoryId();
    const entry: ReportHistoryEntry = {
      id,
      fileName,
      uploadedAt: Date.now(),
      report,
    };
    this.reportHistory.update((list) => {
      const next = [entry, ...list.filter((item) => item.id !== id)].slice(0, MAX_REPORT_HISTORY);
      this.saveHistoryToStorage(next);
      return next;
    });
    this.activeHistoryId.set(id);
  }

  private loadHistoryFromStorage(): ReportHistoryEntry[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as ReportHistoryEntry[];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry) => entry?.id && entry?.fileName && entry?.report)
        .slice(0, MAX_REPORT_HISTORY);
    } catch {
      return [];
    }
  }

  private saveHistoryToStorage(history: ReportHistoryEntry[]): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch {
      // Storage full or unavailable — keep in-memory history for this session.
    }
  }

  private createHistoryId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private applyReport(report: Report): void {
    const prev = this.report();
    this.report.set(report);
    const clientChanged = !prev || prev.summary.clientCode !== report.summary.clientCode;
    const rangeMissing = !this.startDate() || !this.endDate();
    // Only seed dates when empty or client switches — never overwrite an active user filter.
    if (clientChanged || rangeMissing) {
      if (report.dateRange.min && report.dateRange.max) {
        this.startDate.set(report.dateRange.min);
        this.endDate.set(report.dateRange.max);
        if (clientChanged || !this.datePeriod()) {
          this.datePeriod.set('inception');
        }
      }
    }
  }

  applyFirebaseReport(report: Report): void {
    this.activeHistoryId.set(null);
    this.applyReport(report);
    this.error.set(null);
    void this.saveReportCache(report);
  }

  private async saveReportCache(report: Report): Promise<void> {
    const uid = await this.auth.getDataUserId();
    const clientCode = report.summary.clientCode;
    if (uid && clientCode) {
      this.saveFirebaseReportToCache(uid, clientCode, report);
    }
  }

  applyUploadResult(result: { clientCode: string; report?: Report | null }): void {
    if (result.report) {
      this.clientSvc.selectClient(result.clientCode);
      this.activeClientCode.set(result.clientCode);
      this.dataSource.set('firebase');
      this.applyFirebaseReport(result.report);
      return;
    }
    void this.loadFromClient(result.clientCode);
  }

  applyFilters(
    start: string,
    end: string,
    types: TradeType[],
    chartPeriod?: 'daily' | 'weekly' | 'monthly',
    topStocks?: number,
    options: { syncUrl?: boolean; datePeriod?: DateRangePresetId | 'custom' } = {}
  ): void {
    const nextPeriod = options.datePeriod ?? this.datePeriod();
    const sameDates = this.startDate() === start && this.endDate() === end;
    const sameTypes =
      this.selectedTradeTypes().length === types.length &&
      this.selectedTradeTypes().every((t, i) => t === types[i]);
    const nextChart = chartPeriod ?? this.chartPeriod();
    const nextTop = topStocks ?? this.topStocksCount();
    const sameChart = this.chartPeriod() === nextChart;
    const sameTop = this.topStocksCount() === nextTop;
    const samePeriod = this.datePeriod() === nextPeriod;
    if (sameDates && sameTypes && sameChart && sameTop && samePeriod) {
      void options;
      return;
    }
    this.startDate.set(start);
    this.endDate.set(end);
    this.datePeriod.set(nextPeriod);
    this.selectedTradeTypes.set(types);
    if (chartPeriod) this.chartPeriod.set(chartPeriod);
    if (topStocks) this.topStocksCount.set(topStocks);
    void options;
  }

  resetFilters(defaultTypes: TradeType[] = DEFAULT_TRADE_TYPES): void {
    const report = this.report();
    if (report) {
      this.startDate.set(report.dateRange.min);
      this.endDate.set(report.dateRange.max);
    }
    this.datePeriod.set('inception');
    this.selectedTradeTypes.set(defaultTypes);
    this.chartPeriod.set('daily');
    this.topStocksCount.set(10);
  }

  clear(): void {
    this.report.set(null);
    this.activeHistoryId.set(null);
    this.activeClientCode.set(null);
    this.dataSource.set('local');
    this.error.set(null);
    this.startDate.set('');
    this.endDate.set('');
    this.datePeriod.set('inception');
    this.reportHistory.set([]);
    this.saveHistoryToStorage([]);
    this.clearFirebaseReportCache();
  }

  private isValidReport(report: Report): boolean {
    if (!report?.summary?.clientCode) return false;
    if (report.stockSummary?.length) return true;
    if (report.unrealisedHoldings?.length) return true;
    if (!Array.isArray(report.trades) || !report.trades.length) return false;
    return report.trades.every((trade) => Number.isFinite(trade.realisedPnL));
  }

  private restoreFirebaseReportFromCache(uid: string, clientCode: string): Report | null {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(firebaseReportCacheKey(uid, clientCode));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedFirebaseReport | Report;
      const savedAt = 'savedAt' in parsed && typeof parsed.savedAt === 'number' ? parsed.savedAt : 0;
      const report = 'report' in parsed ? parsed.report : parsed;
      if (!savedAt || Date.now() - savedAt > UI_CACHE_TTL_MS) {
        sessionStorage.removeItem(firebaseReportCacheKey(uid, clientCode));
        return null;
      }
      if (!this.isValidReport(report)) {
        sessionStorage.removeItem(firebaseReportCacheKey(uid, clientCode));
        return null;
      }
      return report;
    } catch {
      return null;
    }
  }

  private saveFirebaseReportToCache(uid: string, clientCode: string, report: Report): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
      const payload: CachedFirebaseReport = {
        savedAt: Date.now(),
        report: {
          ...report,
          trades: report.trades.length > 500 ? [] : report.trades,
          tradesLoaded: report.trades.length <= 500,
        },
      };
      sessionStorage.setItem(firebaseReportCacheKey(uid, clientCode), JSON.stringify(payload));
    } catch {
      // Quota exceeded or report too large — skip cache for this session.
    }
  }

  private clearFirebaseReportCache(): void {
    if (typeof sessionStorage === 'undefined') return;
    void this.auth.getDataUserId().then((uid) => {
      if (!uid) return;
      const prefix = `${FIREBASE_REPORT_CACHE_PREFIX}:${uid}:`;
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(prefix)) {
          sessionStorage.removeItem(key);
        }
      }
    });
  }
}

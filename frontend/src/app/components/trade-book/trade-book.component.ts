import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { ExecutionLeg, RegistryStock, TradeSegment } from '../../models/trading-journal.models';
import { PriceTracker, PriceTrackerService } from '../../services/price-tracker.service';
import { RegistryStockService } from '../../services/registry-stock.service';
import { ScreenerService, ScreenerSnapshot } from '../../services/screener.service';
import { ToastService } from '../../services/toast.service';
import { StockSearchInputComponent } from '../shared/stock-search-input/stock-search-input.component';
import { formatPrice } from '../../utils/format.utils';
import { trackerIsSell } from '../../utils/price-tracker.utils';

const DEFAULT_QTY = 1000;
const TARGET_PCT = 0.01;

type Side = 'Long' | 'Short';

interface DraftLine {
  key: number;
  action: Side;
  prices: string;
  quantity: string;
  target: string;
  segment: TradeSegment;
}

interface DraftCard {
  key: number;
  query: string;
  stock: RegistryStock | null;
  lines: DraftLine[];
}

interface ParsedLine {
  action: Side;
  trigger: number;
  nextTargets: number[];
  quantity: number;
  target: number;
  segment: TradeSegment;
}

@Component({
  selector: 'app-trade-book',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, StockSearchInputComponent],
  templateUrl: './trade-book.component.html',
})
export class TradeBookComponent {
  private trackerSvc = inject(PriceTrackerService);
  private registrySvc = inject(RegistryStockService);
  private screener = inject(ScreenerService);
  private toast = inject(ToastService);

  readonly formatPrice = formatPrice;
  readonly defaultQty = DEFAULT_QTY;
  readonly targetPctLabel = '1%';

  private nextKey = 1;
  cards = signal<DraftCard[]>([this.emptyCard()]);
  plans = toSignal(this.trackerSvc.watchAll(), { initialValue: [] as PriceTracker[] });
  selectedIds = signal<Set<string>>(new Set());
  bulkOpen = signal(false);
  busy = signal(false);
  screenerBusy = signal(false);
  screenerDone = signal(0);
  screenerTotal = signal(0);
  searchQuery = signal('');

  filteredPlans = computed(() => {
    const q = this.searchQuery().trim().toUpperCase();
    const rows = this.plans();
    if (!q) return rows;
    return rows.filter(
      (row) =>
        row.symbol.toUpperCase().includes(q) ||
        (row.stockName || '').toUpperCase().includes(q) ||
        row.action.toUpperCase().includes(q)
    );
  });

  selectedCount = computed(() => this.selectedIds().size);
  allVisibleSelected = computed(() => {
    const rows = this.filteredPlans();
    if (!rows.length) return false;
    const selected = this.selectedIds();
    return rows.every((row) => selected.has(row.id));
  });

  previewCount = computed(() =>
    this.cards().reduce((sum, card) => sum + this.parsedLines(card).length, 0)
  );

  onQuery(card: DraftCard, value: string): void {
    this.patchCard(card.key, { query: value.toUpperCase() });
  }

  onPicked(card: DraftCard, stock: RegistryStock): void {
    this.patchCard(card.key, { stock, query: stock.symbol });
  }

  addCard(): void {
    this.cards.update((rows) => [...rows, this.emptyCard()]);
  }

  removeCard(key: number): void {
    this.cards.update((rows) => {
      const next = rows.filter((card) => card.key !== key);
      return next.length ? next : [this.emptyCard()];
    });
  }

  addLine(card: DraftCard, action: Side = 'Long'): void {
    this.patchCard(card.key, {
      lines: [...card.lines, this.emptyLine(action)],
    });
  }

  removeLine(card: DraftCard, key: number): void {
    const lines = card.lines.filter((line) => line.key !== key);
    this.patchCard(card.key, { lines: lines.length ? lines : [this.emptyLine('Long')] });
  }

  setLine(card: DraftCard, key: number, patch: Partial<DraftLine>): void {
    this.patchCard(card.key, {
      lines: card.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    });
  }

  parsedLines(card: DraftCard): ParsedLine[] {
    return card.lines
      .map((line) => this.parseLine(line))
      .filter((line): line is ParsedLine => line != null);
  }

  defaultTarget(trigger: number, action: Side): number {
    if (!(trigger > 0)) return 0;
    const raw = action === 'Short' ? trigger * (1 - TARGET_PCT) : trigger * (1 + TARGET_PCT);
    return Math.round(raw * 100) / 100;
  }

  previewTarget(line: DraftLine): number {
    const parsed = this.parseLine(line);
    return parsed?.target ?? 0;
  }

  async createPlans(): Promise<void> {
    await this.commitDrafts('open');
  }

  async addDraftsToHistory(): Promise<void> {
    await this.commitDrafts('history');
  }

  async addPlanToHistory(row: PriceTracker): Promise<void> {
    if (this.busy()) return;
    const qty = row.quantity && row.quantity > 0 ? row.quantity : DEFAULT_QTY;
    const trigger = row.entryPrice && row.entryPrice > 0 ? row.entryPrice : row.targetPrice;
    const exit =
      row.targets?.[0]?.price && row.targets[0].price > 0
        ? row.targets[0].price
        : this.defaultTarget(trigger, trackerIsSell(row.action) ? 'Short' : 'Long');
    const { buyLegs, sellLegs } = this.legsFor(row.action, qty, trigger, exit);
    this.busy.set(true);
    try {
      await this.trackerSvc.execute(row.id, buyLegs, sellLegs);
      this.selectedIds.update((ids) => {
        const next = new Set(ids);
        next.delete(row.id);
        return next;
      });
      this.toast.success(`Moved ${row.symbol} to trade history`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to add to history');
    } finally {
      this.busy.set(false);
    }
  }

  toggleBulk(): void {
    this.bulkOpen.update((open) => !open);
    if (!this.bulkOpen()) this.selectedIds.set(new Set());
  }

  toggleSelect(id: string): void {
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  toggleSelectAllVisible(): void {
    const rows = this.filteredPlans();
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      const all = rows.every((row) => next.has(row.id));
      if (all) {
        for (const row of rows) next.delete(row.id);
      } else {
        for (const row of rows) next.add(row.id);
      }
      return next;
    });
  }

  async deleteSelected(): Promise<void> {
    const ids = [...this.selectedIds()];
    if (!ids.length || this.busy()) return;
    if (!confirm(`Remove ${ids.length} ${ids.length === 1 ? 'plan' : 'plans'}? This cannot be undone.`)) return;
    this.busy.set(true);
    try {
      const removed = await this.trackerSvc.removeMany(ids);
      this.selectedIds.set(new Set());
      this.toast.success(`Removed ${removed} ${removed === 1 ? 'plan' : 'plans'}`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to delete selected plans');
    } finally {
      this.busy.set(false);
    }
  }

  async deleteAllVisible(): Promise<void> {
    const ids = this.filteredPlans().map((row) => row.id);
    if (!ids.length || this.busy()) return;
    if (!confirm(`Remove all ${ids.length} visible plans? This cannot be undone.`)) return;
    this.busy.set(true);
    try {
      const removed = await this.trackerSvc.removeMany(ids);
      this.selectedIds.set(new Set());
      this.bulkOpen.set(false);
      this.toast.success(`Removed ${removed} ${removed === 1 ? 'plan' : 'plans'}`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to delete plans');
    } finally {
      this.busy.set(false);
    }
  }

  async refreshCardScreener(card: DraftCard): Promise<void> {
    const stock = await this.resolveStock(card);
    if (!stock) {
      this.toast.error('Pick a stock first');
      return;
    }
    await this.refreshSymbols([stock.symbol]);
  }

  async refreshSelectedScreener(): Promise<void> {
    const selected = this.selectedIds();
    const rows = selected.size
      ? this.filteredPlans().filter((row) => selected.has(row.id))
      : this.filteredPlans();
    const symbols = [...new Set(rows.map((row) => row.symbol.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length) {
      this.toast.error('No stocks to refresh');
      return;
    }
    await this.refreshSymbols(symbols);
  }

  nextLevelsLabel(prices: number[]): string {
    return prices.map((price) => formatPrice(price)).join(' · ') || '—';
  }

  exitLabel(row: PriceTracker): string {
    const price = row.targets?.[0]?.price;
    return price && price > 0 ? formatPrice(price) : '—';
  }

  private async commitDrafts(mode: 'open' | 'history'): Promise<void> {
    if (this.busy()) return;
    const drafts = this.cards()
      .map((card) => ({ card, lines: this.parsedLines(card) }))
      .filter((item) => item.lines.length);
    if (!drafts.length) {
      this.toast.error('Add a stock and at least one long or short price');
      return;
    }

    this.busy.set(true);
    let saved = 0;
    try {
      for (const { card, lines } of drafts) {
        const stock = await this.resolveStock(card);
        if (!stock) {
          this.toast.error('Pick a stock from the registry for each note');
          return;
        }
        for (const line of lines) {
          const payload = {
            symbol: stock.symbol,
            stockName: stock.name,
            isin: stock.isin,
            action: line.action,
            targetPrice: line.trigger,
            nextTargets: line.nextTargets,
            targets: [{ price: line.target, quantity: line.quantity }],
            quantity: line.quantity,
            segment: line.segment,
            entryPrice: line.trigger,
          };
          if (mode === 'history') {
            const { buyLegs, sellLegs } = this.legsFor(line.action, line.quantity, line.trigger, line.target);
            await this.trackerSvc.saveExecuted({ ...payload, buyLegs, sellLegs });
          } else {
            await this.trackerSvc.save(payload);
          }
          saved += 1;
        }
      }
      this.cards.set([this.emptyCard()]);
      this.toast.success(
        mode === 'history'
          ? `Added ${saved} ${saved === 1 ? 'trade' : 'trades'} to history`
          : `Created ${saved} ${saved === 1 ? 'trade plan' : 'trade plans'}`
      );
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Failed to save trade book');
    } finally {
      this.busy.set(false);
    }
  }

  private async resolveStock(card: DraftCard): Promise<RegistryStock | null> {
    if (card.stock) return card.stock;
    const symbol = card.query.trim().toUpperCase();
    if (!symbol) return null;
    const listed = await this.registrySvc.ensureListed(symbol, { name: symbol });
    this.patchCard(card.key, { stock: listed, query: listed.symbol });
    return listed;
  }

  private async refreshSymbols(symbols: string[]): Promise<void> {
    if (this.screenerBusy()) return;
    this.screenerBusy.set(true);
    this.screenerDone.set(0);
    this.screenerTotal.set(symbols.length);
    const failed: string[] = [];
    let updated = 0;
    try {
      for (const [index, symbol] of symbols.entries()) {
        this.screenerDone.set(index);
        try {
          const existing = await this.registrySvc.getBySymbol(symbol);
          const data = await this.screener.fetchStock(symbol, {
            isin: existing?.isin,
            name: existing?.name,
            pageUrl: existing?.screenerUrl,
          });
          await this.registrySvc.save(this.applyScreener(existing, data, symbol));
          this.patchCardsForSymbol(symbol, data);
          updated += 1;
        } catch {
          failed.push(symbol);
        }
      }
      this.registrySvc.reload();
      const failNote = failed.length
        ? ` ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}.`
        : '';
      const message = `Refreshed Screener data for ${updated} stock${updated === 1 ? '' : 's'}.${failNote}`;
      if (failed.length) this.toast.error(message);
      else this.toast.success(message);
    } finally {
      this.screenerBusy.set(false);
      this.screenerDone.set(0);
      this.screenerTotal.set(0);
    }
  }

  private patchCardsForSymbol(symbol: string, data: ScreenerSnapshot): void {
    this.cards.update((cards) =>
      cards.map((card) => {
        if (card.stock?.symbol !== symbol && card.query.trim().toUpperCase() !== symbol) return card;
        const stock: RegistryStock = this.applyScreener(card.stock, data, symbol);
        return { ...card, stock, query: stock.symbol };
      })
    );
  }

  private applyScreener(
    stock: RegistryStock | null,
    data: ScreenerSnapshot,
    fallbackSymbol: string
  ): RegistryStock {
    const base: RegistryStock = stock ?? {
      symbol: data.symbol || fallbackSymbol,
      name: data.name || fallbackSymbol,
      currentPrice: 0,
      supports: [],
      resistances: [],
      updatedAt: Date.now(),
    };
    return {
      ...base,
      symbol: data.symbol || base.symbol,
      name: data.name || base.name,
      currentPrice: data.currentPrice ?? base.currentPrice,
      marketCap: data.marketCap ?? base.marketCap,
      pe: data.pe ?? base.pe,
      bookValue: data.bookValue,
      dividendYield: data.dividendYield,
      roce: data.roce,
      roe: data.roe,
      faceValue: data.faceValue,
      highLow: data.highLow,
      salesGrowth3y: data.salesGrowth3y,
      salesGrowth5y: data.salesGrowth5y,
      salesGrowth10y: data.salesGrowth10y,
      salesGrowthTtm: data.salesGrowthTtm,
      profitGrowth3y: data.profitGrowth3y,
      profitGrowth5y: data.profitGrowth5y,
      profitGrowth10y: data.profitGrowth10y,
      profitGrowthTtm: data.profitGrowthTtm,
      stockCagr1y: data.stockCagr1y,
      stockCagr3y: data.stockCagr3y,
      stockCagr5y: data.stockCagr5y,
      stockCagr10y: data.stockCagr10y,
      promoterHolding: data.promoterHolding,
      fiiHolding: data.fiiHolding,
      diiHolding: data.diiHolding,
      publicHolding: data.publicHolding,
      governmentHolding: data.governmentHolding,
      otherHolding: data.otherHolding,
      quarterlyResults: data.quarterlyResults,
      profitLoss: data.profitLoss,
      balanceSheet: data.balanceSheet,
      cashFlow: data.cashFlow,
      shareholding: data.shareholding,
      screenerUrl: data.url,
      screenerFetchedAt: data.fetchedAt,
      updatedAt: Date.now(),
    };
  }

  private parseLine(line: DraftLine): ParsedLine | null {
    const prices = this.parsePriceList(line.prices);
    if (!prices.length) return null;
    const trigger = prices[0];
    const quantity = parseFloat(line.quantity);
    const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : DEFAULT_QTY;
    const typedTarget = parseFloat(line.target);
    const target =
      Number.isFinite(typedTarget) && typedTarget > 0
        ? Math.round(typedTarget * 100) / 100
        : this.defaultTarget(trigger, line.action);
    return {
      action: line.action,
      trigger,
      nextTargets: prices.slice(1),
      quantity: qty,
      target,
      segment: line.segment === 'intraday' ? 'intraday' : 'delivery',
    };
  }

  private parsePriceList(raw: string): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const part of raw.split(/[,;@\s]+/)) {
      const n = parseFloat(part.replace(/,/g, ''));
      if (!Number.isFinite(n) || n <= 0) continue;
      const rounded = Math.round(n * 100) / 100;
      if (seen.has(rounded)) continue;
      seen.add(rounded);
      out.push(rounded);
    }
    return out;
  }

  private legsFor(
    action: string,
    quantity: number,
    trigger: number,
    exit: number
  ): { buyLegs: ExecutionLeg[]; sellLegs: ExecutionLeg[] } {
    const qty = quantity > 0 ? quantity : DEFAULT_QTY;
    if (trackerIsSell(action)) {
      return {
        buyLegs: [{ quantity: qty, price: exit }],
        sellLegs: [{ quantity: qty, price: trigger }],
      };
    }
    return {
      buyLegs: [{ quantity: qty, price: trigger }],
      sellLegs: [{ quantity: qty, price: exit }],
    };
  }

  private patchCard(key: number, patch: Partial<DraftCard>): void {
    this.cards.update((rows) => rows.map((card) => (card.key === key ? { ...card, ...patch } : card)));
  }

  private emptyCard(): DraftCard {
    return {
      key: this.nextKey++,
      query: '',
      stock: null,
      lines: [this.emptyLine('Short'), this.emptyLine('Long')],
    };
  }

  private emptyLine(action: Side): DraftLine {
    return {
      key: this.nextKey++,
      action,
      prices: '',
      quantity: String(DEFAULT_QTY),
      target: '',
      segment: 'delivery',
    };
  }
}

import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ReportStateService } from '../../services/report-state.service';
import { AuthService } from '../../services/auth.service';
import { TradeLedgerService } from '../../services/trade-ledger.service';
import { WorkerJobService } from '../../services/worker-job.service';
import { UploadComponent } from '../upload/upload.component';
import { ContractNoteUploadComponent } from '../contract-note-upload/contract-note-upload.component';
import { formatCurrency } from '../../utils/format.utils';

type SettingsTab = 'upload' | 'contract-notes' | 'backfill' | 'worker' | 'reset';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, UploadComponent, ContractNoteUploadComponent],
  templateUrl: './settings.component.html',
})
export class SettingsComponent {
  private ledger = inject(TradeLedgerService);
  private router = inject(Router);
  private workerJobs = inject(WorkerJobService);
  readonly state = inject(ReportStateService);
  readonly auth = inject(AuthService);

  activeTab = signal<SettingsTab>('upload');

  resetConfirmChecked = signal(false);
  resetTradeData = signal(false);
  resetWatchlists = signal(false);
  resetStockRegistry = signal(false);
  resetTradePlans = signal(false);
  resetStockLevels = signal(false);
  resetLocalCache = signal(true);
  resetBusy = signal(false);
  resetError = signal<string | null>(null);
  resetSuccess = signal<string | null>(null);
  reingestFile = signal<File | null>(null);

  backfillBusy = signal(false);
  backfillError = signal<string | null>(null);
  backfillSuccess = signal<string | null>(null);
  rebuildProfiles = signal(false);
  triggerIngest = signal(true);

  workerBusy = signal(false);
  workerError = signal<string | null>(null);
  workerSuccess = signal<string | null>(null);
  workerOnline = signal(false);
  listenUntil = signal<number | null>(null);

  hasResetSelection = computed(
    () =>
      this.resetTradeData() ||
      this.resetWatchlists() ||
      this.resetStockRegistry() ||
      this.resetTradePlans() ||
      this.resetStockLevels() ||
      this.resetLocalCache()
  );

  canConfirmReset = computed(
    () => this.resetConfirmChecked() && this.hasResetSelection() && !this.resetBusy()
  );
  canRunBackfill = computed(() => !this.backfillBusy());
  listenActive = computed(() => {
    const until = this.listenUntil();
    return !!until && until > Date.now();
  });

  setTab(tab: SettingsTab): void {
    this.activeTab.set(tab);
    if (tab === 'worker') {
      void this.refreshWorkerStatus();
    }
  }

  onReingestFileSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.reingestFile.set(file);
  }

  async refreshWorkerStatus(): Promise<void> {
    const listen = await this.workerJobs.getListenState();
    this.listenUntil.set(this.workerJobs.isListenActive(listen) ? listen?.until ?? null : null);
    this.workerOnline.set(await this.workerJobs.getWorkerOnline());
  }

  async connectWorker(): Promise<void> {
    this.workerBusy.set(true);
    this.workerError.set(null);
    this.workerSuccess.set(null);
    try {
      await this.workerJobs.requestListenWindow();
      await this.refreshWorkerStatus();
      this.workerSuccess.set(
        (await this.workerJobs.getWorkerOnline())
          ? 'Local worker detected on localhost:8080. Ingest runs directly (no Firestore needed).'
          : 'Listen window opened for 15 minutes. Start the backend worker locally if it is not already running.'
      );
    } catch (e) {
      this.workerError.set(e instanceof Error ? e.message : 'Failed to connect worker');
    } finally {
      this.workerBusy.set(false);
    }
  }

  async runHotIngest(): Promise<void> {
    this.workerBusy.set(true);
    this.workerError.set(null);
    this.workerSuccess.set(null);
    try {
      const jobId = await this.workerJobs.requestHotIngest();
      const job = await this.workerJobs.waitForJob(jobId);
      if (job.status === 'completed') {
        this.workerSuccess.set(`Hot ingest completed for ${job.symbolsIngested ?? 0} symbol(s).`);
      } else {
        this.workerError.set(job.error ?? 'Hot ingest failed');
      }
      await this.refreshWorkerStatus();
    } catch (e) {
      this.workerError.set(e instanceof Error ? e.message : 'Hot ingest failed');
    } finally {
      this.workerBusy.set(false);
    }
  }

  async importUniverse(): Promise<void> {
    this.workerBusy.set(true);
    this.workerError.set(null);
    this.workerSuccess.set(null);
    try {
      const jobId = await this.workerJobs.requestSeedRegistry();
      const job = await this.workerJobs.waitForJob(jobId, 20 * 60 * 1000);
      if (job.status === 'completed') {
        this.workerSuccess.set(`Imported ${job.symbolsIngested ?? 0} NSE/BSE symbols into stock registry.`);
      } else {
        this.workerError.set(job.error ?? 'Universe import failed');
      }
      await this.refreshWorkerStatus();
    } catch (e) {
      this.workerError.set(e instanceof Error ? e.message : 'Universe import failed');
    } finally {
      this.workerBusy.set(false);
    }
  }

  async runBackfill(): Promise<void> {
    if (!this.canRunBackfill()) return;

    this.backfillBusy.set(true);
    this.backfillError.set(null);
    this.backfillSuccess.set(null);

    try {
      const result = await this.ledger.backfillUniverse({
        rebuildProfiles: this.rebuildProfiles(),
      });

      let message = `Synced ${result.symbolsSynced} symbol(s) from ${result.clientsProcessed} client account(s) to your stock registry.`;
      if (result.profilesRebuilt) {
        message += ` Rebuilt stock profiles for ${result.profilesRebuilt} client(s).`;
      }

      if (this.triggerIngest()) {
        await this.workerJobs.requestListenWindow();
        const online = await this.workerJobs.getWorkerOnline();
        if (!online) {
          message +=
            ' Worker is offline — open the Worker tab, click Connect, and ensure `cd backend && go run .` is running.';
        } else {
          const jobId = await this.workerJobs.requestHotIngest();
          message += ' Ingest requested via Firebase…';
          const job = await this.workerJobs.waitForJob(jobId);
          if (job.status === 'completed') {
            message += ` Worker ingested ${job.symbolsIngested ?? 0} symbol(s).`;
          } else {
            message += ` Ingest failed: ${job.error ?? 'unknown error'}.`;
          }
        }
      }

      this.backfillSuccess.set(message);
    } catch (e) {
      this.backfillError.set(e instanceof Error ? e.message : 'Backfill failed');
    } finally {
      this.backfillBusy.set(false);
    }
  }

  async confirmResetData(): Promise<void> {
    if (!this.canConfirmReset()) return;

    this.resetBusy.set(true);
    this.resetError.set(null);
    this.resetSuccess.set(null);

    const options = {
      tradeData: this.resetTradeData(),
      watchlists: this.resetWatchlists(),
      stockRegistry: this.resetStockRegistry(),
      tradePlans: this.resetTradePlans(),
      stockLevels: this.resetStockLevels(),
    };

    try {
      const hasCloudReset = Object.values(options).some(Boolean);
      const result = hasCloudReset ? await this.ledger.resetData(options) : null;

      if (this.resetLocalCache() || options.tradeData) {
        this.state.clear();
      }

      const file = this.reingestFile();
      if (file && options.tradeData) {
        const upload = await this.ledger.uploadReport(file, { forceReingest: true });
        this.state.applyUploadResult(upload);
        const drift = upload.reconciliation;
        this.resetSuccess.set(
          `Reset complete. Re-ingested ${upload.newTradesAdded} trades for ${upload.clientName}.` +
            (drift && !drift.matches
              ? ` Warning: stored P&L is off the statement by ${formatCurrency(Math.abs(drift.difference))}.`
              : '')
        );
        this.resetConfirmChecked.set(false);
        this.reingestFile.set(null);
        await this.router.navigate(['/dashboard']);
      } else {
        const parts = [
          result?.clientsRemoved ? `${result.clientsRemoved} client account(s)` : null,
          result?.watchlistsRemoved ? `${result.watchlistsRemoved} watchlist(s)` : null,
          result?.registryStocksRemoved ? `${result.registryStocksRemoved} registry stock(s)` : null,
          result?.plannedTradesRemoved ? `${result.plannedTradesRemoved} planned trade(s)` : null,
          result?.momentumStocksRemoved ? `${result.momentumStocksRemoved} momentum stock(s)` : null,
          result?.levelsRemoved ? `${result.levelsRemoved} stock level(s)` : null,
          this.resetLocalCache() ? 'local P&L cache' : null,
        ].filter(Boolean);
        this.resetSuccess.set(
          parts.length ? `Cleared: ${parts.join(', ')}.` : 'Nothing was selected to reset.'
        );
        this.resetConfirmChecked.set(false);
        this.reingestFile.set(null);
      }
    } catch (e) {
      this.resetError.set(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      this.resetBusy.set(false);
    }
  }
}

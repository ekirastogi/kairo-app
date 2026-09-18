import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ReportStateService } from '../../services/report-state.service';
import { TradeLedgerService, UploadReconciliation } from '../../services/trade-ledger.service';
import { AuthService } from '../../services/auth.service';
import { ReportHistoryComponent } from '../shared/report-history/report-history.component';
import { formatCurrency } from '../../utils/format.utils';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [CommonModule, ReportHistoryComponent],
  templateUrl: './upload.component.html',
})
export class UploadComponent {
  readonly state = inject(ReportStateService);
  private ledger = inject(TradeLedgerService);
  private router = inject(Router);
  readonly auth = inject(AuthService);

saveToSupabase = signal(true);
  dragOver = signal(false);
  uploading = signal(false);
  pushResult = signal<string | null>(null);
  pushError = signal<string | null>(null);
  pushWarning = signal<string | null>(null);

  onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(true);
  }

  onDragLeave(): void {
    this.dragOver.set(false);
  }

  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void this.handleFile(file);
  }

  onFileSelected(e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void this.handleFile(file);
  }

  private async handleFile(file: File): Promise<void> {
    this.pushResult.set(null);
    this.pushError.set(null);
    this.pushWarning.set(null);
    this.uploading.set(true);

    try {
      await this.auth.whenReady();

      if (this.saveToSupabase()) {
        if (!this.auth.currentUser) {
          this.pushError.set('Sign in to store uploads in Supabase and load dashboards from the cloud.');
          return;
        }

        const result = await this.ledger.uploadReport(file);
        this.state.applyUploadResult(result);
        this.pushWarning.set(reconciliationWarning(result.reconciliation));

        const replaced =
          result.tradesReplaced > 0
            ? ` ${result.tradesReplaced} earlier rows on those dates were replaced.`
            : '';
        this.pushResult.set(
          (result.fileDuplicate
            ? `File re-imported for ${result.clientName} (${result.clientCode}): `
            : `Saved to Supabase for ${result.clientName} (${result.clientCode}): `) +
            `${result.newTradesAdded} trades imported.${replaced}`
        );

        await this.router.navigate(['/analytics']);
        return;
      }

      await this.state.loadFile(file);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Upload failed';
      this.pushError.set(message);
      this.state.error.set(message);
    } finally {
      this.uploading.set(false);
    }
  }

  goToDashboard(): void {
    void this.router.navigate(['/analytics']);
  }
}

/**
 * The stored ledger merges every statement ever uploaded, so a drift against the file's own
 * header is the only signal that rows were lost or double-counted. Left unflagged it surfaces
 * much later as a dashboard that disagrees with Groww by an unexplained amount.
 */
function reconciliationWarning(check: UploadReconciliation | undefined): string | null {
  if (!check || check.matches) return null;
  const direction = check.difference > 0 ? 'more' : 'less';
  return (
    `Stored P&L does not match this statement. The file reports ${formatCurrency(check.statement)} realised, ` +
    `the ledger now holds ${formatCurrency(check.stored)} for the same period — ` +
    `${formatCurrency(Math.abs(check.difference))} ${direction}. ` +
    `Use Settings → Reset data to re-import this file from scratch.`
  );
}

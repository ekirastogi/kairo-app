import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ReportStateService } from '../../services/report-state.service';
import { TradeLedgerService } from '../../services/trade-ledger.service';
import { UserConfigService } from '../../services/user-config.service';

@Component({
  selector: 'app-contract-note-upload',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './contract-note-upload.component.html',
})
export class ContractNoteUploadComponent implements OnInit {
  private ledger = inject(TradeLedgerService);
  private userConfig = inject(UserConfigService);
  private router = inject(Router);
  readonly state = inject(ReportStateService);
  readonly auth = inject(AuthService);

  passwordDraft = signal('');
  passwordBusy = signal(false);
  passwordMessage = signal<string | null>(null);
  passwordError = signal<string | null>(null);
  hasSavedPassword = this.userConfig.hasContractNotePassword;

  dragOver = signal(false);
  uploading = signal(false);
  pushResult = signal<string | null>(null);
  pushError = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      await this.userConfig.refresh();
    } catch {
      /* ignore — upload will surface auth errors */
    }
  }

  async savePassword(): Promise<void> {
    this.passwordBusy.set(true);
    this.passwordError.set(null);
    this.passwordMessage.set(null);
    try {
      await this.userConfig.saveContractNotePassword(this.passwordDraft());
      this.passwordDraft.set('');
      this.passwordMessage.set('Contract note password saved (encrypted in Firebase).');
    } catch (e) {
      this.passwordError.set(e instanceof Error ? e.message : 'Could not save password');
    } finally {
      this.passwordBusy.set(false);
    }
  }

  async clearPassword(): Promise<void> {
    this.passwordBusy.set(true);
    this.passwordError.set(null);
    this.passwordMessage.set(null);
    try {
      await this.userConfig.clearContractNotePassword();
      this.passwordMessage.set('Saved contract note password cleared.');
    } catch (e) {
      this.passwordError.set(e instanceof Error ? e.message : 'Could not clear password');
    } finally {
      this.passwordBusy.set(false);
    }
  }

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
    this.uploading.set(true);

    try {
      await this.auth.whenReady();
      if (!this.auth.currentUser) {
        this.pushError.set('Sign in to upload contract notes.');
        return;
      }
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        this.pushError.set('Choose a Groww contract note PDF.');
        return;
      }

      const result = await this.ledger.uploadContractNote(file);
      this.state.applyUploadResult(result);

      const replaced =
        result.tradesReplaced > 0
          ? ` Replaced ${result.tradesReplaced} row(s) already stored for that day.`
          : '';
      this.pushResult.set(
        `Contract note imported for ${result.clientName} (${result.clientCode}): ` +
          `${result.newTradesAdded} trade(s).${replaced} Provisional until Sunday Excel resync.`
      );
      await this.router.navigate(['/analytics']);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Contract note upload failed';
      this.pushError.set(message);
    } finally {
      this.uploading.set(false);
    }
  }
}

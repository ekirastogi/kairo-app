import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  CORPORATE_ACTION_TYPE_LABELS,
  CorporateAction,
  CorporateActionInput,
  CorporateActionType,
} from '../../models/corporate-action.models';
import { CorporateActionService } from '../../services/corporate-action.service';
import { formatSwapRatio } from '../../utils/corporate-action.utils';
import { formatDate } from '../../utils/format.utils';

@Component({
  selector: 'app-corporate-actions',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './corporate-actions.component.html',
})
export class CorporateActionsComponent implements OnInit {
  private svc = inject(CorporateActionService);
  private route = inject(ActivatedRoute);

  actions = signal<CorporateAction[]>([]);
  loading = signal(true);
  busy = signal(false);
  error = signal<string | null>(null);
  success = signal<string | null>(null);
  showForm = signal(false);
  editingId = signal<string | null>(null);
  highlightId = signal<string | null>(null);

  readonly typeLabels = CORPORATE_ACTION_TYPE_LABELS;
  readonly types: CorporateActionType[] = ['merge', 'split', 'rename'];
  readonly formatDate = formatDate;
  readonly formatSwapRatio = formatSwapRatio;

  form: CorporateActionInput = this.emptyForm();

  async ngOnInit(): Promise<void> {
    this.highlightId.set(this.route.snapshot.queryParamMap.get('id'));
    await this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const list = await this.svc.ensureSeeded();
      this.actions.set(list);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load corporate actions');
    } finally {
      this.loading.set(false);
    }
  }

  startCreate(): void {
    this.editingId.set(null);
    this.form = this.emptyForm();
    this.showForm.set(true);
    this.success.set(null);
    this.error.set(null);
  }

  startEdit(action: CorporateAction): void {
    this.editingId.set(action.id);
    this.form = {
      actionType: action.actionType,
      fromSymbol: action.fromSymbol,
      fromName: action.fromName,
      fromIsin: action.fromIsin,
      toSymbol: action.toSymbol,
      toName: action.toName,
      toIsin: action.toIsin,
      ratioFrom: action.ratioFrom,
      ratioTo: action.ratioTo,
      effectiveDate: action.effectiveDate,
      recordDate: action.recordDate ?? '',
      notes: action.notes,
      sourceUrl: action.sourceUrl,
    };
    this.showForm.set(true);
    this.success.set(null);
    this.error.set(null);
  }

  cancelForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
    this.form = this.emptyForm();
  }

  async save(): Promise<void> {
    if (!this.form.fromSymbol.trim() || !this.form.toSymbol.trim() || !this.form.effectiveDate) {
      this.error.set('From symbol, to symbol, and effective date are required');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.svc.upsert(this.form, this.editingId() ?? undefined);
      this.success.set(this.editingId() ? 'Corporate action updated' : 'Corporate action added');
      this.cancelForm();
      await this.reload();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Save failed');
    } finally {
      this.busy.set(false);
    }
  }

  async remove(action: CorporateAction): Promise<void> {
    if (!confirm(`Delete ${action.fromSymbol} → ${action.toSymbol}?`)) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.svc.remove(action.id);
      this.success.set('Corporate action deleted');
      await this.reload();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      this.busy.set(false);
    }
  }

  private emptyForm(): CorporateActionInput {
    return {
      actionType: 'merge',
      fromSymbol: '',
      fromName: '',
      fromIsin: '',
      toSymbol: '',
      toName: '',
      toIsin: '',
      ratioFrom: 1,
      ratioTo: 1,
      effectiveDate: '',
      recordDate: '',
      notes: '',
      sourceUrl: '',
    };
  }
}

import { Injectable, inject } from '@angular/core';
import {
  CorporateAction,
  CorporateActionInput,
  SEEDED_CORPORATE_ACTIONS,
} from '../models/corporate-action.models';
import { AuthService } from './auth.service';
import { objectToSnake, rowToCamel, rowsToCamel, SupabaseService } from './supabase.service';
import { normalizeIsin, normalizeSymbol } from '../utils/stock-identity.utils';

@Injectable({ providedIn: 'root' })
export class CorporateActionService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private cache: CorporateAction[] | null = null;
  private cacheUserId: string | null = null;

  clearCache(): void {
    this.cache = null;
    this.cacheUserId = null;
  }

  async listAll(): Promise<CorporateAction[]> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) return [];

    if (this.cache && this.cacheUserId === uid) return this.cache;

    const { data, error } = await this.supabase.client
      .from('corporate_actions')
      .select('*')
      .eq('user_id', uid)
      .order('effective_date', { ascending: false });

    if (error) {
      if (this.isMissingTable(error)) return [];
      throw error;
    }

    this.cache = rowsToCamel<CorporateAction>(data ?? []);
    this.cacheUserId = uid;
    return this.cache;
  }

  async getById(id: string): Promise<CorporateAction | null> {
    const all = await this.listAll();
    return all.find((a) => a.id === id) ?? null;
  }

  async upsert(input: CorporateActionInput, id?: string): Promise<CorporateAction> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to save corporate actions');

    const now = Date.now();
    const rowId = id || crypto.randomUUID();
    const existing = id ? await this.getById(id) : null;
    const action: CorporateAction = {
      id: rowId,
      userId: uid,
      actionType: input.actionType,
      fromSymbol: normalizeSymbol(input.fromSymbol),
      fromName: (input.fromName ?? '').trim(),
      fromIsin: normalizeIsin(input.fromIsin ?? ''),
      toSymbol: normalizeSymbol(input.toSymbol),
      toName: (input.toName ?? '').trim(),
      toIsin: normalizeIsin(input.toIsin ?? ''),
      ratioFrom: Number(input.ratioFrom) > 0 ? Number(input.ratioFrom) : 1,
      ratioTo: Number(input.ratioTo) > 0 ? Number(input.ratioTo) : 1,
      effectiveDate: input.effectiveDate,
      recordDate: input.recordDate || null,
      notes: (input.notes ?? '').trim(),
      sourceUrl: (input.sourceUrl ?? '').trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const { error } = await this.supabase.client
      .from('corporate_actions')
      .upsert(objectToSnake({ ...action, userId: uid }));
    if (error) throw error;

    this.clearCache();
    return action;
  }

  async remove(id: string): Promise<void> {
    await this.auth.whenReady();
    const uid = await this.auth.getDataUserId();
    if (!uid) throw new Error('Sign in to delete corporate actions');

    const { error } = await this.supabase.client
      .from('corporate_actions')
      .delete()
      .eq('user_id', uid)
      .eq('id', id);
    if (error) throw error;
    this.clearCache();
  }

  /** Ensure Mindtree + TV18 seeds exist (idempotent by from→to symbol pair). */
  async ensureSeeded(): Promise<CorporateAction[]> {
    const existing = await this.listAll();
    const byPair = new Map<string, CorporateAction>(
      existing.map((a) => [`${normalizeSymbol(a.fromSymbol)}->${normalizeSymbol(a.toSymbol)}`, a])
    );
    for (const seed of SEEDED_CORPORATE_ACTIONS) {
      const key = `${normalizeSymbol(seed.fromSymbol)}->${normalizeSymbol(seed.toSymbol)}`;
      const current = byPair.get(key);
      if (current) {
        const needsIsin =
          (!normalizeIsin(current.fromIsin) && !!normalizeIsin(seed.fromIsin)) ||
          (!normalizeIsin(current.toIsin) && !!normalizeIsin(seed.toIsin));
        if (!needsIsin) continue;
        await this.upsert(
          {
            actionType: seed.actionType,
            fromSymbol: seed.fromSymbol,
            fromName: seed.fromName || current.fromName,
            fromIsin: seed.fromIsin || current.fromIsin,
            toSymbol: seed.toSymbol,
            toName: seed.toName || current.toName,
            toIsin: seed.toIsin || current.toIsin,
            ratioFrom: seed.ratioFrom,
            ratioTo: seed.ratioTo,
            effectiveDate: seed.effectiveDate,
            recordDate: seed.recordDate ?? undefined,
            notes: seed.notes || current.notes,
            sourceUrl: seed.sourceUrl || current.sourceUrl,
          },
          current.id
        );
        continue;
      }
      await this.upsert({
        actionType: seed.actionType,
        fromSymbol: seed.fromSymbol,
        fromName: seed.fromName,
        fromIsin: seed.fromIsin,
        toSymbol: seed.toSymbol,
        toName: seed.toName,
        toIsin: seed.toIsin,
        ratioFrom: seed.ratioFrom,
        ratioTo: seed.ratioTo,
        effectiveDate: seed.effectiveDate,
        recordDate: seed.recordDate ?? undefined,
        notes: seed.notes,
        sourceUrl: seed.sourceUrl,
      });
    }
    return this.listAll();
  }

  private isMissingTable(error: { message?: string; code?: string }): boolean {
    const message = (error.message ?? '').toLowerCase();
    return (
      error.code === 'PGRST205' ||
      error.code === '42P01' ||
      message.includes('corporate_actions') && message.includes('does not exist')
    );
  }
}

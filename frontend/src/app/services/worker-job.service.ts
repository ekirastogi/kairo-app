import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  doc,
  docData,
  getDoc,
  setDoc,
} from '@angular/fire/firestore';
import { map, Observable } from 'rxjs';
import { AuthService } from './auth.service';

export type WorkerJobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type WorkerJobType = 'hot_ingest' | 'symbol_ingest' | 'seed_universe' | 'fetch_history';

export interface WorkerJob {
  id: string;
  type: WorkerJobType;
  status: WorkerJobStatus;
  requestedBy: string;
  requestedAt: number;
  symbol?: string;
  startedAt?: number;
  completedAt?: number;
  symbolsIngested?: number;
  error?: string;
}

export interface WorkerStatus {
  status: string;
  lastSeen: number;
  service?: string;
}

const LOCAL_WORKER_URL = 'http://localhost:8080';
const WORKER_ONLINE_MS = 10 * 60 * 1000;
const LISTEN_WINDOW_MS = 15 * 60 * 1000;
const JOB_POLL_MS = 2000;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const LOCAL_FETCH_TIMEOUT_MS = 2000;

export interface WorkerListenState {
  active: boolean;
  until: number;
  requestedBy?: string;
  updatedAt?: number;
}

@Injectable({ providedIn: 'root' })
export class WorkerJobService {
  private firestore = inject(Firestore);
  private auth = inject(AuthService);
  private localJobs = new Map<string, WorkerJob>();

  /** Prefer local HTTP health — works when Firestore quota is exhausted. */
  async getWorkerOnline(): Promise<boolean> {
    if (await this.isLocalWorkerReachable()) return true;
    return this.getFirestoreWorkerOnline();
  }

  /** Live worker presence for detail views. */
  watchWorkerOnline(): Observable<boolean> {
    const ref = doc(this.firestore, 'worker', 'status');
    return docData(ref).pipe(
      map((data) => {
        const status = data as WorkerStatus | undefined;
        if (!status?.lastSeen) return false;
        return Date.now() - status.lastSeen < WORKER_ONLINE_MS;
      })
    );
  }

  /** Opens listen window in Firestore, or no-op when local worker is reachable. */
  async requestListenWindow(durationMs = LISTEN_WINDOW_MS): Promise<void> {
    if (await this.isLocalWorkerReachable()) return;

    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) throw new Error('Sign in to connect the worker');

    const now = Date.now();
    await setDoc(doc(this.firestore, 'worker', 'listen'), {
      active: true,
      until: now + durationMs,
      requestedBy: uid,
      updatedAt: now,
    });
  }

  async getListenState(): Promise<WorkerListenState | null> {
    if (await this.isLocalWorkerReachable()) {
      return {
        active: true,
        until: Date.now() + LISTEN_WINDOW_MS,
        updatedAt: Date.now(),
      };
    }
    try {
      const snap = await getDoc(doc(this.firestore, 'worker', 'listen'));
      if (!snap.exists()) return null;
      return snap.data() as WorkerListenState;
    } catch {
      return null;
    }
  }

  isListenActive(state: WorkerListenState | null | undefined): boolean {
    return !!state?.active && (state.until ?? 0) > Date.now();
  }

  async requestHotIngest(): Promise<string> {
    if (await this.isLocalWorkerReachable()) {
      return this.runLocalIngest('hot_ingest', '/api/v1/ingest/hot');
    }
    return this.requestJob('hot_ingest');
  }

  async requestSymbolIngest(symbol: string): Promise<string> {
    const sym = symbol.trim().toUpperCase();
    if (!sym) throw new Error('Symbol is required');
    if (await this.isLocalWorkerReachable()) {
      return this.runLocalIngest('symbol_ingest', `/api/v1/ingest/symbol/${encodeURIComponent(sym)}`, sym);
    }
    return this.requestJob('symbol_ingest', sym);
  }

  async requestFetchHistory(symbol: string): Promise<string> {
    const sym = symbol.trim().toUpperCase();
    if (!sym) throw new Error('Symbol is required');
    return this.requestJob('fetch_history', sym);
  }

  async requestSeedRegistry(): Promise<string> {
    if (await this.isLocalWorkerReachable()) {
      return this.runLocalIngest('seed_universe', '/api/v1/ingest/seed-registry');
    }
    return this.requestJob('seed_universe');
  }

  /** @deprecated Use requestSeedRegistry */
  async requestSeedUniverse(): Promise<string> {
    return this.requestSeedRegistry();
  }

  async backfillRegistryFromYahoo(
    onlyMissing = true,
    batchLimit = 200
  ): Promise<{ processed: number; updated: number; done: boolean }> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) throw new Error('Sign in to backfill registry');

    const online = await this.isLocalWorkerReachable();
    if (!online) {
      throw new Error('Worker is offline. Start it with `cd backend && go run .` then retry.');
    }

    let offset = 0;
    let processed = 0;
    let updated = 0;
    let done = false;

    while (!done) {
      const res = await fetch(`${LOCAL_WORKER_URL}/api/v1/registry/backfill-yahoo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
        body: JSON.stringify({ userId: uid, offset, limit: batchLimit, onlyMissing }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        processed?: number;
        updated?: number;
        done?: boolean;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `Yahoo backfill failed (${res.status})`);
      }
      processed += body.processed ?? 0;
      updated += body.updated ?? 0;
      done = !!body.done;
      if (!done) {
        offset += body.processed ?? batchLimit;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    return { processed, updated, done };
  }

  async waitForJob(jobId: string, timeoutMs = JOB_TIMEOUT_MS): Promise<WorkerJob> {
    const local = this.localJobs.get(jobId);
    if (local) {
      this.localJobs.delete(jobId);
      return local;
    }

    const ref = doc(this.firestore, 'workerJobs', jobId);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        throw new Error('Worker job not found');
      }
      const job = { id: snap.id, ...snap.data() } as WorkerJob;
      if (job.status === 'completed' || job.status === 'failed') {
        return job;
      }
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
    throw new Error('Timed out waiting for worker to finish ingest');
  }

  private async isLocalWorkerReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${LOCAL_WORKER_URL}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(LOCAL_FETCH_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async getFirestoreWorkerOnline(): Promise<boolean> {
    try {
      const ref = doc(this.firestore, 'worker', 'status');
      const snap = await getDoc(ref);
      const status = snap.data() as WorkerStatus | undefined;
      if (!status?.lastSeen) return false;
      return Date.now() - status.lastSeen < WORKER_ONLINE_MS;
    } catch {
      return false;
    }
  }

  private async runLocalIngest(
    type: WorkerJobType,
    path: string,
    symbol?: string
  ): Promise<string> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    const init: RequestInit = {
      method: 'POST',
      signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
    };
    if (type === 'seed_universe') {
      if (!uid) throw new Error('Sign in to import NSE/BSE symbols');
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify({ userId: uid });
    }
    const res = await fetch(`${LOCAL_WORKER_URL}${path}`, init);
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      symbolsIngested?: number;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Local worker request failed (${res.status})`);
    }

    const jobId = `local-${crypto.randomUUID()}`;
    const now = Date.now();
    const job: WorkerJob = {
      id: jobId,
      type,
      status: 'completed',
      requestedBy: 'local',
      requestedAt: now,
      completedAt: now,
      symbolsIngested: body.symbolsIngested ?? (type === 'symbol_ingest' ? 1 : 0),
      ...(symbol ? { symbol } : {}),
    };
    this.localJobs.set(jobId, job);
    return jobId;
  }

  private async requestJob(type: WorkerJobType, symbol?: string): Promise<string> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) throw new Error('Sign in to request market data ingest');

    await this.requestListenWindow();

    const jobId = crypto.randomUUID();
    const job: Omit<WorkerJob, 'id'> = {
      type,
      status: 'pending',
      requestedBy: uid,
      requestedAt: Date.now(),
      ...(symbol ? { symbol } : {}),
    };
    await setDoc(doc(this.firestore, 'workerJobs', jobId), job);
    return jobId;
  }
}

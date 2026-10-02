import { Injectable, inject, signal } from '@angular/core';
import { Firestore, doc, getDoc, setDoc, deleteField, updateDoc } from '@angular/fire/firestore';
import { AuthService } from './auth.service';
import { decryptSecret, encryptSecret, EncryptedSecret } from '../utils/secret-crypto.utils';

export type AiProviderId = 'cursor' | 'gemini' | 'claude';

interface UserConfigDoc {
  contractNotePasswordEnc?: EncryptedSecret | null;
  defaultCustomListId?: string | null;
  cursorApiKeyEnc?: EncryptedSecret | null;
  geminiApiKeyEnc?: EncryptedSecret | null;
  claudeApiKeyEnc?: EncryptedSecret | null;
  updatedAt?: number;
}

const AI_KEY_FIELDS: Record<AiProviderId, keyof UserConfigDoc> = {
  cursor: 'cursorApiKeyEnc',
  gemini: 'geminiApiKeyEnc',
  claude: 'claudeApiKeyEnc',
};

const AI_SESSION_PREFIX = 'kairo.aiKey.';

/**
 * Per-user config in Firestore (`userConfig/{uid}`).
 * Contract-note password is stored AES-GCM encrypted (key derived from uid).
 */
@Injectable({ providedIn: 'root' })
export class UserConfigService {
  private firestore = inject(Firestore);
  private auth = inject(AuthService);

  /** True when an encrypted password blob is present (not whether decrypt succeeded). */
  hasContractNotePassword = signal(false);
  readonly hasCursorApiKey = signal(false);
  readonly hasGeminiApiKey = signal(false);
  readonly hasClaudeApiKey = signal(false);
  private cache: string | null = null;
  private readonly aiKeySession = new Map<AiProviderId, string>();

  async refresh(): Promise<void> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) {
      this.hasContractNotePassword.set(false);
      this.hasCursorApiKey.set(false);
      this.hasGeminiApiKey.set(false);
      this.hasClaudeApiKey.set(false);
      this.cache = null;
      this.clearAiSession();
      return;
    }
    const snap = await getDoc(doc(this.firestore, 'userConfig', uid));
    const data = snap.data() as UserConfigDoc | undefined;
    this.hasContractNotePassword.set(!!data?.contractNotePasswordEnc?.ciphertext);
    this.hasCursorApiKey.set(!!data?.cursorApiKeyEnc?.ciphertext);
    this.hasGeminiApiKey.set(!!data?.geminiApiKeyEnc?.ciphertext);
    this.hasClaudeApiKey.set(!!data?.claudeApiKeyEnc?.ciphertext);
    this.cache = null;
  }

  async getContractNotePassword(): Promise<string | null> {
    if (this.cache) return this.cache;
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) return null;

    const snap = await getDoc(doc(this.firestore, 'userConfig', uid));
    const data = snap.data() as UserConfigDoc | undefined;
    const enc = data?.contractNotePasswordEnc;
    if (!enc?.ciphertext) {
      this.hasContractNotePassword.set(false);
      return null;
    }
    try {
      const plain = await decryptSecret(enc, uid);
      this.cache = plain;
      this.hasContractNotePassword.set(true);
      return plain;
    } catch {
      this.hasContractNotePassword.set(true);
      throw new Error('Could not decrypt the saved contract note password. Save it again.');
    }
  }

  async saveContractNotePassword(password: string): Promise<void> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) throw new Error('Sign in to save the contract note password');
    const trimmed = password.trim();
    if (!trimmed) throw new Error('Password cannot be empty');

    const enc = await encryptSecret(trimmed, uid);
    await setDoc(
      doc(this.firestore, 'userConfig', uid),
      {
        contractNotePasswordEnc: enc,
        updatedAt: Date.now(),
      } satisfies UserConfigDoc,
      { merge: true }
    );
    this.cache = trimmed;
    this.hasContractNotePassword.set(true);
  }

  async clearContractNotePassword(): Promise<void> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) throw new Error('Sign in to clear the contract note password');

    await updateDoc(doc(this.firestore, 'userConfig', uid), {
      contractNotePasswordEnc: deleteField(),
      updatedAt: Date.now(),
    }).catch(async () => {
      await setDoc(doc(this.firestore, 'userConfig', uid), { updatedAt: Date.now() }, { merge: true });
    });
    this.cache = null;
    this.hasContractNotePassword.set(false);
  }

  async getDefaultCustomListId(): Promise<string | null> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) return null;
    const snap = await getDoc(doc(this.firestore, 'userConfig', uid));
    const id = (snap.data() as UserConfigDoc | undefined)?.defaultCustomListId;
    return id ? String(id) : null;
  }

  async setDefaultCustomListId(id: string | null): Promise<void> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) return;
    const ref = doc(this.firestore, 'userConfig', uid);
    if (id) {
      await setDoc(
        ref,
        {
          defaultCustomListId: id,
          updatedAt: Date.now(),
        } satisfies Partial<UserConfigDoc>,
        { merge: true }
      );
      return;
    }
    await updateDoc(ref, {
      defaultCustomListId: deleteField(),
      updatedAt: Date.now(),
    }).catch(async () => {
      await setDoc(ref, { updatedAt: Date.now() }, { merge: true });
    });
  }

  hasAiKey(provider: AiProviderId): boolean {
    if (provider === 'cursor') return this.hasCursorApiKey();
    if (provider === 'gemini') return this.hasGeminiApiKey();
    return this.hasClaudeApiKey();
  }

  async saveAiApiKey(provider: AiProviderId, key: string): Promise<void> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) throw new Error('Sign in to save API keys');
    const trimmed = key.trim();
    if (!trimmed) throw new Error('API key cannot be empty');
    const enc = await encryptSecret(trimmed, uid);
    const field = AI_KEY_FIELDS[provider];
    await setDoc(
      doc(this.firestore, 'userConfig', uid),
      { [field]: enc, updatedAt: Date.now() } satisfies Partial<UserConfigDoc>,
      { merge: true }
    );
    this.setHasFlag(provider, true);
    this.rememberSessionKey(provider, trimmed);
  }

  async clearAiApiKey(provider: AiProviderId): Promise<void> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) throw new Error('Sign in to clear API keys');
    const field = AI_KEY_FIELDS[provider];
    const ref = doc(this.firestore, 'userConfig', uid);
    await updateDoc(ref, {
      [field]: deleteField(),
      updatedAt: Date.now(),
    }).catch(async () => {
      await setDoc(ref, { updatedAt: Date.now() }, { merge: true });
    });
    this.setHasFlag(provider, false);
    this.aiKeySession.delete(provider);
    this.clearSessionStorage(provider);
  }

  /** Decrypt from Firebase, then keep plaintext only for this browser session. */
  async getAiApiKey(provider: AiProviderId): Promise<string | null> {
    const cached = this.aiKeySession.get(provider) ?? this.readSessionStorage(provider);
    if (cached) {
      this.aiKeySession.set(provider, cached);
      return cached;
    }
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) return null;
    const snap = await getDoc(doc(this.firestore, 'userConfig', uid));
    const data = snap.data() as UserConfigDoc | undefined;
    const enc = data?.[AI_KEY_FIELDS[provider]] as EncryptedSecret | null | undefined;
    if (!enc?.ciphertext) {
      this.setHasFlag(provider, false);
      return null;
    }
    try {
      const plain = await decryptSecret(enc, uid);
      this.setHasFlag(provider, true);
      this.rememberSessionKey(provider, plain);
      return plain;
    } catch {
      this.setHasFlag(provider, true);
      throw new Error('Could not decrypt the saved API key. Save it again in Settings.');
    }
  }

  clearAiSession(): void {
    this.aiKeySession.clear();
    (['cursor', 'gemini', 'claude'] as AiProviderId[]).forEach((provider) => {
      this.clearSessionStorage(provider);
    });
  }

  private setHasFlag(provider: AiProviderId, value: boolean): void {
    if (provider === 'cursor') this.hasCursorApiKey.set(value);
    else if (provider === 'gemini') this.hasGeminiApiKey.set(value);
    else this.hasClaudeApiKey.set(value);
  }

  private rememberSessionKey(provider: AiProviderId, key: string): void {
    this.aiKeySession.set(provider, key);
    try {
      sessionStorage.setItem(AI_SESSION_PREFIX + provider, key);
    } catch {
      /* private mode */
    }
  }

  private readSessionStorage(provider: AiProviderId): string | null {
    try {
      return sessionStorage.getItem(AI_SESSION_PREFIX + provider);
    } catch {
      return null;
    }
  }

  private clearSessionStorage(provider: AiProviderId): void {
    try {
      sessionStorage.removeItem(AI_SESSION_PREFIX + provider);
    } catch {
      /* ignore */
    }
  }
}

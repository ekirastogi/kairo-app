import { Injectable, inject, signal } from '@angular/core';
import { Firestore, doc, getDoc, setDoc, deleteField, updateDoc } from '@angular/fire/firestore';
import { AuthService } from './auth.service';
import { decryptSecret, encryptSecret, EncryptedSecret } from '../utils/secret-crypto.utils';

interface UserConfigDoc {
  contractNotePasswordEnc?: EncryptedSecret | null;
  updatedAt?: number;
}

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
  private cache: string | null = null;

  async refresh(): Promise<void> {
    await this.auth.whenReady();
    const uid = this.auth.uid;
    if (!uid) {
      this.hasContractNotePassword.set(false);
      this.cache = null;
      return;
    }
    const snap = await getDoc(doc(this.firestore, 'userConfig', uid));
    const data = snap.data() as UserConfigDoc | undefined;
    this.hasContractNotePassword.set(!!data?.contractNotePasswordEnc?.ciphertext);
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
}

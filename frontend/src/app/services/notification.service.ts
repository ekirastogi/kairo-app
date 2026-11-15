import { Injectable, inject } from '@angular/core';
import { Firestore, doc, setDoc } from '@angular/fire/firestore';
import { getApp } from 'firebase/app';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { firebaseConfig } from '../../environments/firebase.config';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';

/** FCM + Notification API so TradeBook level hits reach laptop and the installed PWA. */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private firestore = inject(Firestore);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private started = false;

  async requestPermission(): Promise<void> {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    await this.enablePush();
  }

  async enablePush(): Promise<void> {
    if (this.started) return;
    if (!(await isSupported())) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const uid = this.auth.uid;
    if (!uid) return;
    const vapidKey = (firebaseConfig as { vapidKey?: string }).vapidKey;
    if (!vapidKey || vapidKey.startsWith('YOUR_')) return;
    try {
      const messaging = getMessaging(getApp());
      const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
      if (!token) return;
      await setDoc(doc(this.firestore, 'fcmTokens', token), {
        token,
        uid,
        updatedAt: Date.now(),
        userAgent: navigator.userAgent,
      });
      if (!this.started) {
        onMessage(messaging, (payload) => {
          const title = payload.notification?.title || 'Kairo';
          const body = payload.notification?.body || '';
          this.show(title, body);
          if (body) this.toast.success(`${title}: ${body}`);
        });
      }
      this.started = true;
    } catch {
      /* missing VAPID / SW is non-fatal */
    }
  }

  show(title: string, body: string): void {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  }
}

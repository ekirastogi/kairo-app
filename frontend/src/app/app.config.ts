import { APP_INITIALIZER, ApplicationConfig, ErrorHandler } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';
import { FirebaseOptions, initializeApp, provideFirebaseApp } from '@angular/fire/app';
import { provideAuth } from '@angular/fire/auth';
import { getFirestore, provideFirestore } from '@angular/fire/firestore';
import { getMessaging, provideMessaging } from '@angular/fire/messaging';
import { getApp } from 'firebase/app';
import {
  browserPopupRedirectResolver,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
} from 'firebase/auth';

import { routes } from './app.routes';
import { AppErrorHandler } from './services/app-error-handler.service';
import { AuthService } from './services/auth.service';
import { SupabaseService } from './services/supabase.service';

export function buildAppConfig(firebase: FirebaseOptions): ApplicationConfig {
  return {
    providers: [
      provideRouter(routes),
      provideAnimations(),
      provideFirebaseApp(() => initializeApp(firebase)),
      provideAuth(() => {
        const app = getApp();
        try {
          return initializeAuth(app, {
            persistence: indexedDBLocalPersistence,
            popupRedirectResolver: browserPopupRedirectResolver,
          });
        } catch {
          return getAuth(app);
        }
      }),
      provideFirestore(() => getFirestore()),
      provideMessaging(() => getMessaging()),
      AppErrorHandler,
      { provide: ErrorHandler, useExisting: AppErrorHandler },
      {
        provide: APP_INITIALIZER,
        useFactory:
          (supabase: SupabaseService, authService: AuthService, errors: AppErrorHandler) =>
          async () => {
            // A rejected APP_INITIALIZER aborts bootstrap and renders nothing at all, so
            // startup failures are recorded and the app is allowed to come up degraded.
            try {
              await supabase.whenReady();
              await authService.whenReady();
            } catch (e) {
              errors.handleError(e);
            }
          },
        deps: [SupabaseService, AuthService, AppErrorHandler],
        multi: true,
      },
    ],
  };
}

import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

/** Redirect legacy Portfolio routes into the unified Analytics hub. */
export function redirectToAnalytics(tab?: string): CanActivateFn {
  return () => {
    const router = inject(Router);
    const nav = router.getCurrentNavigation();
    const fromUrl = nav?.extractedUrl?.queryParams ?? {};
    const fromExtras = nav?.extras.queryParams ?? {};
    return router.createUrlTree(['/analytics'], {
      queryParams: {
        ...fromUrl,
        ...fromExtras,
        ...(tab ? { tab } : {}),
      },
    });
  };
}
